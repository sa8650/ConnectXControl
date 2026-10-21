# ConnectX Android and Control

ConnectX Android communicates independently with EMS and ConnectX Control.

## Direct SMS delivery to EMS

```text
EMS persistent SMS queue ↔ HTTPS ↔ ConnectX Android → selected physical SIM → recipient
```

EMS owns administrator/shop authorization, queue persistence, job claiming, and authoritative delivery results. The Android app signs in to EMS, sends SMS through the chosen SIM, and reports send/delivery outcomes directly to EMS.

## Separate monitoring copy to Control

```text
ConnectX Android → ConnectX Control API → Control D1
```

When ConnectX Android registers a shop/device directly with EMS, it automatically posts the same device, administrator/shop, selected SIM, app version, and status details to `https://connectxweb.pages.dev/api/telemetry/register`. Control returns a separate revocable device token for that EMS registration. No enrollment code or manual linking is required. The app uses that token to upload heartbeats and SMS status records to Control's database. SMS message bodies are never sent. Recipient numbers are stored in full as requested.

Control does not call EMS and is not a queue, gateway, retry service, or delivery dependency. If Control is offline, the app's local telemetry outbox retries later while SMS result reporting to EMS continues independently.

## Releases

The **Android devices** page mirrors EMS's Registered Android devices fields: device, shop/administrator, SIM, app, status, and last seen. The existing Control release channel publishes signed Android APKs and provides update check/download APIs. Keep the same package name and signing certificate for in-place app updates. See [`DEPLOY.md`](DEPLOY.md) for backups, database schema setup, and rollout.
