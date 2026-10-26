const Subscription = require('../schemas/subscription.schema');
const TrialLedger = require('../schemas/trial-ledger.schema');

/**
 * Subscription entitlement for v2. GHL Marketplace collects the monthly fee; this service
 * mirrors entitlement, maps GHL planId → our tier (bot/phone limits), and runs the
 * app-controlled 3-day trial. Based on HelmDesk's proven model.
 *
 * Plan catalog comes from PLANS_JSON env, e.g.:
 *   {"<ghlPlanId>":{"name":"Starter","priceUsd":19,"botLimit":2,"phoneLimit":1}, ...}
 * Fallback single plan via PLAN_NAME / PLAN_PRICE_USD / PLAN_BOT_LIMIT / PLAN_PHONE_LIMIT.
 */
class SubscriptionService {
  constructor() {
    this.required = process.env.SUBSCRIPTION_REQUIRED !== 'false';
    this.trialDays = Number(process.env.TRIAL_DAYS) || 3;
    this.trialConvertGraceDays = Number(process.env.TRIAL_CONVERT_GRACE_DAYS) || 4;
    this.plans = this._loadPlans();
  }

  _loadPlans() {
    try {
      if (process.env.PLANS_JSON) return JSON.parse(process.env.PLANS_JSON);
    } catch (err) {
      console.warn(`[Subscription] PLANS_JSON parse failed: ${err.message}`);
    }
    return {};
  }

  _defaultPlan() {
    return {
      name: process.env.PLAN_NAME || 'Basic',
      priceUsd: Number(process.env.PLAN_PRICE_USD) || 0,
      // Combined limit: bots + phones together ("Telegram Accounts").
      connectionLimit: Number(process.env.PLAN_CONNECTION_LIMIT) || 1,
    };
  }

  // Resolve a GHL planId to our tier definition (with the combined connection limit).
  // Accepts connectionLimit, or falls back to max(botLimit, phoneLimit) for older configs.
  planForId(planId) {
    const raw = planId && this.plans[planId] ? { planId, ...this.plans[planId] } : { planId: planId || null, ...this._defaultPlan() };
    if (raw.connectionLimit == null) {
      raw.connectionLimit = Math.max(Number(raw.botLimit) || 0, Number(raw.phoneLimit) || 0) || 1;
    }
    return raw;
  }

  connectionLimitFor(plan) {
    return plan?.connectionLimit ?? 0;
  }

  /**
   * Called from the INSTALL and PLAN_CHANGE webhooks. Upserts the subscription. On a real
   * install (no explicit status) grants the 3-day trial exactly once via TrialLedger.
   */
  async activate({ locationId, companyId, appId, planId, status, raw }) {
    const plan = this.planForId(planId);
    const now = new Date();

    const update = {
      companyId,
      appId,
      planId: plan.planId,
      planName: plan.name,
      priceUsd: plan.priceUsd,
      connectionLimit: plan.connectionLimit,
      rawWebhookData: raw,
    };

    if (status) {
      // Explicit status from a plan-change / payment webhook.
      update.status = status;
      if (status === 'active') {
        update.currentPeriodStart = now;
        update.currentPeriodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      }
      if (status === 'canceled') update.canceledAt = now;
    } else {
      // Fresh install → grant trial once (abuse-proof via TrialLedger).
      const existingTrial = await TrialLedger.findOne({ locationId }).lean();
      if (!existingTrial) {
        const trialEndsAt = new Date(now.getTime() + this.trialDays * 24 * 60 * 60 * 1000);
        update.status = 'trialing';
        update.trialEndsAt = trialEndsAt;
        // Race-safe: upsert the ledger row (never deleted on uninstall).
        await TrialLedger.updateOne(
          { locationId },
          { $setOnInsert: { locationId, companyId, firstTrialStartedAt: now, trialEndsAt, planId: plan.planId } },
          { upsert: true },
        );
      } else {
        // Trial already used before → require a paid plan.
        update.status = 'inactive';
      }
    }

    await Subscription.updateOne({ locationId }, { $set: update }, { upsert: true });
    console.log(`[Subscription] ${locationId} → ${update.status} (${plan.name})`);
    return Subscription.findOne({ locationId });
  }

  async setStatus(locationId, status) {
    const extra = {};
    if (status === 'canceled') extra.canceledAt = new Date();
    await Subscription.updateOne({ locationId }, { $set: { status, ...extra } });
  }

