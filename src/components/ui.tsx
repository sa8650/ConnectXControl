import React, { useEffect, useState } from 'react';

/* ---------- Card ---------- */
export function Card({ title, subtitle, actions, children, className = '' }: {
  title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/* ---------- Stat tile ---------- */
export function Stat({ label, value, tone = 'default', hint }: {
  label: string; value: React.ReactNode; tone?: 'default' | 'good' | 'bad' | 'warn' | 'info'; hint?: string;
}) {
  return (
    <div className={`stat stat-${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

/* ---------- Badge ---------- */
const STATUS_TONES: Record<string, string> = {
  sent: 'good', active: 'good', online: 'good', published: 'good',
  queued: 'info', sending: 'info', pending_test: 'warn', paused: 'warn', disabled: 'bad',
  failed: 'bad', revoked: 'bad', cancelled: 'muted', draft: 'muted'
};
export function Badge({ value, tone }: { value: string; tone?: string }) {
  const t = tone || STATUS_TONES[value] || 'muted';
  return <span className={`badge badge-${t}`}>{value.replace(/_/g, ' ')}</span>;
}

/* ---------- Buttons ---------- */
export function Button({ children, onClick, variant = 'primary', disabled, type = 'button', title }: {
  children: React.ReactNode; onClick?: (e: React.MouseEvent) => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'soft'; disabled?: boolean;
  type?: 'button' | 'submit'; title?: string;
}) {
  return (
    <button type={type} title={title} className={`btn btn-${variant}`} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/* ---------- Inputs ---------- */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
export const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) =>
  <input className="input" {...props} />;
export const TextArea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) =>
  <textarea className="input" {...props} />;
export const Select = (props: React.SelectHTMLAttributes<HTMLSelectElement>) =>
  <select className="input" {...props} />;

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ---------- Toasts ---------- */
type Toast = { id: number; text: string; kind: 'ok' | 'err' };
let pushToast: ((text: string, kind?: 'ok' | 'err') => void) | null = null;
export function toast(text: string, kind: 'ok' | 'err' = 'ok') { pushToast?.(text, kind); }

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    pushToast = (text, kind = 'ok') => {
      const id = Date.now() + Math.random();
      setItems(prev => [...prev, { id, text, kind }]);
      setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 4200);
    };
    return () => { pushToast = null; };
  }, []);
  return (
    <div className="toaster">
      {items.map(t => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

/* ---------- Copy button ---------- */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-soft btn-sm"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch {
          const ta = document.createElement('textarea');
          ta.value = value; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        setDone(true); setTimeout(() => setDone(false), 1500);
      }}>
      {done ? '✓ Copied' : label}
    </button>
  );
}

/* ---------- Misc ---------- */
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n?: number): string {
  if (!n) return '—';
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function timeAgo(iso?: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return iso;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
