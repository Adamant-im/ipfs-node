import type { Application, RequestHandler, Router } from 'express'

export type ApiRouters = {
  file: Router
  /** File routes that make content durable or reclaim it. */
  fileAdminRouter: Router
  publicNodeRouter: Router
  node: Router
  helia: Router
  libp2p: Router
  debug: Router
  /** Storage report and policy, safe to expose next to the upload routes. */
  storage: Router
  /** Storage routes that reclaim space or move copies between nodes. */
  storageAdminRouter: Router
}

/**
 * Mount API routers at their documented public, administrative, or disabled
 * boundaries.
 *
 * @param app Express application receiving the routes
 * @param routers API routers without cross-cutting access middleware
 * @param adminAuth fail-closed administrative authentication middleware
 * @param enableDebugApi whether the authenticated debug API is mounted
 */
export function mountApiRoutes(
  app: Application,
  routers: ApiRouters,
  adminAuth: RequestHandler,
  enableDebugApi: boolean
): void {
  app.use('/api/file', routers.file)
  app.use('/api/file', adminAuth, routers.fileAdminRouter)

  app.use('/api/node', routers.publicNodeRouter)
  app.use('/api/node', adminAuth, routers.node)

  app.use('/api/storage', routers.storage)
  app.use('/api/storage', adminAuth, routers.storageAdminRouter)

  // Replication between nodes is not an HTTP route: it runs on the libp2p
  // protocol in `src/storage/replicationProtocol.ts`, where the handshake
  // already proves which peer is calling.

  app.use('/api/helia', adminAuth, routers.helia)
  app.use('/api/libp2p', adminAuth, routers.libp2p)

  if (enableDebugApi) {
    app.use('/api/debug', adminAuth, routers.debug)
  }
}
