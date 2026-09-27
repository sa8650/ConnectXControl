# ConnectX Connect App

The API-key client API and the device-token API are removed. EMS,
InfluenceOS, CareOS, and the Android phone all use the same Connect App
endpoint:

```text
POST https://connectxweb.pages.dev/connect
```

The Android app has that address compiled into its backend. The phone UI
does not show or edit it. EMS never talks to the phone.

## Setup

1. Apply `schema/migrate_connect_app.sql` to the ConnectX D1 database.
2. Open **Connect App** on this website. Copy the Connect Endpoint.
3. On EMS (or another product), paste that endpoint and send a request.
4. Approve it here after the pairing codes match. Both sides show **Connected**.
5. Open the Android app, name the phone, and approve the code it shows.
6. On the phone, allow SMS and pick the physical SIM.

## SMS

```text
Product Connect Server
        │  signed SEND_SMS (Request ID)
        ▼
ConnectX Connect Server   status PENDING if the phone is offline
        │
        ▼
ConnectX Web
        │
        ▼
Android app → selected SIM → recipient
        │
        ▼
SUCCESS or FAILED returns on the same Request ID
```

A repeated Request ID is not sent twice. Either side can disconnect.
The protocol is not EMS-specific: any product that speaks Connect App can
connect later.

## Phone sign-in

The Android app does not pair and does not need approval. It opens a sign-in
screen. The system dropdown lists only products with an active Connect App
connection. If EMS is not connected, EMS is not listed.

The phone sends the administrator email or ID and password to ConnectX.
ConnectX asks EMS, over the signed Connect connection, to verify that
account. EMS returns the administrator and their shops. The password is not
stored. After that, shop selection, SIM selection, SMS, and email history
look the same as the previous app, but every call goes to ConnectX, not EMS.

