import { BrowserRouter, Route, Routes } from 'react-router-dom';

/**
 * PayRecover AI Dashboard — Application Shell
 *
 * Phase 0: Skeleton routes only. No business UI.
 * Dashboard pages will be implemented in Phase 15.
 *
 * Routes per specification §21.1:
 *   / → OverviewPage
 *   /recoveries → RecoveryListPage
 *   /recoveries/:id → RecoveryDetailPage
 */
export function App() {
  return (
    <BrowserRouter>
      <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', padding: '2rem' }}>
        <header>
          <h1>PayRecover AI</h1>
          <p style={{ color: '#666' }}>AI-Assisted Revenue Recovery Dashboard</p>
        </header>
        <nav style={{ margin: '1rem 0', display: 'flex', gap: '1rem' }}>
          <a href="/">Overview</a>
          <a href="/recoveries">Recoveries</a>
        </nav>
        <hr />
        <main>
          <Routes>
            <Route
              path="/"
              element={<PlaceholderPage title="Overview" description="Recovery metrics and summary — Phase 15" />}
            />
            <Route
              path="/recoveries"
              element={<PlaceholderPage title="Recoveries" description="Recovery attempt list — Phase 15" />}
            />
            <Route
              path="/recoveries/:id"
              element={
                <PlaceholderPage title="Recovery Detail" description="Attempt detail with audit trail — Phase 15" />
              }
            />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ padding: '2rem', border: '1px dashed #ccc', borderRadius: '8px', marginTop: '1rem' }}>
      <h2>{title}</h2>
      <p style={{ color: '#999' }}>{description}</p>
    </div>
  );
}
