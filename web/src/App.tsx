import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { Alert } from './components/ui';
import { AlertsPage } from './pages/AlertsPage';
import { ComparisonPage } from './pages/ComparisonPage';
import { AdminPage } from './pages/AdminPage';
import { GuidePage } from './pages/GuidePage';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { RunsPage } from './pages/RunsPage';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  section: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/comparison', label: 'Price comparison', icon: '📊', section: 'Monitor' },
  { to: '/alerts', label: 'Alerts', icon: '🔔', section: 'Monitor' },
  { to: '/review', label: 'Match review', icon: '🔍', section: 'Monitor' },
  { to: '/runs', label: 'Scrape runs', icon: '🔄', section: 'Monitor' },
  { to: '/import', label: 'Import feed', icon: '📥', section: 'Configure' },
  { to: '/admin', label: 'Admin', icon: '⚙️', section: 'Configure' },
  { to: '/guide', label: 'User guide', icon: '📖', section: 'Help' },
];

const PAGE_META: Record<string, { eyebrow: string; title: string }> = {
  '/comparison': { eyebrow: 'Monitor', title: 'Price comparison' },
  '/alerts': { eyebrow: 'Monitor', title: 'Undercut alerts' },
  '/review': { eyebrow: 'Monitor', title: 'Match review queue' },
  '/runs': { eyebrow: 'Monitor', title: 'Scrape runs' },
  '/import': { eyebrow: 'Configure', title: 'Import product feed' },
  '/admin': { eyebrow: 'Configure', title: 'Admin' },
  '/guide': { eyebrow: 'Help', title: 'User guide' },
};

export function App() {
  const location = useLocation();
  const [session, setSession] = useState<{ authEnabled: boolean; authenticated: boolean } | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [openAlertCount, setOpenAlertCount] = useState(0);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api.session());
    } catch (err) {
      setFatalError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the API. Is the server running and DATABASE_URL set?',
      );
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const refreshPendingCount = useCallback(async () => {
    try {
      const { total } = await api.matches('pending');
      setPendingCount(total);
    } catch {
      // A failed badge refresh should never block the page.
    }
  }, []);

  const refreshOpenAlertCount = useCallback(async () => {
    try {
      const { total } = await api.alerts('open');
      setOpenAlertCount(total);
    } catch {
      // A failed badge refresh should never block the page.
    }
  }, []);

  useEffect(() => {
    if (session?.authenticated) void refreshPendingCount();
  }, [session?.authenticated, location.pathname, refreshPendingCount]);

  useEffect(() => {
    if (session?.authenticated) void refreshOpenAlertCount();
  }, [session?.authenticated, location.pathname, refreshOpenAlertCount]);

  if (fatalError) {
    return (
      <div className="page" style={{ maxWidth: 680, margin: '10vh auto' }}>
        <Alert tone="danger" title="Cannot reach the API">
          {fatalError}
        </Alert>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="page" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="row muted">
          <span className="spinner" /> Loading…
        </div>
      </div>
    );
  }

  if (session.authEnabled && !session.authenticated) {
    return <LoginPage onAuthenticated={() => void loadSession()} />;
  }

  const meta = PAGE_META[location.pathname] ?? { eyebrow: 'Monitor', title: 'Competitor Price Monitor' };
  const sections = [...new Set(NAV_ITEMS.map((item) => item.section))];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <div className="sidebar__mark" aria-hidden>
            PM
          </div>
          <div>
            <div className="sidebar__title">Price Monitor</div>
            <div className="sidebar__subtitle">WOSG</div>
          </div>
        </div>

        {sections.map((section) => (
          <div key={section}>
            <div className="sidebar__section">{section}</div>
            <nav>
              {NAV_ITEMS.filter((item) => item.section === section).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
                >
                  <span className="nav-link__icon" aria-hidden>
                    {item.icon}
                  </span>
                  {item.label}
                  {item.to === '/review' && pendingCount > 0 && (
                    <span className="nav-link__badge">{pendingCount}</span>
                  )}
                  {item.to === '/alerts' && openAlertCount > 0 && (
                    <span className="nav-link__badge">{openAlertCount}</span>
                  )}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}

        <div className="sidebar__footer">
          MVP / Phase 0 — manual runs only.
          <br />
          Competitor data is public pricing only.
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__heading">
            <div className="topbar__eyebrow">{meta.eyebrow}</div>
            <h1 style={{ fontSize: 'var(--text-xl)' }}>{meta.title}</h1>
          </div>
          <div className="topbar__actions">
            {session.authEnabled && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={async () => {
                  await api.logout();
                  void loadSession();
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <Routes>
          <Route path="/" element={<Navigate to="/comparison" replace />} />
          <Route path="/comparison" element={<ComparisonPage />} />
          <Route path="/alerts" element={<AlertsPage onQueueChange={refreshOpenAlertCount} />} />
          <Route path="/review" element={<ReviewQueuePage onQueueChange={refreshPendingCount} />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/import" element={<ImportPage />} />
          {/* Competitors used to be its own page; it now lives on Admin. */}
          <Route path="/competitors" element={<Navigate to="/admin" replace />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="*" element={<Navigate to="/comparison" replace />} />
        </Routes>
      </div>
    </div>
  );
}
