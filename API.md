# ConnectX Control API

ConnectX Android connects directly to EMS for authentication, SMS queue claims, send-result reporting, and carrier-delivery status. Separately, the app can connect to this Control website using a Control-issued device token and send monitoring telemetry. Control stores that copy in its own D1 database and never calls EMS.

## Website and monitoring routes

| Path | Purpose |
|---|---|
| `/api/control/auth/*` | Control operator sign-in, profile, and password management |
| `/api/control/operators` | Owner-managed Control accounts |
| `/api/control/activity` | Control audit activity |
| `/api/control/dashboard` | Dashboard aggregates from Control D1; supports `range=24h|7d|30d|all` |
| `/api/control/devices` | Paginated app installations and heartbeat/version details |
| `/api/control/jobs` | Paginated SMS status history saved in Control D1 |
| `/api/control/monitor/devices/:id/revoke` | Owner revokes a Control telemetry token |
| `/api/control/monitor/devices/:id/restore` | Owner restores a revoked monitoring token |
| `/api/control/email*` | Configure/test Control's email provider (owner only) |
| `/api/client/v1/email*` | Existing API-key-authenticated email sending/history only |
| `/api/control/releases*` | Publish/manage ConnectX Android releases |
| `/api/public/releases/check` and `/api/public/releases/download/*` | App update metadata/download; no authentication |
| `/api/health` | Service health metadata |

Control website routes require an operator session. When ConnectX Android registers a shop/device with EMS, the app independently posts the same registered device details to `https://connectxweb.pages.dev/api/telemetry/register`. Control automatically returns a separate random Control device token for that EMS device registration; the token hash is stored in D1, not the plaintext token. No owner-generated or user-entered enrollment code is used. Since Control must not call EMS and there is no manual approval code, this first registration is not cryptographically verified against EMS; it is a monitoring-only record, and Control cannot authorize SMS delivery.

## Android telemetry endpoints

- `POST /api/telemetry/register` — automatically stores an EMS device registration, selected SIM, administrator/shop, app build, status, and last-seen details; returns a separate Control device token.
- `POST /api/telemetry/heartbeat` — authenticated app/user/shop identity, selected SIM, app build, Android version, status, and last-seen time.
- `POST /api/telemetry/sms` — authenticated SMS status copy keyed by EMS job ID. Repeated and out-of-order status uploads are idempotent; later states do not downgrade delivered records.
- `POST /api/telemetry/disconnect` — revokes the app's Control telemetry token.

Every subsequent telemetry request uses `Authorization: Bearer cxm_…`. This token is separate from EMS `cxd_…` device credentials. SMS delivery results are still sent to EMS independently; the app's durable Control outbox retries telemetry when network access returns. Control telemetry is never a prerequisite for queue polling, sending, or EMS result reporting.

## Stored monitoring data

Control records distinct administrator IDs and EMS-registered device installations, including device name, shop, selected SIM carrier/number, app version, setup/online status, and last-seen time. SMS monitoring records contain the shop, full recipient phone number, recipient name when available, message/event type, status, attempts, timestamps, and a bounded error summary. The app does not transmit SMS message bodies. Full phone numbers are stored as requested; protect Control operator accounts and D1 access accordingly.

“Active users” means unique administrator IDs with a Control heartbeat in the last 30 days. Registered installations are shown separately. `failed` counts as unsuccessful; `unknown` remains separate because the device cannot confirm whether a possibly-started SMS was accepted or delivered.

## Retired routes

The former Control SMS relay, pairing, queue, and device-management write routes remain retired and return `410 Gone`. Control does not send or retry SMS. Legacy `/api/device/emails*` remains read-only for older installations, and `/api/client/v1/email*` remains email-only.

## Schema

The single comment-free canonical SQL file is `schema/connectx_schema.sql`. It creates the tables required by the current website, email compatibility routes, and local telemetry, and drops the listed retired tables. Back up D1 before `npm run db:reset:remote`; see `DEPLOY.md` for the reset list and rollout steps.
