const { Router } = require('express');
const { toGhlActionMessage } = require('./action-errors');

/**
 * v2 WORKFLOWS ROUTER. All of v1's chargeFirst billing is removed (subscription model).
 * Instead, every ACTION route is gated by subscriptionService.ensureEntitled(locationId):
 * an unentitled location gets a clear failure (402 → surfaced to GHL as a failed step)
 * rather than silently running premium actions. Trigger-subscription registration and the
 * health check are NOT gated. Same 13 actions as v1.
 */
function createWorkflowsRouter(workflowsService, subscriptionService) {
  const router = Router();

  /**
   * Return a structured error to GHL with 400 so the workflow step shows as failed.
   * GHL displays the `message` field in the execution history, so we translate raw
   * Telegram/axios errors into clear, actionable guidance (toGhlActionMessage) instead
   * of leaking "Request failed with status code 400".
   */
  function actionError(res, error) {
    const message = toGhlActionMessage(error);
    return res.status(400).json({ success: false, message, error: message });
  }

  function logPayload(action, payload) {
    console.log(`[Action:${action}] location=${payload.extras?.locationId} contact=${payload.extras?.contactId || '-'} data=${JSON.stringify(payload.data ?? payload.inputData ?? {})}`);
  }

  /**
   * Subscription gate for workflow actions. Throws 402 when the location isn't entitled,
   * so the caller's catch returns a failed step to GHL and the action is NOT performed.
   */
  async function ensureEntitled(payload) {
    if (!subscriptionService) return;
    const locationId = payload.extras?.locationId;
    if (!locationId) return;
    await subscriptionService.ensureEntitled(locationId);
  }

  // ═══════════════════════════════════════════════════════════
  // HEALTH CHECK - verify this route is reachable
  // ═══════════════════════════════════════════════════════════

  router.get('/health', (req, res) => {
    console.log('[Workflows] Health check hit');
    res.json({ status: 'ok', module: 'workflows' });
  });

  // ═══════════════════════════════════════════════════════════
  // TRIGGER SUBSCRIPTIONS (not gated)
  // ═══════════════════════════════════════════════════════════

  router.post('/triggers/subscriptions', async (req, res) => {
    const payload = req.body;

    console.log(
      `Trigger subscription received: ${payload.triggerData?.eventType} for key=${payload.meta?.key}`,
    );

    try {
      const result = await workflowsService.handleSubscription(payload);
      res.json(result);
    } catch (error) {
      console.error(`Trigger subscription failed: ${error.message}`);
      actionError(res, error);
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ACTIONS (all gated by ensureEntitled)
  // ═══════════════════════════════════════════════════════════

  router.post('/actions/send-message', async (req, res) => {
    const payload = req.body;
    logPayload('send-message', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeSendMessage(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action send-message failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/send-buttons', async (req, res) => {
    const payload = req.body;
    logPayload('send-buttons', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeSendButtons(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action send-buttons failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/forward-message', async (req, res) => {
    const payload = req.body;
    logPayload('forward-message', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeForwardMessage(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action forward-message failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/edit-message', async (req, res) => {
    const payload = req.body;
    logPayload('edit-message', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeEditMessage(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action edit-message failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/delete-message', async (req, res) => {
    const payload = req.body;
    logPayload('delete-message', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeDeleteMessage(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action delete-message failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/send-phone-message', async (req, res) => {
    const payload = req.body;
    logPayload('send-phone-message', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeSendPhoneMessage(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action send-phone-message failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/send-to-group', async (req, res) => {
    const payload = req.body;
    logPayload('send-to-group', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeSendToGroup(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action send-to-group failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/send-reaction', async (req, res) => {
    const payload = req.body;
    logPayload('send-reaction', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeSendReaction(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action send-reaction failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/generate-invite-link', async (req, res) => {
    const payload = req.body;
    logPayload('generate-invite-link', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeGenerateInviteLink(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action generate-invite-link failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/pin-message', async (req, res) => {
    const payload = req.body;
    logPayload('pin-message', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executePinMessage(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action pin-message failed: ${error.message}`);
      actionError(res, error);
    }
  });

  // Acknowledge an inline-button tap (pairs with the Button Clicked trigger).
  router.post('/actions/answer-callback', async (req, res) => {
    const payload = req.body;
    logPayload('answer-callback', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeAnswerCallback(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action answer-callback failed: ${error.message}`);
      actionError(res, error);
    }
  });

  router.post('/actions/edit-group-permissions', async (req, res) => {
    const payload = req.body;
    logPayload('edit-group-permissions', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeEditGroupPermissions(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action edit-group-permissions failed: ${error.message}`);
      actionError(res, error);
    }
  });

  // Remove a user from a group (e.g. plan cancelled, spam). Bot/phone must be admin.
  router.post('/actions/remove-from-group', async (req, res) => {
    const payload = req.body;
    logPayload('remove-from-group', payload);
    try {
      await ensureEntitled(payload);
      const result = await workflowsService.executeRemoveFromGroup(payload);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error(`Action remove-from-group failed: ${error.message}`);
      actionError(res, error);
    }
  });

  return router;
}

module.exports = { createWorkflowsRouter };
