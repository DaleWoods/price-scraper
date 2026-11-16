import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { Alert } from './components/ui';
import { AlertsPage } from './pages/AlertsPage';
import { ComparisonPage } from './pages/ComparisonPage';
import { ReportPage } from './pages/ReportPage';
import { PositionPage } from './pages/PositionPage';
import { AdminPage } from './pages/AdminPage';
import { GuidePage } from './pages/GuidePage';
import { ImportPage } from './pages/ImportPage';
import { LoginPage } from './pages/LoginPage';
import { CheckPage } from './pages/CheckPage';
import { RunsPage } from './pages/RunsPage';

interface NavItem {
  to: string;
  label: string;
  icon: string;
}

/**
 * The three things the app is for. Everything else is folded under "More":
 * still there for whoever wants it, out of the way of everyone who does not.
 */
const NAV_ITEMS: NavItem[] = [
  { to: '/check', label: 'Check a product', icon: '🔎' },
  { to: '/comparison', label: 'All products', icon: '📊' },
  { to: '/admin', label: 'Admin', icon: '⚙️' },
];

const MORE_ITEMS: NavItem[] = [
  { to: '/report', label: 'What moved', icon: '📈' },
  { to: '/position', label: 'Market position', icon: '🎯' },
  { to: '/alerts', label: 'Alerts', icon: '🔔' },
  { to: '/runs', label: 'Scrape runs', icon: '🔄' },
  { to: '/import', label: 'Import feed', icon: '📥' },
  { to: '/guide', label: 'User guide', icon: '📖' },
];

const PAGE_META: Record<string, { eyebrow: string; title: string }> = {
  '/check': { eyebrow: 'Price check', title: 'Check a product' },
  '/comparison': { eyebrow: 'Price check', title: 'All products' },
  '/report': { eyebrow: 'More', title: 'What moved' },
  '/position': { eyebrow: 'More', title: 'Market position' },
  '/alerts': { eyebrow: 'More', title: 'Alerts' },
  '/runs': { eyebrow: 'More', title: 'Scrape runs' },
  '/import': { eyebrow: 'More', title: 'Import product feed' },
  '/admin': { eyebrow: 'Settings', title: 'Admin' },
  '/guide': { eyebrow: 'Help', title: 'User guide' },
};

function NavItemLink({ item, badge }: { item: NavItem; badge?: number }) {
  return (
    <NavLink to={item.to} className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}>
      <span className="nav-link__icon" aria-hidden>
        {item.icon}
      </span>
      {item.label}
      {badge != null && badge > 0 && <span className="nav-link__badge">{badge}</span>}
    </NavLink>
  );
}

export function App() {
  const location = useLocation();
  const [session, setSession] = useState<{ authEnabled: boolean; authenticated: boolean } | null>(null);
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

  const refreshOpenAlertCount = useCallback(async () => {
    try {
      const { total } = await api.alerts('open');
      setOpenAlertCount(total);
    } catch {
      // A failed badge refresh should never block the page.
    }
  }, []);

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

        <nav style={{ marginTop: 'var(--sp-4)' }}>
          {NAV_ITEMS.map((item) => (
            <NavItemLink key={item.to} item={item} />
          ))}
        </nav>

        <details className="sidebar__more" open={MORE_ITEMS.some((item) => item.to === location.pathname)}>
          <summary className="sidebar__section">More</summary>
          <nav>
            {MORE_ITEMS.map((item) => (
              <NavItemLink
                key={item.to}
                item={item}
                badge={item.to === '/alerts' ? openAlertCount : undefined}
              />
            ))}
          </nav>
        </details>

        <div className="sidebar__footer">
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
          <Route path="/" element={<Navigate to="/check" replace />} />
          <Route path="/check" element={<CheckPage />} />
          <Route path="/comparison" element={<ComparisonPage />} />
          <Route path="/report" element={<ReportPage />} />
          <Route path="/position" element={<PositionPage />} />
          <Route path="/alerts" element={<AlertsPage onQueueChange={refreshOpenAlertCount} />} />
          {/* Nothing is matched by likeness any more, so nothing waits for review. */}
          <Route path="/review" element={<Navigate to="/check" replace />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/import" element={<ImportPage />} />
          {/* Competitors used to be its own page; it now lives on Admin. */}
          <Route path="/competitors" element={<Navigate to="/admin" replace />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/guide" element={<GuidePage />} />
          <Route path="*" element={<Navigate to="/check" replace />} />
        </Routes>
      </div>
    </div>
  );
}
