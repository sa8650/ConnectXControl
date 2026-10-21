export type SmsState = 'processing' | 'sent' | 'delivered' | 'failed' | 'unknown' | 'cancelled';
export type MonitorRange = '24h' | '7d' | '30d' | 'all';

export interface MonitorUsers { active: number; registered: number }
export interface MonitorDevicesSummary {
  registered: number; online: number; active: number; offline: number; revoked: number;
}
export interface MonitorSmsSummary {
  total: number; processing: number; sent: number; delivered: number; failed: number;
  unknown: number; cancelled: number; unsuccessful: number; recentErrors: MonitorSms[];
}
export interface MonitorSms {
  id: string; jobId: string; shopId: string; shopName: string;
  administratorId: string; administratorName: string; administratorCode: string;
  recipientPhone: string; recipientName: string; messageType: string; status: SmsState;
  attempts: number; error: string | null; createdAt: string | null; sentAt: string | null;
  deliveredAt: string | null; resultAt: string | null; appVersion: string; versionCode: number;
}
export interface MonitorDevice {
  id: string; adminId: string; administratorCode: string; administratorName: string;
  administratorEmail: string; shopId: string; shopName: string; deviceName: string;
  androidVersion: string; appVersion: string; versionCode: number; status: string;
  simSubscriptionId: string; simCarrier: string; phoneNumber: string; deviceStatus: string;
  online: boolean; lastSeen: string | null;
}
export interface MonitorOverview {
  range: MonitorRange; generatedAt: string; staleAfterSeconds: number;
  users: MonitorUsers; devices: MonitorDevicesSummary; sms: MonitorSmsSummary;
  mostRecentlySeen: MonitorDevice | null;
}
export interface MonitorDevicesPage {
  items: MonitorDevice[]; total: number; online: number; offset: number; limit: number;
  hasMore: boolean; serverTime: string;
}
export interface MonitorSmsPage {
  items: MonitorSms[]; total: number; offset: number; limit: number; hasMore: boolean;
  range: MonitorRange; serverTime: string;
}
