import { Clock, Lock, Spark, ArrowRight } from './Icons';

/**
 * Shows trial countdown, or a subscribe/past-due prompt. `sub` is the subscription status
 * object from GET /subscription/status. `onViewPlans` switches to the Plans tab.
 */
export default function SubscriptionBanner({ sub, onViewPlans }) {
  if (!sub) return null;

  // Trialing — friendly countdown.
  if (sub.isTrial) {
    const d = sub.trialDaysLeft;
    return (
      <div className="relative overflow-hidden rounded-2xl p-4 bg-gradient-to-r from-[#eaf7fe] to-[#f5fbff] border border-[#cdebfa]">
        <div className="pointer-events-none absolute -top-8 -right-6 w-28 h-28 rounded-full bg-[#229ED9]/10 blur-2xl" />
        <div className="relative flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-[#1784b8] ring-1 ring-[#cdebfa] shrink-0">
            <Clock size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-bold text-slate-900">
              {d > 0 ? `${d} day${d === 1 ? '' : 's'} left in your free trial` : 'Your trial ends today'}
            </div>
            <p className="text-[12.5px] text-slate-500 mt-0.5">
              Enjoying {sub.plan?.name || 'the app'}? Your plan continues automatically after the trial.
            </p>
          </div>
          <button
            onClick={onViewPlans}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors"
          >
            View plans <ArrowRight size={15} />
          </button>
        </div>
      </div>
    );
  }

  // Not entitled (past_due / canceled / inactive) — needs a subscription.
  if (sub.required && !sub.entitled) {
    const pastDue = sub.status === 'past_due';
    return (
      <div className="relative overflow-hidden rounded-2xl p-4 bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200">
        <div className="relative flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-amber-600 ring-1 ring-amber-200 shrink-0">
            <Lock size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-bold text-slate-900">
              {pastDue ? 'Payment needed to resume' : 'Subscribe to activate'}
            </div>
            <p className="text-[12.5px] text-slate-600 mt-0.5">
              {pastDue
                ? 'Your last payment failed. Update billing to keep messages syncing.'
                : 'Choose a plan to connect bots & phones and sync Telegram with your CRM.'}
            </p>
          </div>
          <button
            onClick={onViewPlans}
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors"
          >
            <Spark size={15} /> See plans
          </button>
        </div>
      </div>
    );
  }

  // Active & entitled — compact chip handled elsewhere; nothing to warn about here.
  return null;
}
