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
  release: (cid: string) => Promise<FileRecord | undefined>
  log: UploadRouteLog
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

      // Hold all involved CIDs until this request either commits or restores
      // every pin and lifecycle record it changed. Sorting happens inside the
      // registry, so overlapping multi-file requests cannot deadlock.
      const records = await registry.withExclusiveCids(
        files.map((file) => file.cid.toString()),
        async (locked) => {
          const undo: Array<() => Promise<void>> = []

          try {
            const stored = []

            for (const file of files) {
              const cid = file.cid.toString()
              log.info(`Successfully added file ${cid}`)

              const previous = await locked.get(cid)
              const createdPin = await pinFile(node, file.cid)

              let registration
              try {
                registration = await locked.registerReplacing(
                  {
                    cid,
                    name: file.originalname,
                    fileSize: file.size,
                    storedBytes: file.storedBytes
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
                await rollbackUpload({
                  registry: locked,
                  cid,
                  previous,
                  createdPin,
                  unpin: async () => {
                    await unpinFile(node, file.cid)
                  }
                })
                throw err
              }

              undo.push(() =>
                rollbackUpload({
                  registry: locked,
                  cid,
                  previous: registration.previous,
                  createdPin,
                  unpin: async () => {
                    await unpinFile(node, file.cid)
                  }
                })
              )

              stored.push(registration.record)
            }

            // Every file is stored and pinned. Ownership passes from the
            // request session to the registry before any CID lock is released.
            session.commit()
            return stored
          } catch (err) {
            for (const step of undo.reverse()) {
              try {
                await step()
              } catch (undoError) {
                log.error(`Could not undo a failed upload: ${(undoError as Error).message}`)
              }
            }
            throw err
          }
        }
      )

      const durable = records.filter((record) => record.state === 'confirmed')
      const replication = await Promise.all(
        durable.map(async (record) => ({
          cid: record.cid,
          report: await dependencies.replicate(record.cid)
        }))
      )
      const replicationByCid = new Map(replication.map((item) => [item.cid, item.report]))

      if (
        dependencies.requireQuorumOnUpload &&
        replication.some((item) => !item.report.satisfied)
      ) {
        // The policy demands a quorum, so the upload is not durable. The files
        // are released instead of being kept as a copy nobody promised to hold.
        await Promise.all(durable.map((record) => dependencies.release(record.cid)))

        return res.status(503).send({ error: 'Replication quorum not reached' })
      }

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
