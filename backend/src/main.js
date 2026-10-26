require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { connectDatabase } = require('./database/connection');
const { formatError } = require('./utils/format-error');

// Services
const CryptoService = require('./crypto/crypto.service');
const AuthService = require('./auth/auth.service');
const TelegramService = require('./telegram/telegram.service');
const GhlService = require('./ghl/ghl.service');
const ContactMappingService = require('./contact-mapping/contact-mapping.service');
const SubscriptionService = require('./subscription/subscription.service');
const ConnectionService = require('./settings/connection.service');
const ConnectionManager = require('./telegram/connection-manager');
const WorkflowsService = require('./workflows/workflows.service');
const GramJsService = require('./telegram/gramjs.service');

// Routers
const { createAuthRouter } = require('./auth/auth.router');
const { createSubscriptionRouter } = require('./subscription/subscription.router');
const { createConnectionsRouter } = require('./connections/connections.router');
const { createSettingsRouter } = require('./settings/settings.router');
const { createWebhooksRouter } = require('./webhooks/webhooks.router');
const { createWorkflowsRouter } = require('./workflows/workflows.router');
const { createMediaRouter, cleanupExpiredMedia } = require('./media/media.router');

// Middleware
const { createSsoMiddleware } = require('./auth/guards/sso.middleware');

async function bootstrap() {
  // Connect to MongoDB
  await connectDatabase();

  // ── Services (dependency order) ──────────────────────────────
  const cryptoService = new CryptoService();
  const authService = new AuthService(cryptoService);
  const telegramService = new TelegramService();
  const ghlService = new GhlService(authService);
  const contactMappingService = new ContactMappingService(ghlService);
  const subscriptionService = new SubscriptionService();
  const connectionManager = new ConnectionManager(cryptoService);
  const connectionService = new ConnectionService(
    cryptoService,
    telegramService,
    authService,
    ghlService,
    subscriptionService,
    connectionManager,
  );
  const workflowsService = new WorkflowsService(
    contactMappingService,
    connectionService,
    telegramService,
    authService,
    connectionManager,
    ghlService,
    subscriptionService,
  );
  const gramJsService = new GramJsService(
    connectionManager,
    cryptoService,
    ghlService,
    contactMappingService,
    telegramService,
    workflowsService,
  );

  // SSO middleware (embedded UI identity).
  const ssoMiddleware = createSsoMiddleware(authService);

  // ── Express app ──────────────────────────────────────────────
  const app = express();

  // Behind nginx/cloudflare.
  app.set('trust proxy', 1);

  // CORS before the body parser so malformed-JSON errors still carry CORS headers.
  // Embedded across many white-label CRM domains; auth is via the X-SSO-Payload header,
  // not cookies — so credentials are NOT used and the wildcard origin is allowed.
  const corsOptions = {
    origin: '*',
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-SSO-Payload', 'ngrok-skip-browser-warning'],
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(express.json({ limit: '10mb' }));

  // Rate limiter for webhook endpoints.
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ── Routes ───────────────────────────────────────────────────
  app.get('/health', (req, res) => res.status(200).json({ status: 'ok', version: '2.0.0' }));

  app.use('/auth', createAuthRouter(authService));
  app.use('/subscription', createSubscriptionRouter(subscriptionService));
  app.use('/connections', createConnectionsRouter(connectionService, gramJsService, ssoMiddleware));
  app.use('/settings', createSettingsRouter(connectionService, subscriptionService, ssoMiddleware));
  app.use(
    '/webhooks',
    webhookLimiter,
    createWebhooksRouter(
      connectionService,
      telegramService,
      ghlService,
      contactMappingService,
      connectionManager,
      workflowsService,
      subscriptionService,
    ),
  );
  app.use('/workflows', createWorkflowsRouter(workflowsService, subscriptionService));
  app.use('/media', createMediaRouter());

  // Clean up expired media files on startup and every 30 minutes.
  cleanupExpiredMedia();
  setInterval(cleanupExpiredMedia, 30 * 60 * 1000);

  // Restore phone connections (staggered reconnect, keyed by connectionId).
  gramJsService.initAllClients().catch((err) => {
    console.error(`Failed to initialize phone connections | ${formatError(err)}`);
  });

  // Global error handler (last).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`Unhandled error | ${formatError(err)}`);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Internal server error',
      code: err.code,
    });
  });

  // Graceful shutdown — disconnect all GramJS clients.
  const shutdown = async () => {
    console.log('Shutting down — disconnecting GramJS clients...');
    try {
      await connectionManager.disconnectAll();
    } catch (err) {
      console.error(`Shutdown disconnect error | ${formatError(err)}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const port = process.env.PORT || 3015;
  app.listen(port, () => console.log(`Telegram Connector v2 running on port ${port}`));
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
