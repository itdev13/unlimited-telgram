import { Life, Clock, Book, ArrowRight, ExternalLink } from './Icons';

const CALENDAR_URL = 'https://calendar.app.google/crZcAddPma9veEK48';
const SUPPORT_EMAIL = 'support@vaultsuite.store';
const DOCS_URL = 'https://telegramv2.vaultsuite.store/';

function ContactCard({ icon, title, desc, cta, href, accent }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[var(--shadow-card)] transition-all duration-200 hover:shadow-[var(--shadow-card-hover)] hover:-translate-y-0.5"
    >
      <div className={`w-11 h-11 rounded-xl flex items-center justify-center mb-3.5 ${accent}`}>{icon}</div>
      <div className="text-[15px] font-bold text-slate-900">{title}</div>
      <p className="text-[12.5px] text-slate-500 mt-1 leading-relaxed">{desc}</p>
      <div className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#1784b8]">
        {cta}
        <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
      </div>
    </a>
  );
}

export default function SupportPanel() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3.5">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center text-white shadow-[0_8px_24px_-8px_rgba(239,68,68,0.5)]">
          <Life size={24} />
        </div>
        <div>
          <h2 className="text-[18px] font-extrabold text-slate-900 tracking-tight">We're here to help</h2>
          <p className="text-[13px] text-slate-500">Book a call, email us, or read the docs — we reply fast.</p>
        </div>
      </div>

      {/* Contact options */}
      <div className="grid sm:grid-cols-3 gap-4">
        <ContactCard
          icon={<Clock size={22} className="text-white" />}
          accent="bg-gradient-to-br from-[#2aa7e0] to-[#1784b8]"
          title="Book a call"
          desc="Grab a time that suits you and we'll walk through setup together."
          cta="Schedule now"
          href={CALENDAR_URL}
        />
        <ContactCard
          icon={<Life size={22} className="text-white" />}
          accent="bg-gradient-to-br from-emerald-500 to-emerald-600"
          title="Email support"
          desc="Send us the details and we'll get back to you by email."
          cta="Email us"
          href={`mailto:${SUPPORT_EMAIL}?subject=Telegram%20Connector%20Support`}
        />
        <ContactCard
          icon={<Book size={22} className="text-white" />}
          accent="bg-gradient-to-br from-violet-500 to-violet-600"
          title="Documentation"
          desc="Setup guides, workflow tips, and answers to common questions."
          cta="Read the docs"
          href={DOCS_URL}
        />
      </div>

      {/* Priority support note */}
      <div className="rounded-2xl p-4 bg-gradient-to-r from-[#eaf7fe] to-[#f5fbff] border border-[#cdebfa] flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center text-[#1784b8] ring-1 ring-[#cdebfa] shrink-0">
          <Life size={18} />
        </div>
        <p className="text-[13px] text-slate-600">
          <span className="font-semibold text-slate-800">Priority support</span> via WhatsApp &amp; Telegram is included on every plan.
        </p>
      </div>
    </div>
  );
}
