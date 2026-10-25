import { Check, Spark, Bot, Phone, Bolt } from './Icons';
import { Badge } from './ui';

function fmtLimit(n) {
  return n >= 9999 ? 'Unlimited' : n;
}

/**
 * Tiered plans. `plans` from GET /subscription/plans (each: {planId,name,priceUsd,
 * botLimit,phoneLimit,isCurrent}). `sub` = subscription status (for trial note).
 */
export default function PlansPanel({ plans = [], sub }) {
  const hasPlans = plans.length > 0;

  return (
    <div className="space-y-5">
      <div className="text-center max-w-lg mx-auto">
        <h2 className="text-[22px] font-extrabold text-slate-900 tracking-tight">Simple, flat pricing</h2>
        <p className="text-[13.5px] text-slate-500 mt-1.5">
          One monthly price. Unlimited messages, unlimited workflow actions — no per-message fees, ever.
        </p>
        {sub?.isTrial && (
          <div className="mt-3 inline-flex">
            <Badge tone="tg" dot>Free trial · {sub.trialDaysLeft} day{sub.trialDaysLeft === 1 ? '' : 's'} left</Badge>
          </div>
        )}
      </div>

      {!hasPlans ? (
        <div className="text-center text-[13px] text-slate-400 py-10">Plans are being configured. Check back shortly.</div>
      ) : (
        <div className="grid md:grid-cols-3 gap-4">
          {plans.map((p, i) => {
            const featured = i === 1; // middle tier visually featured
            return (
              <div
                key={p.planId}
                className={`relative rounded-2xl p-5 flex flex-col transition-all duration-200 ${
                  featured
                    ? 'bg-gradient-to-b from-[#0f2a3a] to-[#0b2230] text-white shadow-[0_20px_50px_-15px_rgba(15,42,58,0.5)] md:-mt-2 md:mb-2'
                    : 'bg-white border border-slate-200/80 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)]'
                }`}
              >
                {featured && (
                  <span className="absolute top-4 right-4 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider bg-white/15 text-white px-2 py-0.5 rounded-full ring-1 ring-white/25">
                    <Spark size={11} /> Popular
                  </span>
                )}

                <div className="text-[14px] font-bold">{p.name}</div>
                <div className="mt-2 flex items-baseline gap-1">
                  <span className={`text-[32px] font-extrabold tracking-tight ${featured ? 'text-white' : 'text-slate-900'}`}>
                    ${p.priceUsd}
                  </span>
                  <span className={`text-[13px] ${featured ? 'text-white/60' : 'text-slate-400'}`}>/mo</span>
                </div>

                <div className={`mt-4 space-y-2.5 text-[13px] ${featured ? 'text-white/85' : 'text-slate-600'}`}>
                  <Feat featured={featured} icon={<Bot size={15} />}>{fmtLimit(p.botLimit)} {p.botLimit === 1 ? 'bot' : 'bots'}</Feat>
                  <Feat featured={featured} icon={<Phone size={15} />}>{fmtLimit(p.phoneLimit)} phone {p.phoneLimit === 1 ? 'account' : 'accounts'}</Feat>
                  <Feat featured={featured} icon={<Bolt size={15} />}>Unlimited workflow actions</Feat>
                  <Feat featured={featured} icon={<Check size={15} />}>Two-way sync & media</Feat>
                </div>

                <div className="mt-5 pt-4 border-t border-dashed border-current/10">
                  {p.isCurrent ? (
                    <div className={`h-10 rounded-xl flex items-center justify-center gap-1.5 text-[13px] font-semibold ${featured ? 'bg-white/15 text-white' : 'bg-emerald-50 text-emerald-700'}`}>
                      <Check size={16} /> Current plan
                    </div>
                  ) : (
                    <div className={`h-10 rounded-xl flex items-center justify-center text-[13px] font-semibold ${featured ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'}`}>
                      {sub?.entitled ? 'Switch plan' : 'Choose plan'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-center text-[11.5px] text-slate-400">
        Manage billing from the GoHighLevel Marketplace. Plan changes apply on your next cycle.
      </p>
    </div>
  );
}

function Feat({ children, icon, featured }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`shrink-0 ${featured ? 'text-[#4cc4f0]' : 'text-[#229ED9]'}`}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}