  /**
   * Safety net: GHL sends NO webhook when a trial converts to paid. Once trialEndsAt +
   * grace has passed and we're still 'trialing', flip to 'active'. A FAILED trial instead
   * arrives as UNINSTALL (→canceled) or APP_PAYMENT_STATUS FAILED (→past_due) within the
   * retry window, so this never converts a non-payer.
   */
  async maybeConvertExpiredTrial(sub) {
    if (!sub || sub.status !== 'trialing' || !sub.trialEndsAt) return sub;
    const graceMs = this.trialConvertGraceDays * 24 * 60 * 60 * 1000;
    if (Date.now() < new Date(sub.trialEndsAt).getTime() + graceMs) return sub;
    const now = new Date();
    await Subscription.updateOne(
      { locationId: sub.locationId },
      { $set: { status: 'active', currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } },
    );
    console.log(`[Subscription] ${sub.locationId} trial auto-converted → active`);
    return Subscription.findOne({ locationId: sub.locationId });
  }

  async getStatus(locationId) {
    let sub = await Subscription.findOne({ locationId });
    if (sub) sub = await this.maybeConvertExpiredTrial(sub);

    const entitled = !this.required || (sub ? sub.isEntitled() : false);
    const isTrial = sub?.status === 'trialing';
    let trialDaysLeft = 0;
    if (isTrial && sub.trialEndsAt) {
      trialDaysLeft = Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    }

    return {
      entitled,
      required: this.required,
      status: sub?.status || 'inactive',
      isTrial,
      trialDaysLeft,
      plan: sub
        ? { name: sub.planName, priceUsd: sub.priceUsd, connectionLimit: sub.connectionLimit }
        : null,
      currentPeriodEnd: sub?.currentPeriodEnd || null,
    };
  }

  // Returns the plan's combined connection limit for enforcement, or null if no subscription.
  async planLimits(locationId) {
    const sub = await Subscription.findOne({ locationId }).lean();
    if (!sub) return null;
    return { connectionLimit: sub.connectionLimit, planName: sub.planName };
  }

  // Throws 402 when a subscription is required but the location isn't entitled.
  async ensureEntitled(locationId) {
    if (!this.required) return;
    const { entitled } = await this.getStatus(locationId);
    if (!entitled) {
      const err = new Error('An active subscription is required to use this feature.');
      err.statusCode = 402;
      err.code = 'SUBSCRIPTION_REQUIRED';
      throw err;
    }
  }

  /**
   * Build the GHL deep-link the "Choose plan" / "Switch plan" button points at. Mirrors
   * HelmDesk: 'enrol' (no plan yet → first subscribe) opens the version enrol page; 'upgrade'
   * (already subscribed → change tier) opens the upgrade/downgrade picker. Uses the agency's
   * white-label domain and app/version captured at install.
   */
  async buildUpgradeUrl(locationId, mode = 'enrol') {
    if (process.env.MARKETPLACE_UPGRADE_URL) return process.env.MARKETPLACE_UPGRADE_URL;
    try {
      const Installation = require('../schemas/installation.schema');
      const inst = await Installation.findOne({ locationId, status: 'active' }).sort({ updatedAt: -1 }).lean();
      const appId = inst?.appId || process.env.GHL_APP_ID;
      if (!appId || !locationId) return '';

      const versionId = inst?.versionId || process.env.GHL_APP_VERSION_ID || '';
      const rawDomain = inst?.whitelabelDomain || process.env.GHL_DEFAULT_APP_DOMAIN || 'app.gohighlevel.com';
      const host = String(rawDomain).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const base = `https://${host}/v2/location/${locationId}/integration/${appId}`;

      if (mode === 'upgrade') return `${base}/upgrade-plans?app_from=installedApps`;
      return `${versionId ? `${base}/versions/${versionId}` : base}?view=subAccount`;
    } catch {
      return '';
    }
  }

  // List all plans (for the Plans page), flagging the current one and including the GHL
  // deep-link the user should be sent to when they click Choose/Switch plan.
  async listPlans(locationId) {
    const sub = await Subscription.findOne({ locationId }).lean();
    // A user who has a plan context already (active, past_due, or trialing) should be sent
    // to the upgrade/change-tier page. Only a truly fresh user (no plan) goes to enrol.
    const hasPlanContext = !!sub && ['active', 'past_due', 'trialing'].includes(sub.status);
    const url = await this.buildUpgradeUrl(locationId, hasPlanContext ? 'upgrade' : 'enrol');

    const entries = Object.entries(this.plans).map(([planId, p]) => {
      const plan = this.planForId(planId);
      return {
        planId,
        name: plan.name,
        priceUsd: plan.priceUsd,
        connectionLimit: plan.connectionLimit,
        isCurrent: sub?.planId === planId,
        url,
      };
    });
    entries.sort((a, b) => (a.priceUsd || 0) - (b.priceUsd || 0));
    return entries;
  }
}

module.exports = SubscriptionService;
