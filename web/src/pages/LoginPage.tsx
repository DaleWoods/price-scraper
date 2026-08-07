import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { Alert } from '../components/ui';

export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__brand">
          <div className="sidebar__mark" aria-hidden>
            PM
          </div>
          <div>
            <h2 style={{ fontSize: 'var(--text-lg)' }}>Competitor Price Monitor</h2>
            <div className="muted small">Watches of Switzerland Group</div>
          </div>
        </div>

        <p className="muted small">
          This tool uses a single shared password for the MVP. SSO and per-user roles come later.
        </p>

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="field">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            required
          />
        </div>

        <button type="submit" className="btn btn--primary" disabled={busy || !password}>
          {busy && <span className="spinner" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
