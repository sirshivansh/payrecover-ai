import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="app-container">
      <header className="header">
        <div className="header-brand">
          <div className="brand-icon">PR</div>
          <div>
            <h1>PayRecover AI</h1>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Revenue Recovery Operations & Observability
            </p>
          </div>
        </div>
        <nav className="nav-links">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            Overview
          </NavLink>
          <NavLink to="/recoveries" className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}>
            Recovery Attempts
          </NavLink>
        </nav>
      </header>

      <main className="main-content">{children}</main>
    </div>
  );
}
