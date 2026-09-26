# ConnectX Control — API Reference

Base URL: your deployment, officially **`https://connectxweb.pages.dev`** (built into the
Android app). All endpoints live under `/api/` and answer JSON.

| Namespace | Auth | Consumer |
|---|---|---|
| `/api/client/v1/*` | `X-ConnectX-Key: cxk_live_…` | external systems (EMS, CareOS, InfluenceOS, PlugX, …) |
| `/api/device/*` | public system list → admin session → device token `cxd_…` / pairing code | ConnectX Android gateway |
| `/api/control/*` | owner/operator bearer session | this website |
| `/api/public/*` | none | update checks, APK downloads, health |

---

## 1. Client API (systems → ConnectX)

### Authentication

Keys are issued in **Systems & API Keys** (owner only). A key belongs to one **system**
and enforces a daily message limit (SMS + email jobs created). Send it as:

```
X-ConnectX-Key: cxk_live_XXXXXXXXXXXXXXXX
# (Authorization: Bearer cxk_live_... also works)
```

### Shops

Every message targets a **shop** via the `shop` field — the shop's id **inside your
system** (its external id), its ConnectX uuid, or its `shop_code`. Shops normally sync
automatically when one of your administrators signs in on the ConnectX phone app; an
unknown `shop` value is **auto-registered** on first use (send `shop_name` to set its
display name). Jobs, stats, devices and email history are all shop-scoped.

### POST /api/client/v1/sms

Queue one SMS. A paired Android gateway of that shop claims and dispatches it through its
SIM. (`POST /api/client/v1/sms/send` is an alias — EMS-style call sites keep their path.)

```jsonc
{
  "shop": "store-42",                  // required: your shop id / ConnectX uuid / shop_code
  "shop_name": "Dhaka Main",           // optional: display name if the shop is new
  "to": "+8801712345678",              // required (aliases: toPhone, phone)
  "recipient_name": "Rahim Uddin",
  "message": "Hi Rahim, thanks for your purchase…",
  "message_type": "SALE",              // or event_type; aliases: messageType
  "reference_id": "9f2c-…",            // your internal id (opaque, returned in webhooks)
  "reference_number": "INV-0042",      // human-readable (opaque; alias invoiceNumber)
  "idempotency_key": "SALE:INV-0042"   // optional: dedupe retries
}
```

→ `201 {"ok":true,"id":"…","job_id":"…","shop":"store-42","status":"queued","message":"✓ SMS queued for ConnectX"}`

- **camelCase aliases everywhere:** `storeId/shopId`, `toPhone`, `messageBody`,
  `recipientName`, `recipientType`, `messageType`, `invoiceId`, `invoiceNumber`,
  `referenceId`, `referenceNumber`, `idempotencyKey`.
- **Templates:** omit `message` and send `event_type` (`SALE, PAYMENT, DUE_REMINDER,
  RETURN, EXCHANGE, REFUND, TEST`) + amount fields (`total, paid, due, amount, currency,
  name, invoice`) — ConnectX renders the platform template, substituting `{shop}` with
  the shop's name.
- **Duplicate guard:** the same destination + body within 5 seconds → `409 Duplicate SMS
  detected`. An `idempotency_key` replay returns the original job with
  `{"duplicate":true}`.

### POST /api/client/v1/sms/bulk

```jsonc
{ "shop": "store-42", "messages": [ { "to": "+880…", "message": "…" }, … ] }  // ≤ 100
```
Per-message `shop` overrides are allowed. → `{created, duplicate, failed, jobs:[…]}`.

### Tracking & cancellation

| Endpoint | Purpose |
|---|---|
| `GET /api/client/v1/sms/{job_id}` | `{id, channel, shop, shop_name, status, to_phone, recipient_name, message_type, event_type, reference_id, reference_number, attempts, max_attempts, error_message, created_at, sent_at}` |
| `GET /api/client/v1/sms?shop=&status=&limit=&offset=` | List this key's jobs (newest first, `{items, hasMore}`) |
| `POST /api/client/v1/sms/{job_id}/cancel` | Cancel while `queued` (409 once a gateway claimed it) |
| `GET /api/client/v1/stats?shop=` | Today's `{sms:{sent,failed,pending}, email:{…}}` for one shop |
| `GET /api/client/v1/devices?shop=` | Online gateway devices paired to that shop |
| `GET /api/client/v1/ping` | Key check → `{ok, system:{key,name}, …}` |

Statuses: `queued → sending → sent | failed | cancelled`.

### POST /api/client/v1/email/send — ConnectX delivers the email

The provider (Brevo, Resend, SendGrid, Mailgun, Postmark) is configured **once** in
Settings → Email; no SMTP setup inside your system.

