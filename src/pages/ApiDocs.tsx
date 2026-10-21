import React from 'react';
import { Card, PageHead } from '../components/ui';

export default function ApiDocs() {
  return (
    <>
      <PageHead
        title="API documentation"
        subtitle="SMS delivery goes directly through EMS. ConnectX Android sends a separate monitoring copy to Control."
      />
      <Card title="Direct SMS delivery to EMS">
        <div className="doc">
          <p>
            EMS is the authoritative system for SMS authorization, the persistent queue, and delivery results. The
            ConnectX Android app authenticates directly to EMS over HTTPS, claims jobs atomically, sends through the
            selected physical SIM, and reports send and carrier-delivery results to EMS.
          </p>
          <p>
            The former Control SMS relay, API-key queue, and phone-gateway SMS routes are retired. Legacy{' '}
            <span className="mono">/connect</span>, phone SMS routes,{' '}
            <span className="mono">/api/client/v1/sms*</span>, pairing, and Control queue routes return HTTP 410.
            Do not configure Control as an SMS delivery endpoint.
          </p>
          <p className="muted">
            For EMS device API details, use the documentation shipped with the EMS deployment.
          </p>
        </div>
      </Card>
      <Card title="Independent Android monitoring to Control">
        <div className="doc">
          <p>
            When Android registers a device with EMS, it posts the registered device, shop/administrator, selected SIM,
            app version, status, and last-seen details directly to the Control API at{' '}
            <span className="mono">https://connectxweb.pages.dev</span>. Control issues a separate revocable device token
            automatically; no owner-generated code is required. Control saves the records in its own D1 database and never calls EMS.
          </p>
          <p>
            Monitoring uses <span className="mono">POST /api/telemetry/register</span> and{' '}
            <span className="mono">POST /api/telemetry/heartbeat</span>,{' '}
            <span className="mono">POST /api/telemetry/sms</span>, and{' '}
            <span className="mono">POST /api/telemetry/disconnect</span>. Subsequent requests use{' '}
            <span className="mono">Authorization: Bearer cxm_…</span>; this is not the EMS device credential.
            Initial registration is automatic. Telemetry is queued on the phone and cannot block SMS delivery or EMS reporting.
          </p>
          <p>
            Control stores SMS status, full recipient phone numbers, timestamps, and available delivery metadata, but
            never SMS message bodies. Control also retains its Android release check and download endpoints.
          </p>
          <p className="muted">
            Authenticated <span className="mono">/api/client/v1/email*</span> remains available for existing email
            integrations only. See <span className="mono">API.md</span> for route and data details.
          </p>
        </div>
      </Card>
    </>
  );
}
