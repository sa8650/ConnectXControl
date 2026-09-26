import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, Operator } from '../api/client';

interface AuthState {
  operator: Operator | null;
  initialized: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  setup: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [operator, setOperator] = useState<Operator | null>(null);
  const [initialized, setInitialized] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const boot = await api.get<{ initialized: boolean }>('control/bootstrap');
      setInitialized(boot.initialized);
      if (!boot.initialized) { setOperator(null); return; }
      if (!getToken()) { setOperator(null); return; }
      const me = await api.get<{ operator: Operator }>('control/auth/me');
      setOperator(me.operator);
    } catch {
      setOperator(null);
      setToken('');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; operator: Operator }>('control/auth/login', { email, password });
    setToken(res.token);
    setOperator(res.operator);
  }, []);

  const setup = useCallback(async (name: string, email: string, password: string) => {
    const res = await api.post<{ token: string; operator: Operator }>('control/setup', { name, email, password });
    setToken(res.token);
    setOperator(res.operator);
    setInitialized(true);
  }, []);

  const logout = useCallback(() => {
    setToken('');
    setOperator(null);
  }, []);

  return (
    <AuthContext.Provider value={{ operator, initialized, loading, login, setup, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
