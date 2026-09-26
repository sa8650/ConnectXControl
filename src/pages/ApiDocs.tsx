import React from 'react';
import { Card, CopyButton, PageHead } from '../components/ui';

const ORIGIN = typeof window !== 'undefined' ? window.location.origin : 'https://connectx.example.com';

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
        subtitle="How any product — EMS, CareOS, InfluenceOS, PlugX or your next app — integrates with ConnectX."
      />

      <Card title="1 · Authentication">
        <div className="doc">
          <p>
            Every request carries an API key issued under <strong>Apps &amp; API Keys</strong>. Keys may be scoped to one
            workspace or allowed for all, and enforce a daily message limit. Send the key in a header:
          </p>
          <pre className="code">{`X-ConnectX-Key: cxk_live_XXXXXXXXXXXXXXXX

<span class="c"># (Authorization: Bearer cxk_live_... also works)</span>`}</pre>
          <p>
            Identify the target workspace with its <span className="mono">code</span> (see Workspaces page) in the{' '}
            <span className="mono">workspace</span> field — required for all-workspace keys, optional for scoped keys.
          </p>
        </div>
      </Card>

      <Card title="2 · Send SMS" actions={<CopyButton value={`${ORIGIN}/api/client/v1/sms`} label="Copy endpoint" />}>
        <div className="doc">
          <Ep method="POST" path="/api/client/v1/sms">Queue one SMS. A paired Android gateway in that workspace claims and dispatches it through its SIM.</Ep>
          <pre className="code">{`curl -X POST ${ORIGIN}/api/client/v1/sms \\
  -H "X-ConnectX-Key: cxk_live_XXXX" -H "content-type: application/json" \\
  -d '{
    "workspace": "DHAKA-MAIN",
    "to": "+8801712345678",
    "recipient_name": "Rahim Uddin",
    "message": "Hi Rahim, thanks for your purchase at Dhaka Main. Invoice INV-0042: total BDT 5,400.00.",
    "message_type": "SALE",
    "reference_id": "9f2c-...",          <span class="c">// your internal id (opaque)</span>
    "reference_number": "INV-0042",      <span class="c">// human-readable (opaque)</span>
    "idempotency_key": "SALE:INV-0042"   <span class="c">// optional: dedupe retries</span>
  }'

<span class="c"># → 201 {"ok":true,"job_id":"...","status":"queued","workspace":"DHAKA-MAIN"}</span>`}</pre>
          <p>
            Instead of <span className="mono">message</span> you may send a known{' '}
            <span className="mono">event_type</span> (<span className="mono">SALE, PAYMENT, DUE_REMINDER, RETURN,
            EXCHANGE, REFUND, TEST</span>) with amount fields — ConnectX renders the workspace template.
          </p>
          <Ep method="POST" path="/api/client/v1/sms/bulk">Up to 100 messages per call: <span className="mono">{'{"workspace":"...","messages":[{to,message,...}]}'}</span>.</Ep>
        </div>
      </Card>

      <Card title="3 · Track & cancel jobs">
        <div className="doc">
          <Ep method="GET" path="/api/client/v1/sms/{job_id}">Job status: <span className="mono">queued → sending → sent | failed | cancelled</span>, attempts, error, timestamps.</Ep>
          <Ep method="GET" path="/api/client/v1/sms?status=queued&limit=50">List this key's jobs (newest first).</Ep>
          <Ep method="POST" path="/api/client/v1/sms/{job_id}/cancel">Cancel while still <span className="mono">queued</span> (409 once a gateway claimed it).</Ep>
          <Ep method="GET" path="/api/client/v1/stats?workspace=DHAKA-MAIN">Today's sent/failed/pending counters for SMS + email.</Ep>
          <Ep method="GET" path="/api/client/v1/devices?workspace=DHAKA-MAIN">Online gateway devices for that workspace.</Ep>
          <h4>Webhooks (recommended)</h4>
          <p>
            Set an HTTPS webhook URL per app. ConnectX POSTs signed events so you never need to poll:
          </p>
          <pre className="code">{`POST https://your-app.example.com/hooks/connectx
x-connectx-event: job.sent            <span class="c">// job.sent | job.failed | job.cancelled</span>
x-connectx-signature: sha256=...      <span class="c">// HMAC of body (WEBHOOK_SIGNING_SECRET)</span>

{
  "event": "job.sent",
  "client_key": "ems",
  "job": {
    "id": "…", "channel": "sms", "status": "sent",
    "to_phone": "+8801712345678",
    "reference_id": "9f2c-…", "reference_number": "INV-0042",
    "error_message": null, "sent_at": "2026-09-26T10:12:00.000Z"
  }
}`}</pre>
        </div>
      </Card>

      <Card title="4 · Log email history">
        <div className="doc">
          <p>
            Apps that send email themselves (through their own provider) can record outgoing messages in ConnectX so
            gateway phones show unified history on their Email page:
          </p>
          <Ep method="POST" path="/api/client/v1/email">
            <span className="mono">{'{workspace, to_emails:[], cc_emails:[], subject, body_html, custom_body, status:"sent", reference_id, idempotency_key}'}</span>
          </Ep>
          <Ep method="PATCH" path="/api/client/v1/email/{job_id}">Update status later (<span className="mono">sent/failed</span>, error_message, provider_message_id).</Ep>
          <Ep method="GET" path="/api/client/v1/email?limit=30">List this key's email records.</Ep>
        </div>
      </Card>

      <Card title="5 · Gateway (device) API — used by the ConnectX Android app">
        <div className="doc">
          <p className="muted">
            Reference only — the phone app handles this automatically. Pairing produces a device token
            (<span className="mono">cxd_…</span>) used as a bearer token.
          </p>
          <Ep method="POST" path="/api/device/pair">{'{code, deviceName, androidVersion, appVersion, simCarrier, phoneNumber}'} → device token.</Ep>
          <Ep method="POST" path="/api/device/jobs/claim">Gateway claims queued SMS for its workspace (race-safe, re-queues stale jobs).</Ep>
          <Ep method="POST" path="/api/device/jobs/report">{'{jobId, status:"sent"|"failed", error?}'} — triggers client webhooks.</Ep>
          <Ep method="GET" path="/api/device/stats · /api/device/activity · /api/device/emails">Dashboard figures, history and email log for the phone UI.</Ep>
          <Ep method="GET" path="/api/public/releases/check?package=com.connectx.gateway&versionCode=18">Public update check served by this website.</Ep>
        </div>
      </Card>

      <Card title="6 · Errors & limits">
        <div className="doc">
          <pre className="code">{`401  missing/unknown API key        403  key revoked, client disabled, workspace paused
404  workspace not found             409  duplicate idempotency / cancel race
429  daily limit reached             503  storage misconfigured (releases upload)`}</pre>
          <p>
            All responses are JSON: <span className="mono">{'{"error": "message"}'}</span> on failure.
            Rate behaviour: bulk ≤ 100/call; job list ≤ 200; daily limit per API key configurable.
          </p>
        </div>
      </Card>
    </>
  );
}
