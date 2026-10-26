const { Router } = require('express');
const { formatError } = require('../utils/format-error');

const APP_NAME = 'Telegram Connector';
const LOGO_URL = `${process.env.BACKEND_URL || ''}/logo.jpg`;

const PAGE_HEAD = (title) => `<meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} · ${APP_NAME}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0; padding: 20px;
      -webkit-font-smoothing: antialiased;
      background:
        radial-gradient(900px 500px at 100% -10%, rgba(34,158,217,0.22), transparent 55%),
        radial-gradient(800px 500px at -10% 110%, rgba(23,132,184,0.18), transparent 55%),
        #0b1f2b;
    }
    .card {
      width: 100%; max-width: 460px; background: #fff;
      border-radius: 22px; padding: 40px 36px;
      box-shadow: 0 30px 70px -20px rgba(2,15,25,0.55);
      text-align: center; animation: pop .5s cubic-bezier(.22,1,.36,1) both;
    }
    @keyframes pop { from { opacity:0; transform: translateY(14px) scale(.97);} to {opacity:1; transform:none;} }
    .brand { display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom: 26px; }
    .brand img { width: 34px; height: 34px; border-radius: 9px; box-shadow: 0 4px 12px rgba(34,158,217,.3); }
    .brand span { font-weight: 800; font-size: 16px; color: #0f2a3a; letter-spacing: -0.01em; }
    .badge {
      width: 72px; height: 72px; border-radius: 20px; margin: 0 auto 20px;
      display:flex; align-items:center; justify-content:center; font-size: 34px;
    }
    h1 { margin: 0 0 8px; font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
    .sub { color: #64748b; font-size: 14.5px; margin: 0 0 24px; line-height: 1.55; }
    .steps {
      text-align:left; background: #f6fbfe; border: 1px solid #d8eef9;
      border-radius: 14px; padding: 18px 20px; margin: 0 0 18px;
    }
    .steps h3 { margin: 0 0 12px; font-size: 13px; font-weight: 700; color: #1784b8; text-transform: uppercase; letter-spacing: .04em; }
    .step { display:flex; gap:11px; align-items:flex-start; color:#334155; font-size:14px; margin: 11px 0; }
    .step .n { flex: none; width: 21px; height: 21px; border-radius: 50%; background:#229ED9; color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; margin-top:1px; }
    .step .t { flex: 1; line-height: 1.5; }
    .step .t b { font-weight: 700; color: #0f2a3a; }
    .note { background:#fff7ed; border:1px solid #fed7aa; color:#9a3412; font-size:13px; font-weight:600; border-radius:12px; padding:12px 14px; }
    .close { color:#94a3b8; font-size:12.5px; margin-top: 18px; }
    .err { background:#fef2f2; border:1px solid #fecaca; color:#b91c1c; font-size:13px; border-radius:12px; padding:12px 14px; margin:0 0 16px; word-break:break-word; }
    a { color:#1784b8; font-weight:600; text-decoration:none; }
  </style>`;

const BRAND = `<div class="brand"><img src="${LOGO_URL}" alt="${APP_NAME}" /><span>${APP_NAME}</span></div>`;

function renderInstallSuccessPage({ alreadyCompleted = false } = {}) {
  const heading = alreadyCompleted ? 'Already connected' : 'Connected successfully';
  const subline = alreadyCompleted
    ? 'Your account is already linked — you’re all set.'
    : `${APP_NAME} is now connected to your account.`;

  return `<!DOCTYPE html><html><head>${PAGE_HEAD('Connected')}</head>
<body>
  <div class="card">
    ${BRAND}
    <div class="badge" style="background:linear-gradient(135deg,#d1fae5,#a7f3d0);">✅</div>
    <h1 style="color:#059669;">${heading}</h1>
    <p class="sub">${subline}</p>

    <div class="steps">
      <h3>How to open the app</h3>
      <div class="step"><span class="n">1</span><span class="t">Open your sub-account dashboard</span></div>
      <div class="step"><span class="n">2</span><span class="t">Find <b>${APP_NAME}</b> in the left navigation menu</span></div>
      <div class="step"><span class="n">3</span><span class="t">Click to launch and start connecting Telegram</span></div>
    </div>

    <div class="note">Installation complete — you can safely close this window.</div>
    <p class="close">You can close this window once you've reviewed the steps above.</p>
  </div>
</body></html>`;
}

function renderInstallErrorPage(message) {
  return `<!DOCTYPE html><html><head>${PAGE_HEAD('Install error')}</head>
<body>
  <div class="card">
    ${BRAND}
    <div class="badge" style="background:linear-gradient(135deg,#fee2e2,#fecaca);">⚠️</div>
    <h1 style="color:#dc2626;">Installation failed</h1>
    <p class="sub">We hit an error completing the installation. Please try installing ${APP_NAME} again.</p>
    <div class="err">${escapeHtml(message || 'Unknown error')}</div>
    <p class="sub" style="margin:0;">Need help? Visit <a href="https://telegramv2.vaultsuite.store/" target="_blank" rel="noopener noreferrer">our help page</a>.</p>
  </div>
</body></html>`;
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
    // No code at all → nothing to exchange (e.g. the user refreshed a code-less URL, or
    // landed here directly). Show the success page rather than an error, since by this
    // point the install has almost always already completed.
    if (!req.query.code) {
      return res.send(renderInstallSuccessPage());
    }

    try {
      await authService.handleOAuthCallback(req.query.code, req.query.state);
      return res.send(renderInstallSuccessPage());
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
