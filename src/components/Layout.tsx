import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◻', end: true },
  { to: '/phones', label: 'Android devices', icon: '▣' },
  { to: '/jobs', label: 'SMS history', icon: '✎' },
  { to: '/releases', label: 'App Releases', icon: '↥' },
  { to: '/activity', label: 'Activity', icon: '⧗' },
  { to: '/settings', label: 'Settings', icon: '⚙' }
];

export function Logo({ surface = 'dark' }: { surface?: 'dark' | 'light' }) {
  return (
    <div className={`logo ${surface === 'light' ? 'logo-light' : ''}`}>
      <img
        className="logo-mark"
        src="/favicon.svg"
        width={34}
        height={34}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <div className="logo-text">
        <strong>ConnectX</strong>
        <span>Platform Control</span>
      </div>
    </div>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const { operator, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><Logo /></div>
        <nav className="nav">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <span className="nav-icon">{n.icon}</span>{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-user">
            <div className="avatar">{(operator?.name || '?').slice(0, 1).toUpperCase()}</div>
            <div className="sidebar-user-meta">
              <strong>{operator?.name}</strong>
              <span>{operator?.role === 'owner' ? 'Platform owner' : 'Operator'}</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { logout(); navigate('/login'); }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
