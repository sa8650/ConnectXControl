# ConnectX API Reference

Base URL: your deployed ConnectX Control website, e.g. `https://connectx-control.pages.dev`.
All endpoints live under `/api/`. All request/response bodies are JSON (except APK
downloads and the release-upload multipart form). Errors: `{"error": "message"}` with a
meaningful HTTP status.

| Surface | Prefix | Auth |
|---|---|---|
| Control (website) | `/api/control/*` | `Authorization: Bearer <session token>` from login |
| Device (Android gateway) | `/api/device/*` | operator token, device token (`cxd_…`) or pairing code |
| Client (your products) | `/api/client/v1/*` | `X-ConnectX-Key: cxk_live_…` |
| Public | `/api/public/*` | none |

---

## 1. Client API — integrate EMS / CareOS / InfluenceOS / PlugX

### Authentication

```
X-ConnectX-Key: cxk_live_...        (or Authorization: Bearer cxk_live_...)
```

Keys are issued in **Apps & API Keys**. A key is either bound to one workspace or valid
for all (then every call must pass the workspace `code`). Each key has a daily job limit
(`429` when exceeded). Revoked keys and disabled clients get `403`.

### POST /api/client/v1/sms — queue one SMS

```json
{
  "workspace": "DHAKA-MAIN",          // workspace code; optional for scoped keys
  "to": "+8801712345678",             // required, digits/+ only
  "recipient_name": "Rahim Uddin",    // optional
  "recipient_type": "customer",       // optional label
  "recipient_id": "cus_123",          // optional, opaque
  "message": "Hi Rahim, thanks ...",  // required unless event_type template is used
  "message_type": "SALE",             // optional display type
  "event_type": "SALE",               // SALE|PAYMENT|DUE_REMINDER|RETURN|EXCHANGE|REFUND|TEST
  "reference_id": "uuid-or-int",      // your internal id, opaque passthrough
  "reference_number": "INV-0042",     // human-readable number, passthrough
  "total": 5400, "paid": 5000, "due": 400, "amount": 5000, "currency": "BDT",
                                      // template variables when using event_type
  "idempotency_key": "SALE:INV-0042"  // optional; duplicates return the original job
}
```

→ `201 {"ok":true,"id":"…","job_id":"…","status":"queued","workspace":"DHAKA-MAIN","message":"✓ SMS queued for ConnectX"}`
Duplicate (idempotency_key): `200 {"ok":true,"duplicate":true,"id":"…","job_id":"…","status":"…"}`

`POST /api/client/v1/sms/send` is an alias of this endpoint. All fields also accept
EMS-style camelCase: `toPhone, messageBody, recipientName, recipientType, messageType,
invoiceId, invoiceNumber, referenceId, referenceNumber, idempotencyKey, workspaceCode`.
Sending to the same destination twice within 5 seconds → `409 Duplicate SMS detected`
(anti double-click guard, same as EMS).

Templates: when `message` is omitted and `event_type` matches a workspace template
(Settings → SMS gateway & templates), ConnectX renders it with
`{name} {shop} {invoice} {total} {paid} {due} {amount} {currency}`.

### POST /api/client/v1/sms/bulk — up to 100 messages

```json
{ "workspace": "DHAKA-MAIN", "messages": [ { "to": "+880…", "message": "…" }, … ] }
```
→ `201 {"ok":true,"accepted":N,"results":[{ok,id,job_id}|{ok:false,error}, …],"message":"✓ Bulk SMS queued for ConnectX"}`

### GET /api/client/v1/sms/{job_id} — status

→ `{"id","channel","workspace_id","status","to_phone","recipient_name","message_type",
"event_type","reference_id","reference_number","attempts","error_message","created_at","sent_at"}`

Statuses: `queued → sending → sent | failed | cancelled`.

### GET /api/client/v1/sms?status=&limit= — list this key's jobs (≤200)

### POST /api/client/v1/sms/{job_id}/cancel

Only while `queued`; `409` once a gateway claimed it. → `{"ok":true,"cancelled":true}`

### POST /api/client/v1/email/send — deliver email through ConnectX

ConnectX is the email gateway: the provider is configured once on the website
(Settings → Email sending, owner only) and every app sends through this endpoint —
no SMTP/Brevo setup needed inside the app. Delivery is synchronous; the message is
recorded and visible in the website Messages page, the phone Email screen and
`GET /api/client/v1/email`.