```jsonc
{
  "shop": "store-42",
  "to": "customer@example.com",        // string, list or comma-separated (alias toEmails)
  "cc": ["accounts@example.com"],
  "subject": "Invoice INV-0042",
  "html": "<p>Thanks…</p>",            // html and/or body (aliases bodyHtml, customBody)
  "body": "Thanks…",                   // plain text is safely wrapped into HTML
  "from_name": "Dhaka Main",           // optional per-message sender name
  "reply_to": "sales@example.com",
  "reference_number": "INV-0042",
  "idempotency_key": "EMAIL:INV-0042"
}
```

→ `201 {"ok":true,"id":"…","shop":"store-42","status":"sent","provider_message_id":"…","message":"✓ Email sent via ConnectX"}`
→ `502 {"error":"…"}` when the provider rejects it (the record is kept as `failed`).
A global daily email limit and the per-key daily limit both apply (`429`).

### Email history (systems that send their own)

| Endpoint | Purpose |
|---|---|
| `POST /api/client/v1/email` | Log an outgoing record: `{shop, to_emails:[], cc_emails:[], bcc_emails:[], subject, body_html, custom_body, status:"sent", reference_id, reference_number, idempotency_key}` |
| `PATCH /api/client/v1/email/{job_id}` | Update `status` (`sent/failed`), `error_message`, `provider_message_id` |
| `GET /api/client/v1/email?shop=&limit=&offset=` | This key's email records for a shop |

Gateway phones show this history read-only on their Email page (shop-scoped).

### Webhooks (delivery results → your system)

Set an HTTPS webhook URL per system (**Systems → Configure**). ConnectX POSTs events as
jobs reach `sent`, `failed` or `cancelled` — the `shop_external_id` maps the result back
to your own shop record:

```jsonc
POST https://your-system.example.com/hooks/connectx
x-connectx-event: job.sent            // job.sent | job.failed | job.cancelled
x-connectx-signature: sha256=…        // HMAC-SHA256 of the raw body (WEBHOOK_SIGNING_SECRET)

{
  "event": "job.sent",
  "system_key": "ems",
  "job": {
    "id": "…", "channel": "sms", "status": "sent",
    "shop_id": "…",                    // ConnectX shop uuid
    "shop_external_id": "store-42",    // the shop id inside YOUR system
    "shop_name": "Dhaka Main",
    "to_phone": "+8801712345678",
    "to_emails": null,
    "recipient_name": "Rahim Uddin",
    "message_type": "SALE", "event_type": null,
    "reference_id": "9f2c-…", "reference_number": "INV-0042",
    "error_message": null, "sent_at": "2026-09-27T10:12:00.000Z"
  },
  "sent_at": "2026-09-27T10:12:00.400Z"
}
```

HTTPS only; private/loopback IPs are blocked; 8 s timeout; failures are logged, never
retried into your face (poll `GET /sms/{id}` as a fallback).

---

## 2. Device API (ConnectX Android app)

The app talks **only** to ConnectX — the official address is built into the APK. System
API URLs and administrator credentials never live on the phone: sign-in is proxied
server-side to the system's own API (owner-configured URL).

