import { SectionTitle } from './ui';

const TRIGGERS = [
  ['💬', 'New Message Received', 'Any message from a bot or phone contact'],
  ['🚀', 'New Subscriber', 'First-time contact on a bot or phone'],
  ['⌨️', 'Bot Command', '/start, /help, or custom commands'],
  ['📎', 'Media Received', 'Photo, video, or document'],
  ['🔄', 'Contact Reactivated', 'Replies after 7+ days of silence'],
  ['⚠️', 'Message Failed', 'Outbound delivery failed'],
  ['🔘', 'Button Clicked', 'Taps an inline keyboard button'],
  ['✏️', 'Message Edited', 'Edits a message they sent'],
  ['➕', 'Member Joined', 'Someone joins a managed group'],
  ['➖', 'Member Left', 'Someone leaves a group'],
  ['🚫', 'Bot Blocked', 'A contact blocks your bot'],
  ['✅', 'Bot Unblocked', 'A contact unblocks your bot'],
];

const ACTIONS = [
  ['📤', 'Send Message', 'Text to a contact'],
  ['🔘', 'Send with Buttons', 'Inline keyboard message'],
  ['📱', 'Send via Phone', 'Send as your account'],
  ['👥', 'Send to Group', 'Text or file to a group'],
  ['😀', 'React with Emoji', 'React to a message'],
  ['↗️', 'Forward Message', 'Forward to another chat'],
  ['📌', 'Pin Message', 'Pin in a chat or group'],
  ['✏️', 'Edit Message', 'Edit a sent message'],
  ['🗑️', 'Delete Message', 'Delete a message'],
  ['🔗', 'Generate Invite Link', 'Group/channel invite'],
  ['🛡️', 'Edit Group Permissions', 'Set group defaults'],
  ['🚪', 'Remove from Group', 'Kick a member'],
  ['☑️', 'Answer Callback', 'Acknowledge a button tap'],
];

function Item({ emoji, name, desc, tone }) {
  return (
    <div className="group flex items-start gap-3 bg-white rounded-xl border border-slate-200/80 p-3.5 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-card-hover)] hover:border-slate-300 transition-all">
      <div className="w-9 h-9 rounded-lg bg-slate-50 flex items-center justify-center text-[17px] shrink-0">{emoji}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[13.5px] font-semibold text-slate-900 truncate">{name}</span>
          <span className={`w-1.5 h-1.5 rounded-full ${tone}`} />
        </div>
        <div className="text-[12px] text-slate-400 leading-snug mt-0.5">{desc}</div>
      </div>
    </div>
  );
}

export default function WorkflowsPanel() {
  return (
    <div className="space-y-7">
      <div className="rounded-2xl p-4 bg-gradient-to-r from-[#eaf7fe] to-[#f5fbff] border border-[#cdebfa] text-[13px] text-slate-600">
        <span className="font-semibold text-slate-800">Unlimited workflow automation.</span>{' '}
        Build CRM workflows with {TRIGGERS.length} triggers and {ACTIONS.length} actions — no per-execution fees.
      </div>

      <section>
        <SectionTitle count={TRIGGERS.length} countTone="green">Triggers</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-3">
          {TRIGGERS.map(([e, n, d]) => <Item key={n} emoji={e} name={n} desc={d} tone="bg-emerald-500" />)}
        </div>
      </section>

      <section>
        <SectionTitle count={ACTIONS.length} countTone="tg">Actions</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-3">
          {ACTIONS.map(([e, n, d]) => <Item key={n} emoji={e} name={n} desc={d} tone="bg-[#229ED9]" />)}
        </div>
      </section>
    </div>
  );
}