```json
{
  "workspace": "DHAKA-MAIN",           // optional for scoped keys
  "to": "customer@example.com",        // required; string | array | comma-separated
  "cc": ["accounts@example.com"],      // optional
  "bcc": ["archive@example.com"],      // optional
  "subject": "Invoice INV-0042",       // required
  "html": "<p>…</p>",                  // html and/or body required
  "body": "plain text fallback",       // wrapped into simple HTML when html omitted
  "from_name": "Dhaka Main",           // optional; defaults to workspace/app name
  "reply_to": "sales@example.com",     // optional; defaults to platform Reply-To
  "recipient_name": "Rahim",           // optional, for history display
  "message_type": "INVOICE",           // optional display type (default EMAIL)
  "reference_id": "…", "reference_number": "INV-0042",
  "idempotency_key": "EMAIL:INV-0042"  // optional; duplicates return the original job
}
```

→ `201 {"ok":true,"id":"…","job_id":"…","status":"sent","provider_message_id":"…","message":"✓ Email sent via ConnectX"}`
Provider rejection / unconfirmed timeout: `502 {"error":"…"}` and the record is kept as `failed`.
Limits: global daily email limit (Settings) and per-key daily limit → `429`.
Disabled or unconfigured provider → `403` / `503`.

Supported providers (via their HTTP send APIs — Cloudflare Workers cannot open raw
SMTP sockets, and every major SMTP provider offers this equivalent):
**Brevo** (`BREVO_API_KEY`), **Resend** (`RESEND_API_KEY`), **SendGrid**
(`SENDGRID_API_KEY`), **Mailgun** (`MAILGUN_API_KEY` + domain), **Postmark**
(`POSTMARK_SERVER_TOKEN`). The API key can be stored in the website (D1, never
returned by any GET) or as an environment secret, which takes priority.
`MOCK_EMAIL=1` simulates successful delivery (local demos/tests).

### Email history (apps that send their own email)

Apps that deliver email through their own provider can mirror the outgoing record into
ConnectX so paired phones show unified history:

- `POST /api/client/v1/email`
  `{workspace, to_emails:[], cc_emails:[], bcc_emails:[], from_email, subject, body_html,
  custom_body, recipient_type, recipient_name, reference_id, status:"sent"|"queued"|"failed",
  error_message, provider_message_id, idempotency_key}` → `201 {ok, job_id, status}`
- `PATCH /api/client/v1/email/{job_id}` `{status, error_message, provider_message_id}`
- `GET /api/client/v1/email?limit=` — list

### GET /api/client/v1/ping · /stats · /devices

- `ping` → `{ok, client:{key,name}, scope, gateways:[{…,online}]}`
- `stats?workspace=&utcOffsetMinutes=` → today's `{sms:{sent,failed,pending}, email:{…}}`
- `devices?workspace=` → online gateway list for that workspace

### Webhooks

Set per app (Apps → Webhook). ConnectX POSTs on terminal transitions:

```
POST <your https url>
x-connectx-event: job.sent | job.failed | job.cancelled
x-connectx-signature: sha256=<hex HMAC of body>   (when WEBHOOK_SIGNING_SECRET is set)

{ "event":"job.sent", "client_key":"ems",
  "job": { "id","channel","workspace_id","status","to_phone","to_emails",
           "recipient_name","message_type","event_type","reference_id",
           "error_message","sent_at" },
  "sent_at":"…" }
```

Delivery is best-effort (8 s timeout, https only, private IPs rejected). Verify the
signature with your shared secret: `HMAC-SHA256(rawBody, WEBHOOK_SIGNING_SECRET)`.

---

## 2. Device API — used by the ConnectX Android gateway

### POST /api/device/auth/login
`{email, password}` (ConnectX Control account) → `{token, user:{id, admin_code, name,
email, phone, address, active, created_at}, role}` — 8 h operator token.

### GET /api/device/workspaces (operator token)
→ `{administrator:{…}, shops:[{id, name, address, phone, code, shop_code, connected}]}`

### POST /api/device/register (operator token)
`{storeId, deviceName, androidVersion, appVersion?, simSubscriptionId, simCarrier,
phoneNumber}` → `201 {device, deviceToken:"cxd_…", shop, administrator}`.
The first device of a workspace becomes **primary**; registering again adds a new device entry (previous entries keep working until revoked on the website).

### POST /api/device/pair (no auth — pairing code)
`{code, deviceName, androidVersion, appVersion?, simSubscriptionId, simCarrier,
phoneNumber}` → same response as register. Codes are single-use and expire
(5–1440 min, chosen on the website).

### Device-token routes (`Authorization: Bearer cxd_…`)

