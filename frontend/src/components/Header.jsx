import { ExternalLink } from './Icons';
import { Badge } from './ui';

export default function Header({ connectedCount = 0 }) {
  return (
    <header className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-3.5">
        <div className="relative w-12 h-12 rounded-2xl overflow-hidden shadow-[var(--shadow-glow-tg)] ring-1 ring-black/5">
          <img src="/logo.jpg" alt="Telegram Connector" className="w-full h-full object-cover" />
        </div>
        <div>
          <h1 className="text-[20px] font-extrabold text-slate-900 tracking-tight leading-tight">
            Telegram Connector
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[13px] text-slate-500">Two-way Telegram for your CRM</p>
            <a
              href="https://telegram.vaultsuite.store/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] font-medium text-[#1784b8] hover:text-[#0f6a97]"
            >
              Docs <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </div>

      {connectedCount > 0 && (
        <Badge tone="green" dot>
          {connectedCount} connected
        </Badge>
      )}
    </header>
  );
}
