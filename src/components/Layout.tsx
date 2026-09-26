import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '◧', end: true },
  { to: '/devices', label: 'Gateways', icon: '▣' },
  { to: '/jobs', label: 'Messages', icon: '≡' },
  { to: '/shops', label: 'Shops', icon: '◈' },
  { to: '/systems', label: 'Systems & API Keys', icon: '⚿' },
  { to: '/releases', label: 'App Releases', icon: '↥' },
  { to: '/carriers', label: 'SIM Carriers', icon: '◉' },
  { to: '/api-docs', label: 'API Docs', icon: '⌘' },
  { to: '/activity', label: 'Activity', icon: '⧗' },
  { to: '/settings', label: 'Settings', icon: '⚙' }
];

export function Logo({ small }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? 'logo-sm' : ''}`}>
      <svg viewBox="0 0 64 64" width={small ? 26 : 34} height={small ? 26 : 34} aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="1" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="14" fill="url(#lg)" />
        <path d="M24 20 L14 32 L24 44" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M40 20 L50 32 L40 44" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="32" cy="32" r="4" fill="#fff" />
      </svg>
      <div className="logo-text">
        <strong>ConnectX</strong>
        <span>Control</span>
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
