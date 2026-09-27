-- Existing databases: add the Android app version columns.
-- Safe to re-run; "duplicate column" errors can be ignored.
ALTER TABLE cx_phone_devices ADD COLUMN app_version TEXT;
ALTER TABLE cx_phone_devices ADD COLUMN version_code INTEGER;
ALTER TABLE cx_phone_devices ADD COLUMN android_version TEXT;
