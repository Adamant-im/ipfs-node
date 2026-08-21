import type { Application, RequestHandler, Router } from 'express'

export type ApiRouters = {
  file: Router
  node: Router
  helia: Router
  libp2p: Router
  debug: Router
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

  // Node health remains public while topology-sensitive information is admin-only.
  app.use('/api/node/info', adminAuth)
  app.use('/api/node', routers.node)

  app.use('/api/helia', adminAuth, routers.helia)
  app.use('/api/libp2p', adminAuth, routers.libp2p)

  if (enableDebugApi) {
    app.use('/api/debug', adminAuth, routers.debug)
  }
}
