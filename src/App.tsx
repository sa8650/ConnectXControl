import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import Layout from './components/Layout';
import { Toaster, Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Devices from './pages/Devices';
import Jobs from './pages/Jobs';
import Shops from './pages/Shops';
import Systems from './pages/Systems';
import Releases from './pages/Releases';
import Carriers from './pages/Carriers';
import ApiDocs from './pages/ApiDocs';
import Activity from './pages/Activity';
import Settings from './pages/Settings';

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
        <Route path="/devices" element={<Protected><Devices /></Protected>} />
        <Route path="/jobs" element={<Protected><Jobs /></Protected>} />
        <Route path="/shops" element={<Protected><Shops /></Protected>} />
        <Route path="/systems" element={<Protected><Systems /></Protected>} />
        <Route path="/workspaces" element={<Navigate to="/shops" replace />} />
        <Route path="/clients" element={<Navigate to="/systems" replace />} />
        <Route path="/releases" element={<Protected><Releases /></Protected>} />
        <Route path="/carriers" element={<Protected><Carriers /></Protected>} />
        <Route path="/api-docs" element={<Protected><ApiDocs /></Protected>} />
        <Route path="/activity" element={<Protected><Activity /></Protected>} />
        <Route path="/settings" element={<Protected><Settings /></Protected>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
