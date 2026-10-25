const { Router } = require('express');

/**
 * Subscription status + plans. These routes are intentionally NOT gated by entitlement —
 * an unentitled user must still be able to see their status and reach the upgrade page.
 */
function createSubscriptionRouter(subscriptionService) {
  const router = Router();

  // GET /subscription/status/:locationId
  router.get('/status/:locationId', async (req, res) => {
    try {
      const status = await subscriptionService.getStatus(req.params.locationId);
      res.json({ success: true, data: status });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /subscription/plans/:locationId
  router.get('/plans/:locationId', async (req, res) => {
    try {
      const plans = await subscriptionService.listPlans(req.params.locationId);
      res.json({ success: true, data: plans });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = { createSubscriptionRouter };
