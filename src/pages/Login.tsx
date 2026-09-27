import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Layout';
import { Button, Field, Input } from '../components/ui';

export default function Login({ setupMode }: { setupMode: boolean }) {
  const { login, setup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (setupMode) {
      if (password.length < 10) { setError('Use a password of at least 10 characters.'); return; }
      if (password !== confirm) { setError('Passwords do not match.'); return; }
    }
    setBusy(true);
    try {
      if (setupMode) await setup(name.trim(), email.trim(), password);
      else await login(email.trim(), password);
    } catch (err: any) {
      setError(err?.message || 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-head">
          <Logo />
          <h1>{setupMode ? 'Initialize ConnectX Control' : 'Sign in to ConnectX Control'}</h1>
          <p>
            {setupMode
              ? 'Create the platform owner account. This runs once — ConnectX is fully independent from any other product.'
              : 'Connect a product once. Approve the Android phone. SMS results come back on their own.'}
          </p>
        </div>
        {error && <div className="form-error">{error}</div>}
        {setupMode && (
          <div className="form-note">
            First run detected. This creates the ConnectX owner. Products connect later from Connect App — there are no API keys.
          </div>
        )}
        <form onSubmit={onSubmit}>
          {setupMode && (
            <Field label="Your name">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Platform owner name" required autoFocus />
            </Field>
          )}
          <Field label="Email">
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" required autoFocus={!setupMode} />
          </Field>
          <Field label="Password" hint={setupMode ? 'At least 10 characters.' : undefined}>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••••" required />
          </Field>
          {setupMode && (
            <Field label="Confirm password">
              <Input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••••••••" required />
            </Field>
          )}
          <Button type="submit" disabled={busy} variant="primary">
            {busy ? 'Please wait…' : setupMode ? 'Create owner account' : 'Sign in'}
          </Button>
        </form>
        <div className="login-foot">Connect App · powered by Dexter Studio</div>
      </div>
    </div>
  );
}
