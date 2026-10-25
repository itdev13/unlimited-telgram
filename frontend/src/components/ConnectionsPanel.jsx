import { useState } from 'react';
import { api } from '../api';
import ConnectionCard from './ConnectionCard';
import BotSetupModal from './BotSetupModal';
import PhoneSetupModal from './PhoneSetupModal';
import { Modal, Card, Button, SectionTitle, Badge } from './ui';
import { Bot, Phone, Plus, Lock, Trash } from './Icons';

function LimitHint({ used, limit, label }) {
  const unlimited = limit >= 9999;
  return (
    <span className="text-[11.5px] text-slate-400">
      {used}/{unlimited ? '∞' : limit} {label}
    </span>
  );
}

export default function ConnectionsPanel({ locationId, ssoPayload, connections, plan, entitled, onChanged, onViewPlans }) {
  const [botOpen, setBotOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [disconnect, setDisconnect] = useState(null); // { type, conn }
  const [busy, setBusy] = useState(false);

  const bots = connections?.bots || [];
  const phones = connections?.phones || [];
  const botLimit = plan?.botLimit ?? 0;
  const phoneLimit = plan?.phoneLimit ?? 0;
  const canAddBot = entitled && bots.length < botLimit;
  const canAddPhone = entitled && phones.length < phoneLimit;

  const doDisconnect = async () => {
    setBusy(true);
    try {
      const { type, conn } = disconnect;
      await api.call('DELETE', `/connections/${locationId}/${type}/${conn.id}`, ssoPayload);
      setDisconnect(null);
      onChanged?.();
    } catch {
      // surfaced via onChanged refetch; keep modal open on failure
    } finally {
      setBusy(false);
    }
  };

  const AddTile = ({ icon, title, desc, canAdd, onAdd, used, limit, label }) => (
    <button
      onClick={canAdd ? onAdd : onViewPlans}
      className={`group text-left rounded-2xl border-2 border-dashed p-4 transition-all ${
        canAdd ? 'border-slate-200 hover:border-[#229ED9] hover:bg-[#f5fbff]' : 'border-slate-200 bg-slate-50/60'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${canAdd ? 'bg-[#e8f6fd] text-[#1784b8]' : 'bg-slate-100 text-slate-400'}`}>
          {canAdd ? icon : <Lock size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-slate-800 flex items-center gap-2">
            {title}
            {canAdd && <Plus size={15} className="text-slate-400 group-hover:text-[#229ED9] transition-colors" />}
          </div>
          <div className="text-[12px] text-slate-500">{canAdd ? desc : (entitled ? 'Plan limit reached — upgrade to add more' : 'Subscribe to add connections')}</div>
        </div>
        <LimitHint used={used} limit={limit} label={label} />
      </div>
    </button>
  );

  return (
    <div className="space-y-6">
      {/* Bots */}
      <section>
        <SectionTitle count={bots.length} countTone="tg">Bots</SectionTitle>
        <div className="grid gap-3 stagger">
          {bots.map((b) => (
            <ConnectionCard key={b.id} type="bot" conn={b} onDisconnect={(conn) => setDisconnect({ type: 'bot', conn })} />
          ))}
          <AddTile
            icon={<Bot size={20} />}
            title="Add a bot"
            desc="Connect a Telegram bot via BotFather token"
            canAdd={canAddBot}
            onAdd={() => setBotOpen(true)}
            used={bots.length}
            limit={botLimit}
            label="bots"
          />
        </div>
      </section>

      {/* Phones */}
      <section>
        <SectionTitle count={phones.length} countTone="green">Phone Accounts</SectionTitle>
        <div className="grid gap-3 stagger">
          {phones.map((p) => (
            <ConnectionCard key={p.id} type="phone" conn={p} onDisconnect={(conn) => setDisconnect({ type: 'phone', conn })} />
          ))}
          <AddTile
            icon={<Phone size={20} />}
            title="Add a phone"
            desc="Link a Telegram account by phone number"
            canAdd={canAddPhone}
            onAdd={() => setPhoneOpen(true)}
            used={phones.length}
            limit={phoneLimit}
            label="phones"
          />
        </div>
      </section>

      {/* Modals */}
      <BotSetupModal
        open={botOpen}
        onClose={() => setBotOpen(false)}
        locationId={locationId}
        ssoPayload={ssoPayload}
        onConnected={() => { setBotOpen(false); onChanged?.(); }}
      />
      <PhoneSetupModal
        open={phoneOpen}
        onClose={() => setPhoneOpen(false)}
        locationId={locationId}
        ssoPayload={ssoPayload}
        onConnected={() => { setPhoneOpen(false); onChanged?.(); }}
      />

      <Modal open={!!disconnect} onClose={() => setDisconnect(null)} maxWidth="max-w-sm">
        <Card className="p-5">
          <div className="w-11 h-11 rounded-xl bg-red-50 text-red-500 flex items-center justify-center mb-3">
            <Trash size={20} />
          </div>
          <h3 className="text-[16px] font-bold text-slate-900">Disconnect this {disconnect?.type}?</h3>
          <p className="text-[13px] text-slate-500 mt-1.5">
            New Telegram messages from this {disconnect?.type} will stop syncing to your CRM. You can reconnect anytime.
          </p>
          <div className="flex justify-end gap-2.5 mt-5">
            <Button variant="ghost" onClick={() => setDisconnect(null)}>Keep it</Button>
            <Button variant="danger" loading={busy} onClick={doDisconnect}>Disconnect</Button>
          </div>
        </Card>
      </Modal>
    </div>
  );
}