| Endpoint | Notes |
|---|---|
| `GET device/me` | `{device, shop, workspace, administrator, connectedStoreIds}` |
| `POST device/heartbeat` | `{ok, device, shop, administrator, smsEnabled}`; body may patch `deviceName/androidVersion/appVersion` |
| `POST device/jobs/claim` | `{limit≤20}` → `{jobs:[{id, shop_id, workspace_id, phone_number, message, event_type, message_type, recipient_name, invoice_id, reference_id, reference_number, client_key, client_name, created_at, attempts}]}`; re-queues jobs stuck `sending` >10 min |
| `POST device/jobs/report` | `{jobId, status:"sent"\|"failed", error?}` → `{ok,status}`; fires webhooks |
| `POST device/jobs/cancel` / `DELETE device/jobs/{id}` | queued-only, race-safe → `{ok,cancelled:true}` or `409` |
| `POST device/test` | `{ok, record?, phone?, message?}` → marks `active`/`pending_test`, optionally queues a test SMS |
| `PATCH device/sim` | `{simSubscriptionId, simCarrier, phoneNumber}` |
| `GET device/sim-carrier?mccMnc&carrierName` | → `{supported, carrier:{carrier_name, mcc_mnc, balance_ussd_code, balance_pattern}}` from the owner-managed catalog |
| `GET device/stats?utcOffsetMinutes` | `{sent, failed, pending, lastActivity, device, shop, administrator}` (local-day aware) |
| `GET device/activity?range=today\|7d\|30d` | `{shop_id, items:[≤250 rows]}` |
| `GET device/emails?page&snapshot` | `{items:[30], page, hasMore, snapshot}` — snapshot-stable pagination |
| `GET device/emails/stats` | `{sent, failed, pending, latest}` |
| `GET device/emails/{uuid}` | full detail incl. `bcc_emails, custom_body, body_html` |
| `POST device/disconnect` | self-revoke |

Paused workspaces answer `403` on device routes; revoked device tokens die instantly.

---

## 3. Public API

| Endpoint | Notes |
|---|---|
| `GET /api/public/health` | `{ok, service, time}` |
| `GET /api/public/releases/check?package=com.connectx.gateway&versionCode=18` | `{ok, hasUpdate, title, description, latestVersion, versionCode, mandatory, downloadUrl, apk_filename, apk_size_bytes, releaseNotes, updated_at}` · `404` when nothing published · `503` when the registered APK isn't downloadable |
| `GET /api/public/releases` | published listing with `download_available` |
| `GET\|HEAD /api/public/releases/download/{package}` | APK bytes from R2 or `302` to a vetted external HTTPS URL |

---

## 4. Control API — used by the website (operator/owner sessions)

`POST control/auth/login` · `GET control/auth/me` · `PATCH control/auth/password|profile`
`GET control/bootstrap` / `POST control/setup` (first-run owner creation)
`GET control/dashboard`
`GET|POST control/workspaces` · `PATCH|DELETE control/workspaces/{id}`
`GET control/devices` · `POST control/devices/pairing-code` · `POST control/devices/{id}/revoke|restore|primary|rename`
`GET|POST control/jobs` (filters: channel/status/workspace_id/client_id/search/since; paging limit/offset) · `POST control/jobs/{id}/cancel|retry`
`GET|POST control/clients` · `PATCH control/clients/{id}` · `POST control/clients/{id}/keys` (owner) · `POST control/keys/{id}/revoke` (owner)
`GET|POST control/releases` · `POST control/releases/upload` (multipart APK → R2) · `PATCH|DELETE control/releases/{id}` (owner)
`GET|POST control/carriers` · `PATCH|DELETE control/carriers/{id}`
`GET|PATCH control/settings` (per-workspace `sms` toggles/templates)
`GET|PATCH control/email` · `POST control/email/test` (owner only — provider, masked API key, from/reply-to, daily limit, enable switch, test send)
`GET|POST control/operators` · `PATCH control/operators/{id}` (owner)
`GET control/activity`

Roles: **owner** = everything; **operator** = workspaces, gateways, jobs, carriers,
settings (not clients/keys/releases/accounts).

---

## 5. Status & error codes

| Code | Meaning |
|---|---|
| 400 | validation (phone, message, workspace code, USSD format…) |
| 401 | missing/unknown credentials or API key |
| 403 | revoked key, disabled client, paused workspace, email disabled, role violation |
| 404 | workspace/job/release not found |
| 405 | wrong method |
| 409 | idempotency/cancel/claim race, duplicate code, 5-second SMS duplicate guard, version regression |
| 410 | expired pairing code |
| 422 | publish without downloadable APK |
| 429 | daily limit reached (per API key, or global email limit) |
| 502 | email provider rejected the message, or delivery unconfirmed (timeout) |
| 503 | email provider not configured, D1/R2/secret misconfiguration |
