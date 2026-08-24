import { CID } from 'multiformats/cid'
import type { UnixFS } from '@helia/unixfs'
import type { IpfsNode } from '../ipfs-node.js'
import type { FileRegistry } from './registry.js'

export interface BackfillReport {
  /** Direct pins found on the node. */
  pins: number
  /** Pins that gained a registry entry in this pass. */
  registered: number
  /** Pins already known to the registry. */
  known: number
  /**
   * Pins whose content is not fully present locally.
   *
   * They keep their pin and stay protected, but calling them confirmed would
   * claim more than the node can serve, so they are left alone.
   */
  incomplete: number
  errors: string[]
}

export interface BackfillOptions {
  node: IpfsNode
  unixfs: UnixFS
  registry: FileRegistry
  log?: (message: string) => void
}

/**
 * Give existing pins a place in the lifecycle registry.
 *
 * A node upgraded to this release already has a pinset, and an empty
 * `/adm/files`. Those files keep working — Helia pins protect them and the
 * collector only ever selects registry entries — but nothing else sees them:
 * they are missing from `GET /api/file/:cid/status`, from the storage report,
 * from a dry run's retained list, and from replication repair. In other words
 * the new guarantees would quietly apply to new uploads only.
 *
 * This walks the pinset once and records what is missing, as `confirmed`, which
 * is what a pinned file is. It is idempotent: a pin already in the registry is
 * left exactly as it is, so running it again after a restart changes nothing.
 */
export async function backfillRegistryFromPins(options: BackfillOptions): Promise<BackfillReport> {
  const log = options.log ?? ((): void => {})
  const report: BackfillReport = { pins: 0, registered: 0, known: 0, incomplete: 0, errors: [] }
  const now = Date.now()

  for await (const pin of options.node.pins.ls()) {
    report.pins += 1
    const cid = pin.cid.toString()

    try {
      if (await options.registry.get(cid)) {
        report.known += 1
        continue
      }

      // Offline on purpose: a pin whose blocks are not all here must not send
      // the node looking for them on the network at startup.
      const stats = await options.unixfs.stat(CID.parse(cid), { extended: true, offline: true })

      await options.registry.save({
        cid,
        // Nothing recorded the original name, and inventing one would be worse
        // than admitting it is unknown.
        name: cid,
        state: 'confirmed',
        // The upload happened before this release; its time is not recoverable,
        // so the file counts as new and is placed as widely as a fresh one.
        createdAt: now,
        expiresAt: null,
        confirmedAt: now,
        fileSize: Number(stats.size),
        storedBytes: Number(stats.deduplicatedDagSize),
        pinned: true,
        heldLocally: true,
        replicas: []
      })

      report.registered += 1
    } catch {
      report.incomplete += 1
    }
  }

  if (report.registered > 0 || report.incomplete > 0) {
    log(
      `Registry backfill: ${report.registered} pins recorded, ${report.known} already known, ` +
        `${report.incomplete} skipped as incomplete`
    )
  }

  return report
}
