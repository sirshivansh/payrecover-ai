import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/OverviewPage';
import { RecoveryDetailPage } from './pages/RecoveryDetailPage';
import { RecoveryListPage } from './pages/RecoveryListPage';

/**
 * PayRecover AI Dashboard — Application Router & Shell (§15, §21.1)
 *
 * Routes:
 *   / -> OverviewPage (Metrics summary, rates, status counts)
 *   /recoveries -> RecoveryListPage (Paginated list, status filter)
 *   /recoveries/:id -> RecoveryDetailPage (Attempt detail, lifecycle visualizer, payment summary, audit timeline)
 */
export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/recoveries" element={<RecoveryListPage />} />
          <Route path="/recoveries/:id" element={<RecoveryDetailPage />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
