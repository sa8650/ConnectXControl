# Deploying ConnectX Control (EMS-direct migration)

ConnectX Control remains on the existing Cloudflare Pages + D1 + R2 infrastructure. The migration removes Control from SMS dispatch while retaining operator management, Control email-provider management, audit activity, Android app releases, and the new direct-from-Android monitoring copy stored in Control D1.

The consolidated `schema/connectx_schema.sql` is a reset-oriented, comment-free schema. It creates the tables required by the current Control website and email compatibility API, and drops retired SMS/pairing tables. The remote reset can permanently delete legacy records in those retired tables; export and review a D1 backup first. It does not remove R2 APK objects.

> The Android app uses two independent origins: the EMS origin compiled into the APK for sign-in and SMS delivery, and the Control origin (`https://connectxweb.pages.dev` by default) for monitoring telemetry and app releases. Control is not in the SMS delivery path.

## 1. Verify the existing deployment and back up

Before changing production:

1. Confirm the current Control Pages project, D1 database, R2 bucket, custom domains, and production bindings.
2. Export a D1 backup and retain it with the deployment record:
   ```bash
   npx wrangler d1 export connectx-control --remote --output=connectx-control-before-ems-direct.sql
   ```
3. Keep the existing R2 release bucket and preserve the signing key used for the installed Android app. A new APK must use the same package and signing certificate to update existing installations.
4. Inspect the backup before any reset. Keep the database ID, R2 bucket, and production bindings pointed at the intended project; the reset intentionally removes retired tables (`cx_workspaces`, `cx_clients`, `cx_admins`, `cx_devices`, `cx_pairing_codes`, `cx_sim_carriers`, `cx_connect_requests`, `cx_connect_jobs`, and obsolete `cx_monitor_enrollments`). It preserves active operator, email API, settings, audit, release, monitoring, and legacy email-history tables.

## 2. Apply and deploy EMS first

The EMS repository owns the SMS schema and direct-device API. Back up the EMS database, then apply the appropriate `066_connectx_direct_sms.sql` (Supabase) or `migration_connectx_direct_sms.sql` (Cloudflare D1) migration **once** to the matching database. Follow the EMS repository's environment-specific instructions; do not point the Android app at an un-migrated database.

The migration preserves historical rows, maps ambiguous legacy in-flight SMS to `unknown` (not an automatic resend), and adds direct-device token/claim/delivery metadata. Deploy the EMS code containing `/api/connectx/device/*` after the migration. Verify the EMS test suite and direct-device routes before enabling new app registrations.

## 3. Build and pilot the Android app

In the ConnectX Android repository, run the unit tests and builds serially with JDK 17+ and a compatible Android SDK. The EMS origin is a build property; the default is `https://ems-v1.pages.dev`:

```bash
./gradlew :app:testDebugUnitTest
./gradlew :app:assembleDebug
./gradlew :app:assembleRelease -PemsBaseUrl=https://ems.example.com
```

Replace the example host with the real EMS HTTPS origin.

Use the real EMS HTTPS origin for production. Do not set it to this Control site. Sign the release APK with the same signing certificate as the installed app.

Before retiring the old Control APIs:

1. Install the direct-EMS build on a pilot phone.
2. Sign in with an EMS administrator account, select an authorized shop and SIM, and complete device registration/test SMS.
3. Verify live queue, message history, device heartbeat, and delivery status in EMS while Control is unavailable to the phone's delivery flow.
4. Publish the signed APK through the currently deployed Control **App Releases** page. Keep the existing release-check and download endpoints active during rollout.
5. Allow the fleet to update and watch EMS registrations. Existing Control device/pairing tokens are not imported; the direct app registers a new device token with EMS.

The old Control backend should remain deployed until the active Android fleet has migrated. An old app that still depends on the Control relay will stop dispatching once the retirement is deployed; plan the maintenance window and ensure users can install the new APK first.

## 4. Connect app telemetry to Control

ConnectX Control does not call EMS. ConnectX Android continues to authenticate, poll, claim, send, and report SMS outcomes directly to EMS. Independently, the app posts its EMS device-registration details to the Control API at `https://connectxweb.pages.dev/api/telemetry/register`; Control stores its own monitoring copy in D1 and returns a separate revocable Control token. No owner-generated enrollment code or manual app linking is used. Control telemetry is queued on the phone and must never block EMS reporting or SMS delivery.

1. Deploy the Control Pages Function and initialize the D1 schema only after exporting and reviewing a backup.
2. Sign in to EMS and register the Android device as usual. ConnectX Android automatically sends the registered device, shop/administrator, selected SIM, app version, and setup status to the Control API.
3. Verify the record under **Android devices**. The page shows the same core fields as EMS Owner → SMS delivery → Registered Android devices: Device, Shop / administrator, SIM, App, Status, and Last seen.
4. The app sends status heartbeats and an idempotent copy of each SMS outcome to Control. SMS message bodies are never copied. Recipient phone numbers are stored in full in Control as requested; restrict D1 and operator access accordingly.

