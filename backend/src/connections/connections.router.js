const { Router } = require('express');
const rateLimit = require('express-rate-limit');

/**
 * v2 MULTI-CONNECTION management API. Replaces v1's /settings connect/disconnect routes.
 * Lists bots + phones for a location and lets the UI connect/disconnect each. Plan limits
 * (402 BOT_LIMIT / PHONE_LIMIT / SUBSCRIPTION_REQUIRED) are enforced inside the service.
 *
 * All routes are behind the SSO middleware (identity + locationId match).
 */
function createConnectionsRouter(connectionService, gramJsService, ssoMiddleware) {
  const router = Router();

  router.use(ssoMiddleware);

  // Per-location rate limiter for phone auth (code requests).
  const phoneAuthLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 3,
    keyGenerator: (req) => req.params.locationId,
    message: { error: 'Too many code requests. Please wait before trying again.' },
  });

  function sendError(res, error) {
    const status = error.statusCode || 500;
    const body = { success: false, error: error.message };
    if (error.code) body.code = error.code;
    if (error.details) body.details = error.details;
    res.status(status).json(body);
  }

  // GET /connections/:locationId → { bots:[...], phones:[...] }
  router.get('/:locationId', async (req, res) => {
    try {
      const data = await connectionService.listConnections(req.params.locationId);
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ── Bots ─────────────────────────────────────────────

  // POST /connections/:locationId/bot { botToken, label? }
  router.post('/:locationId/bot', async (req, res) => {
    const { botToken, label } = req.body;
    if (!botToken || typeof botToken !== 'string') {
      return res.status(400).json({ success: false, error: 'botToken is required and must be a string' });
    }
    try {
      const result = await connectionService.connectBot(req.params.locationId, botToken.trim(), label || '');
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  // DELETE /connections/:locationId/bot/:botId
  router.delete('/:locationId/bot/:botId', async (req, res) => {
    try {
      const result = await connectionService.disconnectBot(req.params.locationId, req.params.botId);
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  // ── Phones ───────────────────────────────────────────

  // POST /connections/:locationId/phone/send-code { phoneNumber, confirmTransfer? }
  router.post('/:locationId/phone/send-code', phoneAuthLimiter, async (req, res) => {
    const { phoneNumber, confirmTransfer } = req.body;
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return res.status(400).json({ success: false, error: 'phoneNumber is required and must be a string' });
    }
    if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber.trim())) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format. Use international format: +1234567890',
      });
    }
    try {
      // Enforce the plan phone limit BEFORE starting the auth flow (throws 402).
      await connectionService.ensurePhoneSlotAvailable(req.params.locationId);
      const result = await gramJsService.sendCode(
        req.params.locationId,
        phoneNumber.trim(),
        { confirmTransfer: !!confirmTransfer },
      );
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /connections/:locationId/phone/verify-code { phoneCode }
  router.post('/:locationId/phone/verify-code', async (req, res) => {
    const { phoneCode } = req.body;
    if (!phoneCode || typeof phoneCode !== 'string') {
      return res.status(400).json({ success: false, error: 'phoneCode is required and must be a string' });
    }
    try {
      const result = await gramJsService.verifyCode(req.params.locationId, phoneCode.trim());
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST /connections/:locationId/phone/submit-2fa { password }
  router.post('/:locationId/phone/submit-2fa', async (req, res) => {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'password is required and must be a string' });
    }
    try {
      const result = await gramJsService.submit2FA(req.params.locationId, password);
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  // DELETE /connections/:locationId/phone/:phoneId
  router.delete('/:locationId/phone/:phoneId', async (req, res) => {
    try {
      const result = await connectionService.disconnectPhone(req.params.locationId, req.params.phoneId);
      res.json({ success: true, data: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

module.exports = { createConnectionsRouter };