### Before pairing

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET device/systems` | — | `{systems:[{id,key,name,available}]}` — the sign-in dropdown. `available` = the owner set an API URL. URLs are never exposed. |
| `POST device/auth/login` | — | `{system:"ems", email, password}` → ConnectX calls the system's admin-login endpoint → `{token, admin, administrator, system, shops:[…]}`. Wrong credentials pass the system's own error through (401/403). |
| `GET device/shops` | admin | Re-sync from the system + `{administrator, system, shops:[{id, external_id, name, shop_code, address, phone, category, status, system_status, connected, devices:[…]}]}` |
| `POST device/register` | admin | `{shopId, deviceName, androidVersion, appVersion, simSubscriptionId, simCarrier, phoneNumber}` → `{device, deviceToken, shop, system, administrator}` |
| `POST device/pair` | — | Account-free: `{code, deviceName, androidVersion, appVersion, simSubscriptionId, simCarrier, phoneNumber}` → same shape (`administrator` may be null). Codes: `4F7K-9Q2M`, single use, per shop, generated in Gateways. |

Admin sessions expire with the system's own session; `device/shops` then answers 401 and
the app returns to sign-in.

### Paired device (bearer `cxd_…`)

| Endpoint | Purpose |
|---|---|
| `GET device/me` | `{device, shop, system, administrator, connectedShopIds}` |
| `POST device/heartbeat` | Liveness (`last_seen`), optional `{deviceName, appVersion, smsEnabled}` patch |
| `POST device/jobs/claim` | `{limit≤20}` → `{jobs:[{id, shop_id, shop_external_id, system_key, phone_number, message, event_type, message_type, recipient_name, invoice_id, reference_id, reference_number, created_at, attempts}]}`; race-safe; re-queues jobs stuck `sending` > 10 min |
| `POST device/jobs/report` | `{jobId, status:"sent"|"failed", error?}` → fires the system webhook |
| `POST device/jobs/cancel` / `DELETE device/jobs/{id}` | Cancel while `queued` (409 once claimed) |
| `POST device/test` | `{ok, to?, message?, record?}` — mark setup test and/or queue a real test SMS |
| `PATCH device/sim` | `{simSubscriptionId, simCarrier, phoneNumber}` |
| `GET device/sim-carrier?mccMnc=&carrierName=` | Owner-managed balance USSD lookup → `{supported, carrier:{carrier_name, balance_ussd_code, balance_pattern}}` |
| `GET device/stats?utcOffsetMinutes=` | `{sent, failed, pending, lastActivity, device, shop, system, administrator}` (today) |
| `GET device/activity?range=today|7d|30d` | Last 250 SMS rows of this shop |
| `GET device/emails?page=&snapshot=` | Paginated (30/page) outgoing email history of this shop — `{items, page, hasMore, snapshot}` |
| `GET device/emails/stats` | `{sent, failed, pending, latest}` |
| `GET device/emails/{uuid}` | Full detail incl. `bcc_emails`, `custom_body`, `body_html` (rendered inert) |
| `POST device/disconnect` | Self-revoke this device |

Paused shops answer `403` on device routes; revoked device tokens die instantly.

---

## 3. Control API (this website)

Bearer session from `POST control/auth/login` (or first-run `control/setup`).
Roles: **owner** = everything (systems, API URLs, keys, releases, accounts, email
provider); **operator** = day-to-day (shops, gateways, jobs, carriers, settings SMS).

| Group | Endpoints |
|---|---|
| Bootstrap | `GET control/bootstrap` · `POST control/setup` · `POST control/auth/login` · `PATCH control/auth/profile` · `PATCH control/auth/password` · `POST control/auth/logout` |
| Dashboard | `GET control/dashboard?utcOffsetMinutes=` → today counters, devices, shops, systems (incl. `connected`), `bySystem`, recent jobs |
| Systems | `GET|POST control/systems` · `PATCH|DELETE control/systems/{id}` (name, description, `api_url`, `login_path`, `shops_path`, `webhook_url`, status; DELETE blocked while jobs/devices exist) · `POST control/systems/{id}/keys` (owner; key shown once) · `POST control/keys/{id}/revoke` |
| Shops | `GET control/shops?system_id=&status=&search=` (with device/online counts) · `POST control/shops` (manual pre-registration) · `PATCH control/shops/{id}` (name, shop_code, status) · `DELETE control/shops/{id}` (blocked while devices/history exist) |
| Gateways | `GET control/devices?shop_id=` · `POST control/devices/pairing-code {shop_id, ttl_minutes}` · `POST control/devices/{id}/revoke|restore|primary|rename` |
| Jobs | `GET control/jobs?channel=&status=&shop_id=&system_id=&search=&since=&limit=&offset=` · `POST control/jobs` (manual send `{shop_id,to,message}`) · `POST control/jobs/{id}/cancel|retry` |
| Releases | `GET|POST control/releases` · `POST control/releases/{id}/upload` (multipart APK → R2) · `DELETE control/releases/{id}` |
| Carriers | `GET|POST control/carriers` · `PATCH|DELETE control/carriers/{id}` |
| Settings | `GET|PATCH control/settings` — global `sms` `{enabled, templates}` |
| Email | `GET|PATCH control/email` (provider config, key masked) · `POST control/email/test` (owner) |
| Accounts | `GET|POST control/operators` · `PATCH control/operators/{id}` |
| Activity | `GET control/activity?limit=&offset=` (audit trail) |

---

## 4. Public API (no auth)

| Endpoint | Purpose |
|---|---|
| `GET public/health` | `{ok, service, time}` |
| `GET public/releases?package=` | Published release list |
| `GET public/releases/check?package=&versionCode=` | `{ok, hasUpdate, latestVersion, versionCode, mandatory, downloadUrl, apk_filename, apk_size_bytes, releaseNotes, updated_at}` |
| `GET public/releases/download/{package}` | APK bytes from R2 (or 302 to a vetted external HTTPS URL) |

---

## 5. Errors & limits

| Status | Meaning |
|---|---|
| 400 | validation (phone, email, message, `shop` missing, USSD format…) |
| 401 | missing/unknown API key, bad session, expired admin session |
| 403 | revoked key, disabled system, paused shop, email disabled, role violation |
| 404 | shop not registered (stats/devices endpoints), job/release not found |
| 409 | duplicate within 5 s, idempotency replay on a different body, cancel race |
| 429 | daily limit reached (per key, or global email limit) |
| 502 | email provider rejected/unconfirmed, system API unreachable for login/sync |
| 503 | system not configured (phone sign-in), email provider not configured, storage misconfigured |

Rate behaviour: bulk ≤ 100/call; job lists ≤ 200; email pages = 30; daily limits
configurable per key (`DEFAULT_DAILY_LIMIT` env or per-key override).

All failures answer `{"error": "message"}`.
