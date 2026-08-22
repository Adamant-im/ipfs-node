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
  /** Peer-to-peer replication intake. */
  replication: Router
}

/**
 * Mount API routers at their documented public, administrative, or disabled
 * boundaries.
 *
 * @param app Express application receiving the routes
 * @param routers API routers without cross-cutting access middleware
 * @param adminAuth fail-closed administrative authentication middleware
 * @param enableDebugApi whether the authenticated debug API is mounted
 * @param replicationAuth fail-closed peer authentication for replication intake
 */
export function mountApiRoutes(
  app: Application,
  routers: ApiRouters,
  adminAuth: RequestHandler,
  enableDebugApi: boolean,
  replicationAuth: RequestHandler
): void {
  app.use('/api/file', routers.file)
  app.use('/api/file', adminAuth, routers.fileAdminRouter)

  app.use('/api/node', routers.publicNodeRouter)
  app.use('/api/node', adminAuth, routers.node)

  app.use('/api/storage', routers.storage)
  app.use('/api/storage', adminAuth, routers.storageAdminRouter)

  // Peers authenticate with the shared replication token rather than the
  // administrative key: storing a copy is all a peer may ask this node to do.
  app.use('/api/replication', replicationAuth, routers.replication)

  app.use('/api/helia', adminAuth, routers.helia)
  app.use('/api/libp2p', adminAuth, routers.libp2p)

  if (enableDebugApi) {
    app.use('/api/debug', adminAuth, routers.debug)
  }
}
