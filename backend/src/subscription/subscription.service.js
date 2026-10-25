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
      name: process.env.PLAN_NAME || 'Standard',
      priceUsd: Number(process.env.PLAN_PRICE_USD) || 0,
      botLimit: Number(process.env.PLAN_BOT_LIMIT) || 2,
      phoneLimit: Number(process.env.PLAN_PHONE_LIMIT) || 1,
    };
  }

  // Resolve a GHL planId to our tier definition (with limits).
  planForId(planId) {
    if (planId && this.plans[planId]) return { planId, ...this.plans[planId] };
    return { planId: planId || null, ...this._defaultPlan() };
  }

  botLimitFor(plan) {
    return plan?.botLimit ?? 0;
  }

  phoneLimitFor(plan) {
    return plan?.phoneLimit ?? 0;
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
      botLimit: plan.botLimit,
      phoneLimit: plan.phoneLimit,
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
        ? { name: sub.planName, priceUsd: sub.priceUsd, botLimit: sub.botLimit, phoneLimit: sub.phoneLimit }
        : null,
      currentPeriodEnd: sub?.currentPeriodEnd || null,
    };
  }

  // Returns the per-plan limits for enforcement, or null if no subscription.
  async planLimits(locationId) {
    const sub = await Subscription.findOne({ locationId }).lean();
    if (!sub) return null;
    return { botLimit: sub.botLimit, phoneLimit: sub.phoneLimit, planName: sub.planName };
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

  // List all plans (for the Plans page), flagging the current one.
  async listPlans(locationId) {
    const sub = await Subscription.findOne({ locationId }).lean();
    const entries = Object.entries(this.plans).map(([planId, p]) => ({
      planId,
      name: p.name,
      priceUsd: p.priceUsd,
      botLimit: p.botLimit,
      phoneLimit: p.phoneLimit,
      isCurrent: sub?.planId === planId,
    }));
    entries.sort((a, b) => (a.priceUsd || 0) - (b.priceUsd || 0));
    return entries;
  }
}

module.exports = SubscriptionService;
