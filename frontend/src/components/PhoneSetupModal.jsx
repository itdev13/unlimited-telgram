import { useState } from 'react';
import { api } from '../api';
import { Modal, Card, Button, Input } from './ui';
import { Phone, Check } from './Icons';

/**
 * Phone login: number → OTP → (optional) 2FA. Mirrors the backend gramjs flow:
 * send-code → verify-code → submit-2fa (if require2FA). A PHONE_ALREADY_CONNECTED error
 * (409) offers to transfer from another location via confirmTransfer.
 */
export default function PhoneSetupModal({ open, onClose, locationId, ssoPayload, onConnected }) {
  const [step, setStep] = useState('phone'); // phone | code | twofa
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [transfer, setTransfer] = useState(null); // details when number is on another location

  const reset = () => { setStep('phone'); setPhone(''); setCode(''); setPassword(''); setError(''); setTransfer(null); };
  const close = () => { reset(); onClose?.(); };

  const sendCode = async (confirmTransfer = false) => {
    setError('');
    if (!/^\+[1-9]\d{6,14}$/.test(phone.trim())) return setError('Use international format, e.g. +14155551234');
    setBusy(true);
    try {
      await api.call('POST', `/connections/${locationId}/phone/send-code`, ssoPayload, {
        phoneNumber: phone.trim(),
        confirmTransfer,
      });
      setTransfer(null);
      setStep('code');
    } catch (err) {
      if (err.code === 'PHONE_ALREADY_CONNECTED') setTransfer(err.details || {});
      else setError(err.message || 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError('');
    if (!code.trim()) return setError('Enter the code Telegram sent you.');
    setBusy(true);
    try {
      const data = await api.call('POST', `/connections/${locationId}/phone/verify-code`, ssoPayload, { phoneCode: code.trim() });
      if (data?.require2FA) { setStep('twofa'); }
      else { onConnected?.(data); reset(); }
    } catch (err) {
      setError(err.message || 'Invalid code.');
    } finally {
      setBusy(false);
    }
  };

  const submit2fa = async () => {
    setError('');
    if (!password) return setError('Enter your Telegram cloud password.');
    setBusy(true);
    try {
      const data = await api.call('POST', `/connections/${locationId}/phone/submit-2fa`, ssoPayload, { password });
      onConnected?.(data); reset();
    } catch (err) {
      setError(err.message || 'Incorrect password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} maxWidth="max-w-md">
      <Card className="overflow-hidden">
        <div className="p-5 bg-gradient-to-br from-[#eafdf4] to-white border-b border-slate-100 flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-white flex items-center justify-center text-emerald-600 ring-1 ring-emerald-100">
            <Phone size={22} />
          </div>
          <div>
            <h2 className="text-[16px] font-bold text-slate-900">Connect a Phone Account</h2>
            <p className="text-[12.5px] text-slate-500">Send & receive as your own Telegram account.</p>
          </div>
        </div>

        {/* Step dots */}
        <div className="px-5 pt-4 flex items-center gap-2">
          {['phone', 'code', 'twofa'].map((s, i) => {
            const order = ['phone', 'code', 'twofa'];
            const active = order.indexOf(step) >= i;
            return <span key={s} className={`h-1.5 rounded-full flex-1 transition-colors ${active ? 'bg-[#229ED9]' : 'bg-slate-200'}`} />;
          })}
        </div>

        <div className="p-5 space-y-4">
          {step === 'phone' && (
            <>
              <Input
                label="Phone Number"
                placeholder="+14155551234"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                error={!transfer ? error : ''}
                hint="International format with country code."
              />
              {transfer && (
                <div className="rounded-xl bg-amber-50 border border-amber-200 p-3.5 text-[12.5px] text-amber-800">
                  This number is already connected{transfer.displayName ? ` as ${transfer.displayName}` : ''} on another sub-account.
                  Move it here?
                  <div className="mt-2.5 flex gap-2">
                    <Button size="sm" variant="dark" loading={busy} onClick={() => sendCode(true)}>Move it here</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'code' && (
            <Input
              label="Verification Code"
              placeholder="12345"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              error={error}
              hint={`Sent to ${phone} on Telegram.`}
            />
          )}

          {step === 'twofa' && (
            <Input
              label="Cloud Password (2FA)"
              type="password"
              placeholder="Your Telegram password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error}
              hint="Required because you have two-step verification on."
            />
          )}
        </div>

        <div className="p-5 pt-0 flex items-center justify-end gap-2.5">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {step === 'phone' && !transfer && <Button onClick={() => sendCode(false)} loading={busy}>Send Code</Button>}
          {step === 'code' && <Button onClick={verify} loading={busy}>{!busy && <Check size={17} />} Verify</Button>}
          {step === 'twofa' && <Button onClick={submit2fa} loading={busy}>{!busy && <Check size={17} />} Connect</Button>}
        </div>
      </Card>
    </Modal>
  );
}
