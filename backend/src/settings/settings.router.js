const { Router } = require('express');

/**
 * v2 SETTINGS router. In v1 this held the bot connect/disconnect + phone auth routes;
 * those now live under /connections (multi-connection). What remains here is the combined
 * status endpoint the UI loads on open: the location's connections (bots + phones) plus
 * its subscription/entitlement status, in one call.
 *
 * Behind the SSO middleware (identity + locationId match).
 */
function createSettingsRouter(connectionService, subscriptionService, ssoMiddleware) {
  const router = Router();

  router.use(ssoMiddleware);

  // GET /settings/:locationId → { connections, subscription }
  router.get('/:locationId', async (req, res) => {
    try {
      const [connections, subscription] = await Promise.all([
        connectionService.listConnections(req.params.locationId),
        subscriptionService.getStatus(req.params.locationId),
      ]);

      res.json({
        success: true,
        data: {
          connections,
          subscription,
          // Convenience flags for the UI.
          botCount: connections.bots.filter((b) => b.isActive).length,
          phoneCount: connections.phones.filter((p) => p.isActive).length,
          connected: connections.bots.some((b) => b.isActive) || connections.phones.some((p) => p.isActive),
        },
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
