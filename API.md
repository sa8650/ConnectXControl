# ConnectX client API — removed

`/api/client/v1` and `/api/device` (API keys, system URLs, device tokens)
have been removed. Products and the Android app use **Connect App**.

See [CONNECT_APP.md](CONNECT_APP.md).

The website session API (`/api/control/*`) and the public release check
(`/api/public/releases`) remain for this site and for app updates. The
Android update check uses the endpoint compiled into the app. It is not
shown on the phone.
