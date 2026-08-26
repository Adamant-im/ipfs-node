import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { IpfsNode } from '../ipfs-node.js'
import { pinFile, unpinFile } from '../storage/pinning.js'
import type { FileRecord, FileRegistry } from '../storage/registry.js'
import type { ReplicationReport } from '../storage/replication.js'
import { rollbackUpload } from '../storage/rollback.js'
import type { UploadSession } from '../storage/uploadSession.js'
import { UnixFsMulterFile } from '../utils/types.js'
import { flatFiles } from '../utils/utils.js'

interface UploadRouteLog {
  info(message: string): void
  error(message: string): void
}

export interface UploadRouteDependencies {
  node: IpfsNode
  registry: FileRegistry
  /** Session that owns the blocks this request wrote. */
  getSession: (req: Request) => UploadSession
  /** Whether an upload stays temporary until an authorized confirmation. */
  confirmationRequired: boolean
  /** Lifetime of an unconfirmed upload before it becomes reclaimable. */
  temporaryTtlMs: number
  /** Whether an upload that missed its quorum is refused rather than kept. */
  requireQuorumOnUpload: boolean
  /** Prepare remote copies when `transactionId` is present. */
  replicate: (cid: string, transactionId?: string) => Promise<ReplicationReport>
  /** Make prepared copies permanent after the local decision commits. */
  commitReplicas: (cid: string, transactionId: string, report: ReplicationReport) => Promise<void>
  /** Withdraw prepared copies before reporting a strict rejection. */
  abortReplicas: (cid: string, transactionId: string, report: ReplicationReport) => Promise<void>
  /** Test seam for pin-datastore failure paths. */
  unpin?: (cid: UnixFsMulterFile['cid']) => Promise<void>
  log: UploadRouteLog
}

interface UploadBaseline {
  cid: string
  /** The record the CID had before this request, when it had one. */
  previous?: FileRecord
  /** Whether this request created the pin. */
  createdPin: boolean
  unpin: () => Promise<void>
}

/**
 * Undo an admitted request whose quorum was refused afterwards.
 *
 * The ordered CID set is taken again because the locks were released for the
 * network work. Only records still carrying this request's ownership token are
 * rolled back; anything a later lifecycle adopted is left alone.
 */
async function rollbackAdmitted(
  registry: FileRegistry,
  baselines: UploadBaseline[],
  admissionId: string,
  log: UploadRouteLog
): Promise<void> {
  const failures: Error[] = []

  await registry.withExclusiveCids(
    baselines.map((baseline) => baseline.cid),
    async (locked) => {
      for (const baseline of [...baselines].reverse()) {
        try {
          await rollbackUpload({
            registry: locked,
            cid: baseline.cid,
            previous: baseline.previous,
            admissionId,
            createdPin: baseline.createdPin,
            unpin: baseline.unpin
          })
        } catch (err) {
          const failure = err as Error
          failures.push(failure)
          log.error(`Could not undo a refused upload: ${failure.message}`)
        }
      }
    }
  )

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Could not fully undo the refused upload')
  }
}

/**
 * Commit every local record as one guarded decision after network placement.
 *
 * Replica metadata is written first while the admission token is retained on
 * every CID. If any write fails, every record can still be compensated under
 * the same set of locks. Clearing the internal tokens afterwards is best effort:
 * the durable upload decision has already been made, and a cleanup write must
 * not turn an accepted upload into an ambiguous failure.
 */
async function finalizeAdmitted(
  registry: FileRegistry,
  records: FileRecord[],
  baselines: UploadBaseline[],
  reports: Map<string, ReplicationReport>,
  admissionId: string,
  log: UploadRouteLog
): Promise<Map<string, FileRecord>> {
  const byCid = new Map(records.map((record) => [record.cid, record]))

  return registry.withExclusiveCids(byCid.keys(), async (locked) => {
    const currentByCid = new Map<string, FileRecord>()

    for (const [cid] of byCid) {
      const current = await locked.get(cid)

      if (current === undefined || current.admissionId !== admissionId) {
        throw new Error(`Upload lifecycle changed before commit for ${cid}`)
      }

      currentByCid.set(cid, current)
    }

    const finalized = new Map<string, FileRecord>()

    try {
      for (const [cid, current] of currentByCid) {
        const report = reports.get(cid)
        const stored = await locked.save({
          ...current,
          replicas: report?.mode === 'quorum' ? report.replicas : current.replicas
        })
        finalized.set(cid, stored)
      }
    } catch (err) {
      const failures: unknown[] = [err]

      for (const baseline of [...baselines].reverse()) {
        try {
          await rollbackUpload({
            registry: locked,
            cid: baseline.cid,
            previous: baseline.previous,
            admissionId,
            createdPin: baseline.createdPin,
            unpin: baseline.unpin
          })
        } catch (rollbackError) {
          failures.push(rollbackError)
        }
      }

      throw new AggregateError(failures, 'Could not finalize or restore the local upload', {
        cause: err
      })
    }

    for (const [cid, stored] of finalized) {
      try {
        finalized.set(cid, await locked.save({ ...stored, admissionId: undefined }))
      } catch (err) {
        log.error(`Could not clear settled upload ownership for ${cid}: ${(err as Error).message}`)
      }
    }

    return finalized
  })
}

