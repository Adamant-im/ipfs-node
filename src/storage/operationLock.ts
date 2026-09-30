import { AsyncLocalStorage } from 'node:async_hooks'

/** A held storage-operation lock. Calling `release` more than once is safe. */
export interface StorageOperationLease {
  release(): void
}

type Waiter = {
  mode: 'shared' | 'exclusive'
  resolve: (lease: StorageOperationLease) => void
}

/**
 * Coordinates operations that build or protect DAGs with garbage collection.
 *
 * Helia serializes GC with one blockstore read or write at a time. A file import
 * spans many such writes, though, and its earlier blocks stay unpinned until the
 * whole DAG is imported. This process-level reader/writer lock extends the
 * critical section from intake through pin, registry commit, or cleanup.
 */
export class StorageOperationLock {
  private readers = 0
  private writer = false
  private readonly waiters: Waiter[] = []

  /**
   * The lease the currently running callback holds, when it took one.
   *
   * Taking a second lease while holding one is a deadlock, and a quiet one:
   * with a collector queued, a shared holder that asks for another shared lease
   * waits behind the collector, and the collector waits for the readers to
   * reach zero. Neither ever moves, and nothing is logged.
   *
   * There is no path that does this today. The guard exists so that the next
   * one fails loudly at the mistake instead of hanging the request.
   *
   * It covers work run through {@link withShared} and {@link withExclusive}. A
   * lease taken with {@link acquireShared} spans an HTTP request rather than a
   * callback, so no asynchronous context can carry it; that is why upload
   * admission holds one and this cannot see it.
   */
  private readonly held = new AsyncLocalStorage<Waiter['mode']>()

  /** Take a shared lease for an upload, copy, or pin operation. */
  acquireShared(): Promise<StorageOperationLease> {
    this.refuseReentry('shared')

    if (!this.writer && this.waiters.length === 0) {
      this.readers += 1
      return Promise.resolve(this.lease('shared'))
    }

    return new Promise((resolve) => this.waiters.push({ mode: 'shared', resolve }))
  }

  /** Take the exclusive lease used while Helia deletes unpinned blocks. */
  acquireExclusive(): Promise<StorageOperationLease> {
    this.refuseReentry('exclusive')

    if (!this.writer && this.readers === 0 && this.waiters.length === 0) {
      this.writer = true
      return Promise.resolve(this.lease('exclusive'))
    }

    return new Promise((resolve) => this.waiters.push({ mode: 'exclusive', resolve }))
  }

  /** Run one intake or pin operation under a shared lease. */
  async withShared<T>(work: () => Promise<T>): Promise<T> {
    const lease = await this.acquireShared()
    try {
      return await this.held.run('shared', work)
    } finally {
      lease.release()
    }
  }

  /** Run Helia block deletion under the exclusive lease. */
  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    const lease = await this.acquireExclusive()
    try {
      return await this.held.run('exclusive', work)
    } finally {
      lease.release()
    }
  }

  private refuseReentry(wanted: Waiter['mode']): void {
    const holding = this.held.getStore()

    if (holding !== undefined) {
      throw new Error(
        `Deadlock avoided: this operation already holds the ${holding} storage lease and ` +
          `asked for a ${wanted} one. Do the work inside the lease it already has.`
      )
    }
  }

  private lease(mode: Waiter['mode']): StorageOperationLease {
    let released = false

    return {
      release: (): void => {
        if (released) {
          return
        }
        released = true

        if (mode === 'shared') {
          this.readers = Math.max(0, this.readers - 1)
        } else {
          this.writer = false
        }

        this.drain()
      }
    }
  }

  /** Grant queued work fairly: a waiting collector blocks later readers. */
  private drain(): void {
    if (this.writer || this.readers > 0) {
      return
    }

    const first = this.waiters[0]
    if (first === undefined) {
      return
    }

    if (first.mode === 'exclusive') {
      this.waiters.shift()
      this.writer = true
      first.resolve(this.lease('exclusive'))
      return
    }

    while (this.waiters[0]?.mode === 'shared') {
      const reader = this.waiters.shift()
      if (reader === undefined) {
        return
      }
      this.readers += 1
      reader.resolve(this.lease('shared'))
    }
  }
}
