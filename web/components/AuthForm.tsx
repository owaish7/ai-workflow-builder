'use client';

import { useState } from 'react';
import { useSignInEmailPassword, useSignUpEmailPassword } from '@nhost/react';

export default function AuthForm() {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const signIn = useSignInEmailPassword();
  const signUp = useSignUpEmailPassword();

  const busy = signIn.isLoading || signUp.isLoading;
  const error = signIn.error || signUp.error;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'in') await signIn.signInEmailPassword(email, password);
    else await signUp.signUpEmailPassword(email, password, { displayName: displayName || email });
  }

  return (
    <div style={{ maxWidth: 400, margin: '8vh auto' }}>
      <h1>AI Workflow Builder</h1>
      <p className="muted small">A mini n8n for chaining AI agent steps.</p>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <button className={mode === 'in' ? 'primary' : ''} onClick={() => setMode('in')}>Sign in</button>
          <button className={mode === 'up' ? 'primary' : ''} onClick={() => setMode('up')}>Sign up</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'up' && (
            <>
              <label>Display name</label>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Alice (Org A owner)" />
            </>
          )}
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
          <button className="primary" style={{ marginTop: 14, width: '100%' }} disabled={busy}>
            {busy ? '…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {error && <p className="small" style={{ color: 'var(--red)' }}>{error.message}</p>}
        {signUp.needsEmailVerification && (
          <p className="small" style={{ color: 'var(--amber)' }}>
            Email verification is on — turn it off in the nhost dashboard for the demo.
          </p>
        )}
      </div>
    </div>
  );
}
