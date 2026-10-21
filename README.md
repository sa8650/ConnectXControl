# ConnectX Control

ConnectX Control manages app releases and stores monitoring telemetry reported directly by ConnectX Android. **Control does not connect to EMS.** The Android app remains connected to EMS for SMS delivery and separately connects to this website for monitoring and APK releases.

## Responsibilities

- Manage Control owner/operator accounts, settings, and audit activity.
- Store app-user/device heartbeats, app versions, and SMS result copies in Control D1.
- Display SMS shop, full recipient number, status, timestamps, and failure details (no message body).
- Publish and distribute signed ConnectX Android APK updates through Cloudflare Pages/R2.
- Preserve existing Control email-provider settings and compatibility routes.

## Three-system relationship

```text
                         ┌→ EMS (queue, authorization, delivery result source of truth)
ConnectX Android app ────┤
                         └→ ConnectX Control (monitoring copy + app releases)

EMS queue ↔ Android app → selected physical SIM → recipient
```

The app sends SMS results directly to EMS and sends an idempotent telemetry copy to Control using a separate revocable Control token. Device registration details are posted automatically to `https://connectxweb.pages.dev/api/telemetry/register`; no owner-generated enrollment code is needed. Control does not proxy, queue, claim, retry, or send SMS. A Control outage must not delay EMS delivery or reporting.

The dashboard defines active users as distinct EMS administrator IDs seen in the last 30 days and reports registered installs separately. SMS recipient phone numbers are stored in full as requested. SMS message bodies are not copied.

## Stack and hosting

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Backend | Cloudflare Pages Functions |
| Database | Cloudflare D1 binding `DB` |
| APK storage | Cloudflare R2 binding `APP_STORAGE` |
| Authentication | Operator sessions + separately issued Android telemetry tokens |
| App updates | Public release-check/download endpoints |

## Local development and verification

```bash
npm ci
npm test
npm run build
```

The comment-free database schema is `schema/connectx_schema.sql`. It creates tables needed by current website/email features and telemetry, and drops retired tables. Export D1 before `npm run db:reset:remote`; see [DEPLOY.md](DEPLOY.md).

## Deployment

See [DEPLOY.md](DEPLOY.md) for the cross-project rollout, database backup/reset procedure, and automatic Android monitoring registration. Do not point ConnectX Control at EMS or set an EMS monitor secret on the Control Pages project.

## API summary

- `/api/control/*`: authenticated Control management, local telemetry views, email settings, and release administration.
- `/api/telemetry/*`: automatic Android device registration, heartbeat, and SMS result copies authenticated by separate Control-issued device tokens.
- `/api/public/releases/*`: unauthenticated Android update check/download.
- Legacy SMS relay/queue/device/pairing writes: retired.
- Email-only `/api/client/v1/email*` and read-only `/api/device/emails*`: compatibility routes; no SMS jobs travel on them.
