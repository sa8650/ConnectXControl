import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import { Toaster, Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Jobs from './pages/Jobs';
import Releases from './pages/Releases';
import Activity from './pages/Activity';
import Settings from './pages/Settings';
import ConnectApp from './pages/ConnectApp';
import Phones from './pages/Phones';

function Protected({ children }: { children: React.ReactNode }) {
  const { operator, loading } = useAuth();
  if (loading) return <div className="center-screen"><Spinner /></div>;
  if (!operator) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const { operator, initialized, loading } = useAuth();
  if (loading) return <div className="center-screen"><Spinner /></div>;
  return (
    <>
      <Toaster />
      <Routes>
        <Route path="/login" element={
          operator ? <Navigate to="/" replace /> : <Login setupMode={!initialized} />
        } />
        <Route path="/" element={<Protected><Dashboard /></Protected>} />
        <Route path="/connect" element={<Protected><ConnectApp /></Protected>} />
        <Route path="/phones" element={<Protected><Phones /></Protected>} />
        <Route path="/jobs" element={<Protected><Jobs /></Protected>} />
        <Route path="/devices" element={<Navigate to="/connect" replace />} />
        <Route path="/shops" element={<Navigate to="/connect" replace />} />
        <Route path="/systems" element={<Navigate to="/connect" replace />} />
        <Route path="/api-docs" element={<Navigate to="/connect" replace />} />
        <Route path="/workspaces" element={<Navigate to="/connect" replace />} />
        <Route path="/clients" element={<Navigate to="/connect" replace />} />
        <Route path="/releases" element={<Protected><Releases /></Protected>} />
        <Route path="/carriers" element={<Navigate to="/settings" replace />} />
        <Route path="/activity" element={<Protected><Activity /></Protected>} />
        <Route path="/settings" element={<Protected><Settings /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