/**
 * Build the handler that turns imported parts into durable, registered files.
 *
 * The parts are already in the blockstore by the time this runs — the multipart
 * parser wrote them through the request session — and they are unpinned until
 * this handler pins them. That is why it takes what it works on rather than
 * importing the node this process happens to have started: the window between
 * import and pin is the one thing about uploads worth testing end to end, and a
 * handler bound to singletons cannot be driven by a test at all.
 */
export function createUploadHandler(dependencies: UploadRouteDependencies): RequestHandler {
  const { node, registry, log } = dependencies

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!Array.isArray(req.files) || req.files.length === 0) {
      res.statusCode = 400
      return res.send({ error: 'No file uploaded' })
    }

    const session = dependencies.getSession(req)
    const admissionId = randomUUID()

    try {
      const files = flatFiles(req.files as UnixFsMulterFile[])
      log.info(`req.files: ${JSON.stringify(files.map((item) => item.originalname))}`)

      // Hold every CID this request touches while its pin and its record are
      // written, and no longer than that. Sorting happens inside the registry,
      // so overlapping multi-file requests cannot deadlock.
      const admitted = await registry.withExclusiveCids(
        files.map((file) => file.cid.toString()),
        async (locked) => {
          const baselines = new Map<string, UploadBaseline>()

          const restoreBaselines = async (): Promise<void> => {
            const failures: Error[] = []

            for (const baseline of [...baselines.values()].reverse()) {
              try {
                await rollbackUpload({
                  registry: locked,
                  cid: baseline.cid,
                  previous: baseline.previous,
                  createdPin: baseline.createdPin,
                  unpin: () => baseline.unpin()
                })
              } catch (err) {
                const failure = err as Error
                failures.push(failure)
                log.error(`Could not undo a failed upload: ${failure.message}`)
              }
            }

            if (failures.length > 0) {
              throw new AggregateError(failures, 'Could not fully restore the upload baseline')
            }
          }

          try {
            const stored: FileRecord[] = []

            for (const file of files) {
              const cid = file.cid.toString()
              log.info(`Successfully added file ${cid}`)

              const unpin = async (): Promise<void> => {
                if (dependencies.unpin !== undefined) {
                  await dependencies.unpin(file.cid)
                } else {
                  await unpinFile(node, file.cid)
                }
              }
              const previous = await locked.get(cid)
              const createdPin = await pinFile(node, file.cid)

              let registration
              try {
                registration = await locked.registerReplacing(
                  {
                    cid,
                    name: file.originalname,
                    fileSize: file.size,
                    storedBytes: file.storedBytes,
                    protectedBytes: file.protectedBytes
                  },
                  {
                    confirmationRequired: dependencies.confirmationRequired,
                    temporaryTtlMs: dependencies.temporaryTtlMs,
                    admissionId
                  }
                )
              } catch (err) {
                // A datastore failure can happen before or after it touches the
                // key. Restore both sides from the baseline captured under the
                // same CID lock, so neither outcome leaks a pin or a record.
                await rollbackUpload({ registry: locked, cid, previous, createdPin, unpin })
                throw err
              }

              if (!baselines.has(cid)) {
                baselines.set(cid, { cid, previous, createdPin, unpin })
              }
              stored.push(registration.record)
            }

            // Every file is stored, pinned and registered, so nothing this
            // request wrote is unprotected any more. Ownership passes from the
            // session to the registry here rather than after replication: the
            // session holds the shared storage lease, and keeping it across a
            // network round would stop collection — and, behind it, every other
            // upload — for as long as the slowest peer takes to answer.
            session.commit()

            return { records: stored, baselines: [...baselines.values()] }
          } catch (err) {
            let failure = err as Error

            try {
              await restoreBaselines()
            } catch (rollbackError) {
              failure = new AggregateError(
                [failure, rollbackError as Error],
                'Upload failed and its previous lifecycle could not be fully restored'
              )
            }

            await session.cleanup()
            throw failure
          }
        }
      )

      // One request may contain the same content more than once. Place each CID
      // once, using the registration that stored it last.
      const durableByCid = new Map(
        admitted.records
          .filter((record) => record.state === 'confirmed')
          .map((record) => [record.cid, record] as const)
      )

      let replication
      try {
        replication = await Promise.all(
          [...durableByCid.values()].map(async (record) => ({
            cid: record.cid,
            report: await dependencies.replicate(
              record.cid,
              dependencies.requireQuorumOnUpload ? admissionId : undefined
            )
          }))
        )
      } catch (err) {
        // Placement reports failures rather than throwing, so this is something
        // unforeseen. The request is undone rather than half-kept: the caller is
        // told it failed, and nothing durable is left claiming otherwise.
        try {
          await rollbackAdmitted(registry, admitted.baselines, admissionId, log)
        } catch (rollbackError) {
          throw new AggregateError(
            [err, rollbackError],
            'Replication failed and the upload could not be fully restored',
            { cause: rollbackError }
          )
        }
        throw err
      }

      const outcome = {
        records: admitted.records,
        replication,
        quorumReached:
          !dependencies.requireQuorumOnUpload || replication.every((item) => item.report.satisfied)
      }

      if (!outcome.quorumReached) {
        // The request is rejected as a transaction. Restoring the exact
        // pre-request records and pins keeps a durable re-upload durable
        // instead of turning it into an expired, unpinned file, and leaves a
        // brand-new one with neither record nor pin.
        //
        // The blocks stay on disk, unprotected, until the collector runs. That
        // is what releasing means everywhere else here, and it is the price of
        // not holding the storage lease across replication.
        const rollbackFailures: unknown[] = []

        for (const item of replication) {
          try {
            await dependencies.abortReplicas(item.cid, admissionId, item.report)
          } catch (err) {
            rollbackFailures.push(err)
            log.error(
              `Could not abort prepared replicas for ${item.cid}: ${(err as Error).message}`
            )
          }
        }

        try {
          await rollbackAdmitted(registry, admitted.baselines, admissionId, log)
        } catch (err) {
          rollbackFailures.push(err)
        }

        if (rollbackFailures.length > 0) {
          throw new AggregateError(
            rollbackFailures,
            'Replication quorum was missed and rollback was incomplete'
          )
        }

        return res.status(503).send({ error: 'Replication quorum not reached' })
      }

      // Commit the local decision before making prepared remote copies
      // permanent. A lifecycle that changed during placement rejects the whole
      // request instead of counting a local copy that no longer exists.
      const reportByCid = new Map(replication.map((item) => [item.cid, item.report]))
      let finalized: Map<string, FileRecord>

      try {
        finalized = await finalizeAdmitted(
          registry,
          admitted.records,
          admitted.baselines,
          reportByCid,
          admissionId,
          log
        )
      } catch (err) {
        const failures: unknown[] = [err]

        for (const item of replication) {
          try {
            await dependencies.abortReplicas(item.cid, admissionId, item.report)
          } catch (abortError) {
            failures.push(abortError)
          }
        }

        try {
          await rollbackAdmitted(registry, admitted.baselines, admissionId, log)
        } catch (rollbackError) {
          failures.push(rollbackError)
        }

        throw new AggregateError(failures, 'Upload decision could not be committed or restored', {
          cause: err
        })
      }

      if (dependencies.requireQuorumOnUpload) {
        for (const item of replication) {
          try {
            await dependencies.commitReplicas(item.cid, admissionId, item.report)
          } catch (err) {
            // The local decision is already durable. A prepared remote copy is
            // pinned until its TTL, and repair promotes it with permanent store.
            log.error(
              `Could not commit prepared replicas for ${item.cid}: ${(err as Error).message}`
            )
          }
        }
      }

      const records = outcome.records.map((record) => finalized.get(record.cid) ?? record)
      const replicationByCid = new Map(replication.map((item) => [item.cid, item.report]))

      res.send({
        filesNames: files.map((file) => file.originalname),
        cids: records.map((record) => record.cid),
        files: records.map((record) => ({
          cid: record.cid,
          name: record.name,
          state: record.state,
          expiresAt: record.expiresAt,
          // Placement is decided per CID, so one file of a request can meet its
          // quorum while another does not, on different peers.
          replication: replicationByCid.get(record.cid) ?? null
        })),
        // The first file's report, kept for clients written against it. New
        // ones should read the per-file field above.
        replication: replication[0]?.report ?? null
      })
    } catch (err) {
      next(err)
    }
  }
}
