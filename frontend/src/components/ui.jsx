import { useEffect } from 'react';
import { Loader } from './Icons';

// ── Button ────────────────────────────────────────────────
export function Button({ children, variant = 'primary', size = 'md', loading, disabled, className = '', ...props }) {
  const sizes = {
    sm: 'h-9 px-3.5 text-[13px] gap-1.5 rounded-lg',
    md: 'h-11 px-5 text-sm gap-2 rounded-xl',
    lg: 'h-12 px-6 text-[15px] gap-2 rounded-xl',
  };
  const variants = {
    primary:
      'bg-gradient-to-b from-[#2aa7e0] to-[#1f93cf] text-white font-semibold shadow-[0_6px_20px_-6px_rgba(34,158,217,0.6)] hover:shadow-[0_10px_28px_-6px_rgba(34,158,217,0.7)] hover:brightness-[1.03] active:brightness-95',
    dark: 'bg-slate-900 text-white font-semibold hover:bg-slate-800 shadow-sm',
    ghost: 'bg-white text-slate-700 font-medium border border-slate-200 hover:border-slate-300 hover:bg-slate-50 shadow-sm',
    subtle: 'bg-slate-100 text-slate-700 font-medium hover:bg-slate-200',
    danger: 'bg-white text-red-600 font-medium border border-red-200 hover:bg-red-50',
  };
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center ring-focus transition-all duration-150 disabled:opacity-50 disabled:pointer-events-none ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    >
      {loading && <Loader size={size === 'sm' ? 15 : 18} />}
      {children}
    </button>
  );
}

// ── Card ──────────────────────────────────────────────────
export function Card({ children, className = '', hover = false, ...props }) {
  return (
    <div
      className={`bg-white rounded-2xl border border-slate-200/80 shadow-[var(--shadow-card)] ${hover ? 'transition-all duration-200 hover:shadow-[var(--shadow-card-hover)] hover:-translate-y-0.5' : ''} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────
export function Badge({ children, tone = 'slate', dot = false, className = '' }) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
    red: 'bg-red-50 text-red-700 ring-red-200',
    tg: 'bg-[#e8f6fd] text-[#1784b8] ring-[#bfe6f7]',
    slate: 'bg-slate-100 text-slate-600 ring-slate-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  };
  const dotColor = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-500', tg: 'bg-[#229ED9]', slate: 'bg-slate-400', violet: 'bg-violet-500' };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ring-1 ring-inset ${tones[tone]} ${className}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dotColor[tone]} ${tone === 'green' ? 'animate-pulse-dot' : ''}`} />}
      {children}
    </span>
  );
}

// ── Input ─────────────────────────────────────────────────
export function Input({ label, hint, error, className = '', ...props }) {
  return (
    <label className="block">
      {label && <span className="block text-[13px] font-semibold text-slate-700 mb-1.5">{label}</span>}
      <input
        className={`w-full h-11 px-3.5 rounded-xl border bg-white text-sm text-slate-900 placeholder:text-slate-400 ring-focus transition-colors ${error ? 'border-red-300' : 'border-slate-200'} ${className}`}
        {...props}
      />
      {error ? (
        <span className="block text-[12px] text-red-600 mt-1.5">{error}</span>
      ) : hint ? (
        <span className="block text-[12px] text-slate-400 mt-1.5">{hint}</span>
      ) : null}
    </label>
  );
}

// ── Modal ─────────────────────────────────────────────────
export function Modal({ open, onClose, children, maxWidth = 'max-w-md' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    // Lock body scroll while open so the backdrop always covers the full viewport
    // (important inside the GHL iframe, where a scrolled page can clip a fixed overlay).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto animate-fade-in">
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${maxWidth} my-auto animate-scale-in`}>{children}</div>
    </div>
  );
}

// ── Section heading with divider ──────────────────────────
export function SectionTitle({ children, count, countTone = 'slate', right }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <h3 className="text-[13px] font-bold text-slate-900 uppercase tracking-wide">{children}</h3>
      {count != null && <Badge tone={countTone}>{count}</Badge>}
      <span className="h-px flex-1 bg-gradient-to-r from-slate-200 to-transparent" />
      {right}
    </div>
  );
}
