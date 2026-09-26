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

/** An external product ConnectX integrates with (EMS, InfluenceOS, CareOS, PlugX…). */
export interface SystemInfo {
  id: string; system_key: string; name: string; description: string;
  api_url: string;
  /** 'api_key' = system public API with owner-stored platform key (EMS v1);
      'federated' = legacy admin-password login returning a system token. */
  auth_mode: 'federated' | 'api_key';
  api_key_set: boolean; api_key_hint: string;
  login_path: string; shops_path: string;
  webhook_url: string | null; status: 'active' | 'disabled';
  last_pull_at?: string | null; last_pull_error?: string | null;
  configured: boolean; shops: number; devices: number; created_at: string;
  usage30d?: { sent: number; failed: number; pending: number; cancelled: number };
  keys?: ApiKeyInfo[];
}

/** A shop/branch inside an external system. Devices pair to a shop; jobs belong to a shop. */
export interface Shop {
  id: string; system_id: string; external_id: string; name: string;
  shop_code: string; address: string; phone: string; category: string;
  status: 'active' | 'paused'; system_status: string;
  system_name?: string | null; system_key?: string | null;
  devices?: number; online?: number;
  created_at?: string; updated_at?: string;
}

export interface Device {
  id: string; device_public_id: string; device_name: string | null;
  android_version: string | null; app_version?: string | null;
  sim_subscription_id: string | null; sim_carrier: string | null; phone_number: string | null;
  status: 'pending_test' | 'active' | 'revoked'; is_primary: boolean;
  last_seen: string | null; created_at: string;
  shop_id: string; shop_name?: string | null; shop_external_id?: string | null;
  system_name?: string | null; system_key?: string | null;
  online?: boolean;
}

export interface Job {
  id: string; channel: 'sms' | 'email'; status: string;
  shop_id: string; shop_name?: string | null; shop_external_id?: string | null;
  system_id?: string | null; system_name?: string | null; system_key?: string | null;
  to?: string | null;
  to_phone?: string | null; to_emails?: string[] | null; subject?: string | null;
  recipient_name?: string | null; message_type?: string | null; event_type?: string | null;
  reference_id?: string | null; reference_number?: string | null; message_body?: string | null;
  device_id?: string | null; device_name?: string | null;
  attempts: number; max_attempts: number; error_message?: string | null;
  created_at: string; sent_at?: string | null; claimed_at?: string | null;
}

export interface ApiKeyInfo {
  id: string; label: string; key_prefix: string;
  daily_limit: number; status: 'active' | 'revoked';
  last_used_at: string | null; created_at: string;
}

export interface Release {
  id: string; package_name: string; title: string; description: string;
  version: string; version_code: number; mandatory: boolean; release_notes: string;
  apk_filename: string; apk_size_bytes: number; apk_r2_key?: string | null; apk_url?: string;
  published: boolean; download_available?: boolean; download_url?: string;
  created_at?: string; updated_at?: string;
}

export interface Carrier {
  id: string; carrier_name: string; carrier_identifier?: string | null;
  mcc_mnc?: string | null; balance_ussd_code?: string | null;
  balance_pattern?: string | null; active: number | boolean;
}

export interface ActivityItem {
  id: string; actor_type: string; actor_label?: string | null; action: string;
  entity_type?: string | null; entity_id?: string | null; meta?: unknown; created_at: string;
}

export interface Dashboard {
  today: { smsSent: number; smsFailed: number; smsPending: number; emailSent: number; emailFailed: number; emailPending: number };
  devices: { total: number; online: number; pendingTest: number };
  shops: { total: number; active: number };
  systems: { total: number; active: number; connected: number };
  bySystem: Record<string, { sent: number; failed: number; pending: number }>;
  recentJobs: Array<{
    id: string; channel: string; status: string; to: string; recipient_name: string | null;
    message_type: string | null; system_name: string; shop_name: string | null;
    shop_external_id: string | null; created_at: string; sent_at: string | null;
  }>;
}
