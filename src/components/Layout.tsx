import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◻', end: true },
  { to: '/connect', label: 'Connect App', icon: '⚭' },
  { to: '/phones', label: 'Android Phones', icon: '▣' },
  { to: '/jobs', label: 'Messages', icon: '✎' },
  { to: '/releases', label: 'App Releases', icon: '↥' },
  { to: '/activity', label: 'Activity', icon: '⧗' },
  { to: '/settings', label: 'Settings', icon: '⚙' }
];

export function Logo({ small }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? 'logo-sm' : ''}`}>
      <svg viewBox="0 0 64 64" width={small ? 26 : 34} height={small ? 26 : 34} aria-hidden>
        <rect width="64" height="64" rx="16" fill="#0e6b56" />
        <path d="M18 40 V24 h8 a8 8 0 0 1 0 16z" fill="none" stroke="#f3efe6" strokeWidth="3.2" />
        <circle cx="44" cy="24" r="4" fill="#e7b089" />
        <path d="M40 32 h10 M45 27 v10" stroke="#f3efe6" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <div className="logo-text">
        <strong>ConnectX</strong>
        <span>Connect App</span>
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
