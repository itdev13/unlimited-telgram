const { Router } = require('express');
const { formatError } = require('../utils/format-error');

function renderInstallSuccessPage({ alreadyCompleted = false } = {}) {
  const heading = alreadyCompleted
    ? 'Authorization Already Completed!'
    : 'Connected Successfully!';
  const subline = alreadyCompleted
    ? 'Your account is already connected'
    : 'Successfully connected to your account';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Success - Vaultsuite</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      text-align: center;
      background: #fff;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      max-width: 540px;
      margin: 20px;
    }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { color: #10B981; margin: 0 0 12px 0; font-size: 28px; }
    p { color: #6B7280; margin: 10px 0; font-size: 15px; line-height: 1.6; }
    .access-box {
      background: linear-gradient(135deg, #EEF2FF 0%, #E0E7FF 100%);
      padding: 22px;
      border-radius: 10px;
      margin: 22px 0;
      border: 2px solid #2563EB;
      text-align: left;
    }
    .access-box h3 { color: #1E40AF; font-size: 16px; margin: 0 0 12px 0; }
    .step {
      color: #374151;
      font-size: 14px;
      margin: 8px 0;
      padding-left: 22px;
      position: relative;
    }
    .step:before {
      content: "→";
      position: absolute;
      left: 0;
      color: #2563EB;
      font-weight: bold;
    }
    .tip {
      background: #FEF3C7;
      padding: 14px;
      border-radius: 8px;
      margin-top: 18px;
      border-left: 4px solid #F59E0B;
      text-align: left;
    }
    .tip p { color: #92400E; font-size: 13px; font-weight: 600; margin: 0; }
    .close-note { font-size: 13px; color: #9CA3AF; margin-top: 18px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✅</div>
    <h1>${heading}</h1>
    <p>${subline}</p>

    <div class="access-box">
      <h3>How to access the app</h3>
      <div class="step">Open your sub-account dashboard</div>
      <div class="step">Find the app in the left navigation menu</div>
      <div class="step">Click to launch and start using it</div>
    </div>

    <div class="tip">
      <p>Installation complete — you can safely close this window.</p>
    </div>

    <p class="close-note">You can close this window once you've reviewed the access steps above.</p>
  </div>
</body>
</html>`;
}

function renderInstallErrorPage(message) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Error - Vaultsuite</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      text-align: center;
      background: #fff;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      max-width: 500px;
      margin: 20px;
    }
    .icon { font-size: 56px; margin-bottom: 16px; }
    h1 { color: #EF4444; margin: 0 0 12px 0; }
    p { color: #6B7280; margin: 10px 0; }
    .error-detail {
      background: #FEE2E2;
      padding: 14px;
      border-radius: 8px;
      margin: 18px 0;
      color: #991B1B;
      font-size: 13px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠️</div>
    <h1>Connection Failed</h1>
    <p>We encountered an error while completing the installation. Please try installing again.</p>
    <div class="error-detail">${escapeHtml(message || 'Unknown error')}</div>
    <p style="margin-top: 20px;">
      Need help? Visit
      <a href="https://telegram.vaultsuite.store/" target="_blank" rel="noopener noreferrer" style="color: #2563EB; font-weight: 600;">telegram.vaultsuite.store</a>
      for setup guides and support.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createAuthRouter(authService) {
  const router = Router();

  // GET /auth/authorize
  router.get('/authorize', async (req, res) => {
    const clientId = process.env.GHL_CLIENT_ID;
    const redirectUri = process.env.GHL_REDIRECT_URI;

    // Keep this list in sync with the scopes enabled in the GHL Marketplace app config —
    // GHL only grants what's enabled there. customFields.* is required to create/write the
    // Telegram contact fields; customValues.* and workflows.readonly are already granted.
    const scopes = [
      'conversations.readonly',
      'conversations.write',
      'conversations/message.readonly',
      'conversations/message.write',
      'contacts.readonly',
      'contacts.write',
      'charges.readonly',
      'charges.write',
      'locations.readonly',
      'locations/customFields.readonly',
      'locations/customFields.write',
      'locations/customValues.readonly',
      'locations/customValues.write',
      'oauth.readonly',
      'oauth.write',
      'marketplace-installer-details.readonly',
    ].join(' ');

    let state = '';
    if (req.query.ref || req.query.campaign) {
      const stateData = {};
      if (req.query.ref) stateData.ref = req.query.ref;
      if (req.query.campaign) stateData.campaign = req.query.campaign;
      state = Buffer.from(JSON.stringify(stateData)).toString('base64');
    }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
    });

    if (state) {
      params.set('state', state);
    }

    const url = `https://marketplace.gohighlevel.com/oauth/chooselocation?${params.toString()}`;
    console.log(`Redirecting to GHL OAuth: ref=${req.query.ref || 'none'}`);
    res.redirect(url);
  });

  // GET /auth/callback
  router.get('/callback', async (req, res) => {
    try {
      await authService.handleOAuthCallback(req.query.code, req.query.state);
      res.send(renderInstallSuccessPage());
    } catch (error) {
      console.error(`OAuth callback failed | ${formatError(error)}`);

      const isCodeReused =
        error.response?.data?.error === 'invalid_grant' &&
        error.response?.data?.error_description?.includes('authorization code');

      if (isCodeReused) {
        // A reused/expired code means THIS exchange failed. Only show "success" if the
        // install actually completed on an earlier hit (a fresh installation with tokens
        // exists). Otherwise the install never finished — don't show a false success page
        // that leaves the location half-installed with no tokens.
        let installed = false;
        try {
          installed = await authService.wasRecentlyInstalled();
        } catch (checkErr) {
          console.warn(`[OAuth] install-verify check failed: ${checkErr.message}`);
        }
        if (installed) {
          return res.send(renderInstallSuccessPage({ alreadyCompleted: true }));
        }
        return res
          .status(400)
          .send(renderInstallErrorPage(
            'Install could not be completed — the authorization code expired or was already used. Please start the install again from the Marketplace, and let the page finish without refreshing.',
          ));
      }

      res.status(500).send(renderInstallErrorPage(error.message));
    }
  });

  // POST /auth/sso/decrypt
  router.post('/sso/decrypt', async (req, res) => {
    const { payload } = req.body;
    if (!payload || typeof payload !== 'string') {
      return res.status(400).json({ error: 'payload is required and must be a string' });
    }

    try {
      const userData = authService.decryptSsoPayload(payload);

      res.json({
        success: true,
        data: {
          userId: userData.userId,
          companyId: userData.companyId,
          locationId: userData.activeLocation,
          userName: userData.userName,
          email: userData.email,
          role: userData.role,
        },
      });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
