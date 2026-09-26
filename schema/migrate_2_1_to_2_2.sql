-- =====================================================================
-- ConnectX Control — upgrade script: 2.1 -> 2.2 (system public-API mode)
-- =====================================================================
-- Run this ONCE against a database created with the 2.1 schema, THEN
-- re-apply schema/connectx_schema.sql:
--
--   local :  npm run db:migrate22:local  &&  npm run db:local
--   remote:  npm run db:migrate22:remote &&  npm run db:remote
--
-- What 2.2 adds:
--   cx_systems.auth_mode        'federated' (legacy admin-password login)
--                               or 'api_key' (EMS Public API v1: emsk_ key)
--   cx_systems.api_key          the owner-issued platform key of the
--                               system (stored for server-side calls,
--                               NEVER returned by the ConnectX API)
--   cx_systems.last_pull_at     dispatch-loop state (api_key systems)
--   cx_systems.last_pull_error
--   cx_jobs.external_job_id     system-side id of PULLED SMS jobs; the
--                               delivery result is reported back to the
--                               system's /api/v1/sms/report endpoint
--
-- The seeded EMS system is switched to the v1 contract while its paths
-- are still the legacy defaults (customized paths are left alone).
--
-- On a database that already ran this file, every statement fails with
-- "duplicate column" — that is expected and harmless; the file is only
-- meant to run once per database.
-- =====================================================================

ALTER TABLE cx_systems ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'federated';
ALTER TABLE cx_systems ADD COLUMN api_key TEXT NOT NULL DEFAULT '';
ALTER TABLE cx_systems ADD COLUMN last_pull_at TEXT;
ALTER TABLE cx_systems ADD COLUMN last_pull_error TEXT;

ALTER TABLE cx_jobs ADD COLUMN external_job_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cx_jobs_external ON cx_jobs(system_id, external_job_id)
  WHERE external_job_id IS NOT NULL;

-- Seeded EMS rows still on the legacy default paths move to the EMS
-- Public API (v1). Any other system keeps its configured mode/paths.
UPDATE cx_systems
   SET auth_mode  = 'api_key',
       login_path = 'api/v1/auth/login',
       shops_path = 'api/v1/shops'
 WHERE system_key = 'ems'
   AND login_path = 'api/auth/admin/login'
   AND shops_path = 'api/connectx/gateway/shops';
