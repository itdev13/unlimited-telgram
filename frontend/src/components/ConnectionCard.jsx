import { Bot, Phone, Trash, Check, Alert } from './Icons';
import { Badge } from './ui';

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

/**
 * One connected bot or phone. `type` = 'bot' | 'phone'. `conn` is the object from
 * GET /connections. onDisconnect(id) triggers the disconnect flow.
 */
export default function ConnectionCard({ type, conn, onDisconnect }) {
  const isBot = type === 'bot';
  const title = isBot
    ? conn.username ? `@${conn.username}` : 'Telegram Bot'
    : conn.displayName || conn.telegramUsername ? (conn.displayName || `@${conn.telegramUsername}`) : conn.phoneNumber;
  const subtitle = isBot
    ? conn.label || 'Bot connection'
    : conn.phoneNumber;

  const healthy = conn.isActive;
  const accent = isBot ? 'from-[#eaf4ff] to-white text-[#2563eb]' : 'from-[#eafdf4] to-white text-emerald-600';

  return (
    <div className="group relative bg-white rounded-2xl border border-slate-200/80 shadow-[var(--shadow-card)] p-4 transition-all duration-200 hover:shadow-[var(--shadow-card-hover)]">
      <div className="flex items-start gap-3.5">
        <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${accent} flex items-center justify-center shrink-0 ring-1 ring-slate-100`}>
          {isBot ? <Bot size={22} /> : <Phone size={22} />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-bold text-slate-900 truncate">{title}</span>
            {healthy ? (
              <Badge tone="green" dot>Connected</Badge>
            ) : (
              <Badge tone="amber">Reconnect needed</Badge>
            )}
          </div>
          <div className="text-[12.5px] text-slate-500 mt-0.5 truncate">{subtitle}</div>

          <div className="flex items-center gap-4 mt-2.5 text-[11.5px] text-slate-400">
            <span className="inline-flex items-center gap-1">
              {healthy ? <Check size={13} className="text-emerald-500" /> : <Alert size={13} className="text-amber-500" />}
              {isBot ? 'Bot API' : 'Phone account'}
            </span>
            <span>Connected {fmtDate(conn.connectedAt)}</span>
          </div>
        </div>

        <button
          onClick={() => onDisconnect(conn)}
          title="Disconnect"
          className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <Trash size={17} />
        </button>
      </div>

      {!healthy && (
        <div className="mt-3 pt-3 border-t border-slate-100 text-[12px] text-amber-700 bg-amber-50/50 -mx-4 -mb-4 px-4 py-2.5 rounded-b-2xl">
          {isBot
            ? 'This bot stopped responding. Reconnect it to resume syncing.'
            : "Telegram ended this phone session. Remove and reconnect to resume."}
        </div>
      )}
    </div>
  );
}
