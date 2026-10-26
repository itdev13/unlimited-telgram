import { useState } from 'react';
import { api } from '../api';
import { Card, Button, Input } from './ui';
import { Bot, Check, ExternalLink, ArrowRight } from './Icons';

const STEPS = [
  { n: '1', t: 'Open BotFather', d: 'Message @BotFather on Telegram and send /newbot.' },
  { n: '2', t: 'Name your bot', d: 'Pick a display name and a username ending in "bot".' },
  { n: '3', t: 'Copy the token', d: 'BotFather replies with an API token — paste it below.' },
];

/**
 * Inline (full-panel) bot connect wizard. Replaces the connections view while active.
 * onBack returns to the list; onConnected fires after a successful connect.
 */
export default function BotConnectWizard({ locationId, ssoPayload, onBack, onConnected }) {
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connect = async () => {
    setError('');
    if (!token.trim()) return setError('Paste your bot token to continue.');
    setBusy(true);
    try {
      const data = await api.call('POST', `/connections/${locationId}/bot`, ssoPayload, {
        botToken: token.trim(),
        label: label.trim(),
      });
      onConnected?.(data);
    } catch (err) {
      setError(err.message || 'Could not connect the bot.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="animate-fade-up">
      {/* Breadcrumb / back */}
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-slate-800 mb-4">
        <ArrowRight size={15} className="rotate-180" /> Back to connections
      </button>

      <Card className="overflow-hidden">
        <div className="p-5 bg-gradient-to-br from-[#eaf4ff] to-white border-b border-slate-100 flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white flex items-center justify-center text-[#2563eb] ring-1 ring-blue-100">
            <Bot size={22} />
          </div>
          <div>
            <h2 className="text-[16px] font-bold text-slate-900">Connect a Telegram Bot</h2>
            <p className="text-[12.5px] text-slate-500">Customers message your branded bot; chats appear in your CRM.</p>
          </div>
        </div>

        <div className="p-5 grid md:grid-cols-2 gap-6">
          {/* Left: instructions */}
          <div>
            <ol className="space-y-3">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-3">
                  <span className="shrink-0 w-6 h-6 rounded-full bg-slate-900 text-white text-[12px] font-bold flex items-center justify-center">{s.n}</span>
                  <div>
                    <div className="text-[13.5px] font-semibold text-slate-800">{s.t}</div>
                    <div className="text-[12.5px] text-slate-500">{s.d}</div>
                  </div>
                </li>
              ))}
            </ol>
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#1784b8] hover:text-[#0f6a97] mt-4"
            >
              Open @BotFather <ExternalLink size={13} />
            </a>
          </div>

          {/* Right: form */}
          <div className="space-y-3">
            <Input
              label="Bot Token"
              placeholder="123456789:AaBbCc-DdEeFf..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              error={error}
            />
            <Input
              label="Label (optional)"
              placeholder="e.g. Support Bot"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              hint="Helps you tell connections apart."
            />
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <Button variant="ghost" onClick={onBack}>Cancel</Button>
              <Button onClick={connect} loading={busy}>
                {!busy && <Check size={17} />} Connect Bot
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
