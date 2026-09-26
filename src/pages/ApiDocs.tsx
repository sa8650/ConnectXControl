import React from 'react';
import { Card, CopyButton, PageHead } from '../components/ui';

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'https://connectxweb.pages.dev';

/** Static code block. Content is authored in this file only (no user input),
    so rendering the embedded <span class="c"> comment markup is safe. */
function Code({ children }: { children: string }) {
  return <pre className="code" dangerouslySetInnerHTML={{ __html: children }} />;
}

function Ep({ method, path, children }: { method: string; path: string; children?: React.ReactNode }) {
  return (
    <>
      <div className="endpoint">
        <span className={`method ${method.toLowerCase()}`}>{method}</span>
        <span className="mono">{path}</span>
      </div>
      {children && <p>{children}</p>}
    </>
  );
}

export default function ApiDocs() {
  return (
    <>
      <PageHead
        title="Client API Docs"
        subtitle="How any system — EMS, CareOS, InfluenceOS, PlugX or your next product — integrates with ConnectX."
      />

      <Card title="1 · Authentication & shops">
        <div className="doc">
          <p>
            Every request carries an API key issued under <strong>Systems &amp; API Keys</strong>. A key belongs to one
            system and enforces a daily message limit. Send the key in a header:
          </p>
          <Code>{`X-ConnectX-Key: cxk_live_XXXXXXXXXXXXXXXX

<span class="c"># (Authorization: Bearer cxk_live_... also works)</span>`}</Code>
          <p>
            Every message targets a <strong>shop</strong> with the <span className="mono">shop</span> field — the
            shop's id inside your system (its external id), its ConnectX uuid, or its shop_code. Shops normally sync
            automatically when an administrator signs in on the ConnectX phone app; an unknown{' '}
            <span className="mono">shop</span> value is registered on first use (pass{' '}
            <span className="mono">shop_name</span> to set its display name).
          </p>
        </div>
      </Card>

      <Card title="2 · Send SMS" actions={<CopyButton value={`${ORIGIN}/api/client/v1/sms`} label="Copy endpoint" />}>
        <div className="doc">
          <Ep method="POST" path="/api/client/v1/sms">Queue one SMS. A paired Android gateway of that shop claims and dispatches it through its SIM.</Ep>
          <Code>{`curl -X POST ${ORIGIN}/api/client/v1/sms \\
  -H "X-ConnectX-Key: cxk_live_XXXX" -H "content-type: application/json" \\
  -d '{
    "shop": "store-42",                  <span class="c">// your shop id (or ConnectX uuid / shop_code)</span>
    "shop_name": "Dhaka Main",           <span class="c">// optional: name used if the shop is new</span>
    "to": "+8801712345678",
    "recipient_name": "Rahim Uddin",
    "message": "Hi Rahim, thanks for your purchase at Dhaka Main. Invoice INV-0042: total BDT 5,400.00.",
    "message_type": "SALE",
    "reference_id": "9f2c-...",          <span class="c">// your internal id (opaque)</span>
    "reference_number": "INV-0042",      <span class="c">// human-readable (opaque)</span>
    "idempotency_key": "SALE:INV-0042"   <span class="c">// optional: dedupe retries</span>
  }'

<span class="c"># → 201 {"ok":true,"id":"...","job_id":"...","shop":"store-42","status":"queued","message":"✓ SMS queued for ConnectX"}</span>`}</Code>
          <p>
            Instead of <span className="mono">message</span> you may send a known{' '}
            <span className="mono">event_type</span> (<span className="mono">SALE, PAYMENT, DUE_REMINDER, RETURN,
            EXCHANGE, REFUND, TEST</span>) with amount fields — ConnectX renders the template from Settings,
            substituting <span className="mono">{'{shop}'}</span> with the shop's name.
          </p>
          <p>
            <strong>EMS-compatible:</strong> <span className="mono">/api/client/v1/sms/send</span> is an alias of{' '}
            <span className="mono">/sms</span>, and camelCase field names work everywhere —{' '}
            <span className="mono">storeId, toPhone, messageBody, recipientName, recipientType, messageType, invoiceId,
            invoiceNumber, idempotencyKey</span>. The same destination + body sent twice within 5 seconds is rejected
            with <span className="mono">409 Duplicate SMS detected</span>.
          </p>
          <Ep method="POST" path="/api/client/v1/sms/bulk">Up to 100 messages per call: <span className="mono">{'{"shop":"store-42","messages":[{to,message,...}]}'}</span> (per-message <span className="mono">shop</span> overrides allowed).</Ep>
        </div>
      </Card>

      <Card title="3 · Send email" actions={<CopyButton value={`${ORIGIN}/api/client/v1/email/send`} label="Copy endpoint" />}>
        <div className="doc">
          <p>
            ConnectX is the email gateway too. The provider (Brevo, Resend, SendGrid, Mailgun or Postmark) is
            configured <strong>once</strong> in Settings → Email sending; every connected system then delivers through
            this endpoint — no SMTP or provider setup inside the system itself. Sent mail is recorded here, shows up
            in Messages, and is readable on gateway phones and via <span className="mono">GET /email</span>.
          </p>
          <Ep method="POST" path="/api/client/v1/email/send">Deliver one email now (synchronous provider call).</Ep>
          <Code>{`curl -X POST ${ORIGIN}/api/client/v1/email/send \\
  -H "X-ConnectX-Key: cxk_live_XXXX" -H "content-type: application/json" \\
  -d '{
    "shop": "store-42",
    "to": "customer@example.com",        <span class="c">// string, list or comma-separated</span>
    "cc": ["accounts@example.com"],
    "subject": "Invoice INV-0042",
    "html": "&lt;p&gt;Thanks for your purchase…&lt;/p&gt;",  <span class="c">// html and/or body</span>
    "body": "Thanks for your purchase…",
    "from_name": "Dhaka Main",           <span class="c">// optional per-message sender name</span>
    "reply_to": "sales@example.com",     <span class="c">// optional</span>
    "reference_number": "INV-0042",
    "idempotency_key": "EMAIL:INV-0042"  <span class="c">// optional: dedupe retries</span>
  }'

<span class="c"># → 201 {"ok":true,"id":"...","shop":"store-42","status":"sent","provider_message_id":"...","message":"✓ Email sent via ConnectX"}</span>
<span class="c"># → 502 {"error":"..."} when the provider rejects it (the record is kept as failed)</span>`}</Code>
          <p>
            camelCase aliases work here too (<span className="mono">storeId, toEmails, bodyHtml, fromName, replyTo,
            idempotencyKey…</span>). The global daily email limit and the per-key daily limit both apply
            (<span className="mono">429</span>). Plain <span className="mono">body</span> text is safely wrapped
            into a simple HTML document when <span className="mono">html</span> is omitted.
          </p>
        </div>
      </Card>

      <Card title="4 · Track & cancel jobs">
        <div className="doc">
          <Ep method="GET" path="/api/client/v1/sms/{job_id}">Job status: <span className="mono">queued → sending → sent | failed | cancelled</span>, attempts, error, timestamps.</Ep>
          <Ep method="GET" path="/api/client/v1/sms?shop=store-42&status=queued&limit=50">List this key's jobs (newest first).</Ep>
          <Ep method="POST" path="/api/client/v1/sms/{job_id}/cancel">Cancel while still <span className="mono">queued</span> (409 once a gateway claimed it).</Ep>
          <Ep method="GET" path="/api/client/v1/stats?shop=store-42">Today's sent/failed/pending counters for SMS + email of one shop.</Ep>
          <Ep method="GET" path="/api/client/v1/devices?shop=store-42">Online gateway devices paired to that shop.</Ep>
          <h4>Webhooks (recommended)</h4>
          <p>
            Set an HTTPS webhook URL per system (Systems → Configure). ConnectX POSTs signed events so you never
            need to poll — the shop's external id lets you map the result back to your own record:
          </p>
          <Code>{`POST https://your-system.example.com/hooks/connectx
x-connectx-event: job.sent            <span class="c">// job.sent | job.failed | job.cancelled</span>
x-connectx-signature: sha256=...      <span class="c">// HMAC of body (WEBHOOK_SIGNING_SECRET)</span>

{
  "event": "job.sent",
  "system_key": "ems",
  "job": {
    "id": "…", "channel": "sms", "status": "sent",
    "shop_id": "…",                    <span class="c">// ConnectX shop uuid</span>
    "shop_external_id": "store-42",    <span class="c">// the shop id inside YOUR system</span>
    "shop_name": "Dhaka Main",
    "to_phone": "+8801712345678",
    "reference_id": "9f2c-…", "reference_number": "INV-0042",
    "error_message": null, "sent_at": "2026-09-27T10:12:00.000Z"
  },
  "sent_at": "2026-09-27T10:12:00.400Z"
}`}</Code>
        </div>
      </Card>

      <Card title="5 · Log email history (systems that send their own)">
        <div className="doc">
          <p>
            Systems that send email themselves (through their own provider) can record outgoing messages in ConnectX
            so gateway phones show unified history on their Email page:
          </p>
          <Ep method="POST" path="/api/client/v1/email">
            <span className="mono">{'{shop, to_emails:[], cc_emails:[], subject, body_html, custom_body, status:"sent", reference_id, idempotency_key}'}</span>
          </Ep>
          <Ep method="PATCH" path="/api/client/v1/email/{job_id}">Update status later (<span className="mono">sent/failed</span>, error_message, provider_message_id).</Ep>
          <Ep method="GET" path="/api/client/v1/email?shop=store-42&limit=30">List this key's email records for a shop.</Ep>
        </div>
      </Card>

      <Card title="6 · Gateway (device) API — used by the ConnectX Android app">
        <div className="doc">
          <p className="muted">
            Reference only — the phone app handles this automatically. The app talks to ConnectX only (built-in
            control URL); system credentials never live on the phone. Administrator sign-in is proxied through the
            system API URL configured on this website. Pairing or registering produces a device token
            (<span className="mono">cxd_…</span>) used as a bearer token.
          </p>
          <Ep method="GET" path="/api/device/systems">System dropdown list (key, name, available) — no API URLs exposed.</Ep>
          <Ep method="POST" path="/api/device/auth/login">{'{system:"ems", email, password}'} → ConnectX session + the administrator's shops (synced from the system).</Ep>
          <Ep method="GET" path="/api/device/shops">Re-sync and list the signed-in administrator's shops with their gateways.</Ep>
          <Ep method="POST" path="/api/device/register">{'{shopId, deviceName, androidVersion, appVersion, simCarrier, phoneNumber}'} → device token for the chosen shop.</Ep>
          <Ep method="POST" path="/api/device/pair">{'{code, deviceName, androidVersion, appVersion, simCarrier, phoneNumber}'} → device token (code from this console).</Ep>
          <Ep method="POST" path="/api/device/jobs/claim">Gateway claims queued SMS for its shop (race-safe, re-queues stale jobs).</Ep>
          <Ep method="POST" path="/api/device/jobs/report">{'{jobId, status:"sent"|"failed", error?}'} — triggers system webhooks.</Ep>
          <Ep method="GET" path="/api/device/stats · /api/device/activity · /api/device/emails">Dashboard figures, history and email log for the phone UI.</Ep>
          <Ep method="GET" path="/api/public/releases/check?package=com.connectx.gateway&versionCode=18">Public update check served by this website.</Ep>
        </div>
      </Card>

      <Card title="7 · Errors & limits">
        <div className="doc">
          <Code>{`401  missing/unknown API key        403  key revoked, system disabled, shop paused, email disabled
404  shop not registered (stats/devices)   409  duplicate within 5s / idempotency replay / cancel race
429  daily limit reached (key or global email)   502  email provider rejected or unconfirmed
503  system not configured for phone sign-in / email provider not configured / storage misconfigured`}</Code>
          <p>
            All responses are JSON: <span className="mono">{'{"error": "message"}'}</span> on failure.
            Rate behaviour: bulk ≤ 100/call; job list ≤ 200; daily limit per API key configurable.
          </p>
        </div>
      </Card>
    </>
  );
}
