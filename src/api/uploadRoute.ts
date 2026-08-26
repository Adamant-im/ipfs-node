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
  replicate: (cid: string) => Promise<ReplicationReport>
  log: UploadRouteLog
}

interface UploadBaseline {
  cid: string
  /** The record the CID had before this request, when it had one. */
  previous?: FileRecord
  /** Whether this request created the pin. */
  createdPin: boolean
  /** The record this request stored. */
  written: FileRecord
  unpin: () => Promise<void>
}

/**
 * Undo an admitted request whose quorum was refused afterwards.
 *
 * Each CID is taken again on its own, because the locks were released for the
 * network work. Only a record still carrying this request's write is rolled
 * back; anything written since belongs to somebody else.
 */
async function rollbackAdmitted(
  registry: FileRegistry,
  baselines: UploadBaseline[],
  log: UploadRouteLog
): Promise<void> {
  for (const baseline of [...baselines].reverse()) {
    try {
      await registry.withExclusiveCids([baseline.cid], (locked) =>
        rollbackUpload({
          registry: locked,
          cid: baseline.cid,
          previous: baseline.previous,
          written: baseline.written,
          createdPin: baseline.createdPin,
          unpin: () => baseline.unpin()
        })
      )
    } catch (err) {
      log.error(`Could not undo a refused upload: ${(err as Error).message}`)
    }
  }
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

    try {
      const files = flatFiles(req.files as UnixFsMulterFile[])
      log.info(`req.files: ${JSON.stringify(files.map((item) => item.originalname))}`)

      // Hold every CID this request touches while its pin and its record are
      // written, and no longer than that. Sorting happens inside the registry,
      // so overlapping multi-file requests cannot deadlock.
      const admitted = await registry.withExclusiveCids(
        files.map((file) => file.cid.toString()),
        async (locked) => {
          const baselines: UploadBaseline[] = []

          const restoreBaselines = async (): Promise<void> => {
            const failures: Error[] = []

            while (baselines.length > 0) {
              const baseline = baselines.pop()

              if (baseline === undefined) {
                continue
              }

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
                await unpinFile(node, file.cid)
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
                    temporaryTtlMs: dependencies.temporaryTtlMs
                  }
                )
              } catch (err) {
                // A datastore failure can happen before or after it touches the
                // key. Restore both sides from the baseline captured under the
                // same CID lock, so neither outcome leaks a pin or a record.
                await rollbackUpload({ registry: locked, cid, previous, createdPin, unpin })
                throw err
              }

              baselines.push({
                cid,
                previous,
                createdPin,
                written: registration.record,
                unpin
              })
              stored.push(registration.record)
            }

            // Every file is stored, pinned and registered, so nothing this
            // request wrote is unprotected any more. Ownership passes from the
            // session to the registry here rather than after replication: the
            // session holds the shared storage lease, and keeping it across a
            // network round would stop collection — and, behind it, every other
            // upload — for as long as the slowest peer takes to answer.
            session.commit()

            return { records: stored, baselines }
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
            report: await dependencies.replicate(record.cid)
          }))
        )
      } catch (err) {
        // Placement reports failures rather than throwing, so this is something
        // unforeseen. The request is undone rather than half-kept: the caller is
        // told it failed, and nothing durable is left claiming otherwise.
        await rollbackAdmitted(registry, admitted.baselines, log)
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
        await rollbackAdmitted(registry, admitted.baselines, log)

        return res.status(503).send({ error: 'Replication quorum not reached' })
      }

      // Acknowledgements are written after the network work, each under its own
      // CID lock and only while the record is still the one this request wrote.
      // A late report must not overwrite a lifecycle somebody else has since
      // changed.
      const finalized = new Map<string, FileRecord>()
      for (const item of replication) {
        const written = durableByCid.get(item.cid)

        if (written === undefined || item.report.mode !== 'quorum') {
          continue
        }

        const updated = await registry.transition(item.cid, async (current) => {
          if (current === undefined || current.revision !== written.revision) {
            return 'keep'
          }

          return { ...current, replicas: item.report.replicas }
        })

        if (updated !== undefined) {
          finalized.set(item.cid, updated)
        }
      }

      if (!outcome.quorumReached) {
        return res.status(503).send({ error: 'Replication quorum not reached' })
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
