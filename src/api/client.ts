/* ConnectX Control API client. All calls go to the same origin under /api. */

const TOKEN_KEY = 'connectx.control.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
    ...((options.headers as Record<string, string>) || {})
  };
  const token = getToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api/${path.replace(/^\/+/, '')}`, { ...options, headers });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form })
};

/* ---------- typed shapes (mirrors the backend) ---------- */
export interface Operator {
  id: string; name: string; email: string; phone: string; address: string;
  admin_code?: string | null; active: boolean; created_at?: string | null;
  role?: 'owner' | 'operator'; operator_code?: string; last_login_at?: string | null;
}

export interface Release {
  id: string; package_name: string; title: string; description: string;
  version: string; version_code: number; mandatory: boolean; release_notes: string;
  apk_filename: string; apk_size_bytes: number; apk_r2_key?: string | null; apk_url?: string;
  published: boolean; download_available?: boolean; download_url?: string;
  created_at?: string; updated_at?: string;
}

export interface ActivityItem {
  id: string; actor_type: string; actor_label?: string | null; action: string;
  entity_type?: string | null; entity_id?: string | null; meta?: unknown; created_at: string;
}
