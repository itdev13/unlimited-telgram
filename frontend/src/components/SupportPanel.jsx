import { useState, useRef } from 'react';
import { API_BASE } from '../api';
import { Card, Button, Input } from './ui';
import { Life, Clock, ArrowRight, Check, Alert, Plus, Trash, Copy } from './Icons';

const CALENDAR_URL = 'https://calendar.app.google/crZcAddPma9veEK48';
const WHATSAPP_URL = 'https://chat.whatsapp.com/Go5WODTAXAf2ZeCfpBI6bG?s=sw&p=a&mlu=4&ilr=4';
const WHATSAPP_COMMUNITY = 'Telegram Unlimited Community'; // community/group name shown in the banner
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export default function SupportPanel({ user, ssoPayload }) {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [emailErr, setEmailErr] = useState('');
  const [copied, setCopied] = useState(false);
  const fileRef = useRef(null);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(WHATSAPP_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked — ignore
    }
  };

  const onEmail = (e) => {
    const email = e.target.value;
    setForm({ ...form, email });
    setEmailErr(email && !validEmail(email) ? 'Please enter a valid email address' : '');
  };

  const onFiles = (e) => {
    const sel = Array.from(e.target.files || []);
    if (files.length + sel.length > 5) { alert('Maximum 5 images allowed'); return; }
    const valid = sel.filter((f) => {
      if (f.size > 5 * 1024 * 1024) { alert(`${f.name} exceeds 5MB`); return false; }
      if (!f.type.startsWith('image/')) { alert(`${f.name} is not an image`); return false; }
      return true;
    });
    setFiles([...files, ...valid]);
    setPreviews([...previews, ...valid.map((f) => URL.createObjectURL(f))]);
    e.target.value = '';
  };

  const removeFile = (i) => {
    setFiles(files.filter((_, x) => x !== i));
    setPreviews(previews.filter((_, x) => x !== i));
  };

  const submit = async () => {
    setResult(null);
    if (!form.email || !validEmail(form.email)) return setEmailErr('Please enter a valid email address');
    if (!form.subject.trim() || !form.message.trim()) return setResult({ ok: false, msg: 'Subject and message are required.' });
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('name', form.name);
      fd.append('email', form.email);
      fd.append('subject', form.subject);
      fd.append('message', form.message);
      fd.append('locationId', user?.locationId || '');
      fd.append('userId', user?.userId || '');
      files.forEach((f) => fd.append('images', f));

      const res = await fetch(`${API_BASE}/support/ticket`, {
        method: 'POST',
        headers: { 'X-SSO-Payload': ssoPayload || '', 'ngrok-skip-browser-warning': 'true' },
        body: fd,
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || data.message || 'Failed to submit');
      setResult({ ok: true, msg: data.message || 'Ticket submitted — we’ll get back to you soon!' });
      setForm({ name: '', email: '', subject: '', message: '' });
      setFiles([]); setPreviews([]);
    } catch (err) {
      setResult({ ok: false, msg: err.message || 'Failed to submit support ticket.' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3.5">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center text-white shadow-[0_8px_24px_-8px_rgba(239,68,68,0.5)]">
          <Life size={24} />
        </div>
        <div>
          <h2 className="text-[18px] font-extrabold text-slate-900 tracking-tight">Support</h2>
          <p className="text-[13px] text-slate-500">Need help? Send us a message and we'll get back to you.</p>
        </div>
      </div>

      {/* Priority WhatsApp support — hidden for now; re-enable by flipping false → true. */}
      {false && (
      <div className="rounded-2xl p-4 bg-gradient-to-r from-[#eafaf0] to-[#f4fcf7] border border-[#c7ecd4] flex items-center gap-3.5 flex-wrap">
        <div className="w-11 h-11 rounded-xl bg-white flex items-center justify-center text-emerald-600 ring-1 ring-emerald-100 shrink-0">
          <Life size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-bold text-slate-900">Priority WhatsApp support</span>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-white ring-1 ring-emerald-200 rounded-full px-2 py-0.5">
              {WHATSAPP_COMMUNITY}
            </span>
          </div>
          <div className="text-[12.5px] text-slate-500 mt-0.5">Included on every plan — join our community for instant help.</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={copyLink}
            title="Copy invite link"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-white text-slate-600 text-[13px] font-medium ring-1 ring-slate-200 hover:ring-slate-300 hover:text-slate-800 transition-all"
          >
            {copied ? <Check size={15} className="text-emerald-600" /> : <Copy size={15} />}
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <a
            href={WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[#25D366] text-white text-[13px] font-semibold hover:brightness-105 transition-all shadow-[0_6px_18px_-6px_rgba(37,211,102,0.6)]"
          >
            Join now
          </a>
        </div>
      </div>
      )}

      {/* Book a call */}
      <a
        href={CALENDAR_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-3.5 rounded-2xl border border-[#cdebfa] bg-gradient-to-r from-[#eaf7fe] to-[#f5fbff] p-4 transition-all hover:shadow-[var(--shadow-card)]"
      >
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#2aa7e0] to-[#1784b8] flex items-center justify-center text-white shrink-0">
          <Clock size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-bold text-slate-900">Prefer a live call?</div>
          <div className="text-[12.5px] text-slate-500">Book a time and we'll walk through setup together.</div>
        </div>
        <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-[#1784b8] shrink-0">
          Schedule <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </a>

      {/* Ticket form */}
      <Card className="p-5">
        <div className="space-y-4">
          <Input label="Your Name (optional)" placeholder="John Doe" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Input label="Email Address *" type="email" placeholder="you@email.com" value={form.email} onChange={onEmail} error={emailErr} />
          <Input label="Subject *" placeholder="What do you need help with?" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />

          <label className="block">
            <span className="block text-[13px] font-semibold text-slate-700 mb-1.5">Message *</span>
            <textarea
              rows={5}
              placeholder="Describe your issue or question in detail…"
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 ring-focus resize-y"
            />
          </label>

          {/* Attachments */}
          <div>
            <span className="block text-[13px] font-semibold text-slate-700 mb-1.5">
              Attachments <span className="text-slate-400 font-normal">(optional — max 5 images, 5MB each)</span>
            </span>
            <div className="flex flex-wrap gap-2.5">
              {previews.map((src, i) => (
                <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden ring-1 ring-slate-200 group">
                  <img src={src} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeFile(i)}
                    className="absolute top-1 right-1 w-5 h-5 rounded-md bg-black/55 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash size={12} />
                  </button>
                </div>
              ))}
              {files.length < 5 && (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="w-20 h-20 rounded-xl border-2 border-dashed border-slate-300 text-slate-400 hover:border-[#229ED9] hover:text-[#229ED9] flex flex-col items-center justify-center gap-1 transition-colors"
                >
                  <Plus size={18} />
                  <span className="text-[11px] font-medium">Upload</span>
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
            </div>
          </div>

          {result && (
            <div className={`flex items-center gap-2 rounded-xl p-3 text-[13px] ${result.ok ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-red-50 text-red-700 ring-1 ring-red-200'}`}>
              {result.ok ? <Check size={16} /> : <Alert size={16} />} {result.msg}
            </div>
          )}

          <Button className="w-full" onClick={submit} loading={submitting}>
            {!submitting && <Check size={17} />} Submit Support Ticket
          </Button>
        </div>
      </Card>

      {/* Direct email */}
      <div className="rounded-2xl p-4 border border-slate-200 bg-white flex items-center gap-3 shadow-[var(--shadow-card)]">
        <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 ring-1 ring-emerald-100 shrink-0">
          <Life size={18} />
        </div>
        <p className="text-[13px] text-slate-600 flex-1">
          Prefer to email us directly? Reach us at{' '}
          <a href="mailto:binduchowdary856@gmail.com" className="font-semibold text-[#1784b8] hover:text-[#0f6a97]">
            binduchowdary856@gmail.com
          </a>
        </p>
      </div>
    </div>
  );
}