The Control dashboard counts active app users by distinct EMS administrator ID seen in the last 30 days and shows registered installs separately. Release checks/downloads continue through Control independently of EMS SMS delivery.

## 5. Build, test, and deploy Control UI/API

From this repository:

```bash
npm ci
npm test
npm run build
```

After reviewing and retaining the D1 export, initialize the intended D1 database using the single canonical SQL file:

```bash
npm run db:reset:local
# Only after confirming the backup and intended production D1 binding:
npm run db:reset:remote
```

`db:reset:remote` executes explicit `DROP TABLE IF EXISTS` statements for retired tables; it is intentionally named as a reset and must not be run before a backup. The canonical schema retains `cx_jobs` for the legacy email API but no longer creates the obsolete external-job index that may reference a column absent from older D1 databases. The reset does not drop active email/API/account/release tables or R2 objects. Deploy the resulting source through the existing Cloudflare Pages project. Keep these existing bindings/secrets:

| Binding/secret | Purpose |
|---|---|
| D1 `DB` | Control users, audit, settings, release metadata, and Android monitoring copies |
| R2 `APP_STORAGE` | Existing Android APK storage |
| `SESSION_SECRET` | Control owner/operator sessions |
| Android telemetry | App directly posts to the same-origin Control Pages API using a Control-issued device token |
| Email provider secret/config | Control's existing email provider and test-email feature |

After deploy, confirm the Control management pages load, email settings are present, the release page can list/download a release, and the dashboard/device/SMS-history pages show telemetry records saved in Control D1 after an Android app registers with EMS and syncs directly to Control. Verify monitoring reads return Control D1 data; app heartbeat and SMS telemetry writes require a valid Control-issued device token. Legacy `/api/device/emails*` plus email-only `/api/client/v1/email*` requests should reach their authentication checks (unauthenticated calls should return `401`, not `410`). Do not delete R2 release objects; the database reset does not remove them.

## 6. Validation checklist

### Automated checks

- EMS: `npm test` — run the full existing suite plus the direct-device/queue tests.
- Android (run serially): `./gradlew :app:testDebugUnitTest`, `./gradlew :app:assembleDebug`, and a signed `:app:assembleRelease` build before publishing.
- Control: `npm test && npm run build`.

### Staging/manual scenarios

- Direct delivery: enqueue in EMS; confirm the app claims the correct shop job, uses the selected SIM, reports `sent`, and only records `delivered` when carrier delivery confirmation is received.
- Duplicate/idempotency: repeat the same enqueue request and verify one EMS job is dispatched.
- Offline device: turn off network, queue a job, reconnect, and verify prompt polling/recovery without Control availability.
- Stale claims: exercise safe pre-send claim recovery and ambiguous post-send `unknown` handling; confirm no silent duplicate SMS.
- SIM selection/unavailable SIM: verify the configured subscription is used and the app never silently falls back to another SIM.
- Multi-shop authorization: a device for shop A cannot list, claim, or report shop B jobs.
- Control website outage: block Control while the app is authenticated to EMS; queue, claim, send, and report to EMS must continue. Restore Control and verify the local telemetry outbox syncs and release checks still work.
- Email: verify existing EMS email sending/history, Control provider settings/test, and the legacy phone email-history compatibility routes remain operational.
- App update: publish and install a higher-version signed APK using the retained release channel.

Real carrier delivery, SIM-specific behavior, and Android background execution require physical-device/carrier testing; do not treat local unit tests as proof of carrier delivery.

## 7. Rollback and data retention

- **Control UI/API:** retain the pre-deployment Pages build for a rapid rollback. Rolling Control back can re-enable its old relay routes; do so only as a deliberate temporary recovery measure and never route the new Android app through Control.
- **EMS code:** keep the previous EMS deployment artifact, but do not roll back schema after direct-device rows/tokens have been written without restoring a compatible database backup and coordinating the Android fleet.
- **Database:** the EMS migration is not a reason to delete queue/history tables. Keep a verified pre-migration backup. The D1 migration rebuilds the SMS table to widen its status constraint, so validate the backup before applying it and apply it only once.
- **Android:** keep the last signed release artifact and signing key. A subsequent rollback APK must use a valid higher version code; Android normally rejects downgrades.

## 8. Explicit non-actions

This workspace work does not apply production migrations, publish releases, modify Cloudflare bindings, perform a live deployment, or test a physical SIM/carrier. Those steps require the production owner and credentials.
