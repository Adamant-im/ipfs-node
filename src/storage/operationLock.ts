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

  /** Take a shared lease for an upload, copy, or pin operation. */
  acquireShared(): Promise<StorageOperationLease> {
    if (!this.writer && this.waiters.length === 0) {
      this.readers += 1
      return Promise.resolve(this.lease('shared'))
    }

    return new Promise((resolve) => this.waiters.push({ mode: 'shared', resolve }))
  }

  /** Take the exclusive lease used by one complete collection pass. */
  acquireExclusive(): Promise<StorageOperationLease> {
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
      return await work()
    } finally {
      lease.release()
    }
  }

  /** Run one complete collection operation under the exclusive lease. */
  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    const lease = await this.acquireExclusive()
    try {
      return await work()
    } finally {
      lease.release()
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
