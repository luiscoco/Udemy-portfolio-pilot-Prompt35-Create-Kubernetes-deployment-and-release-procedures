-- Step 1 of 3. Run as a member of the Entra administrator group, connected to database `postgres`.
-- Maps each runtime managed identity (by object ID) to a PostgreSQL login role of the same name.
-- Input: -v principals='id-pp-dev-api=<objectId>,id-pp-dev-ingestion=<objectId>,...'
--   (role name = managed identity name; objectId = its principalId from the deployment outputs).
-- Idempotent: existing roles are left as they are.
\set ON_ERROR_STOP on
SELECT set_config('pp.principals', :'principals', false) \g /dev/null

DO $$
DECLARE
  entry text;
  role_name text;
  object_id text;
BEGIN
  FOREACH entry IN ARRAY string_to_array(current_setting('pp.principals'), ',') LOOP
    role_name := split_part(entry, '=', 1);
    object_id := split_part(entry, '=', 2);
    IF role_name !~ '^id-[a-z0-9-]+$' OR object_id !~ '^[0-9a-f-]{36}$' THEN
      RAISE EXCEPTION 'Invalid principal entry %', entry;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      -- objectType 'service' = service principal / managed identity; not admin; no MFA claim.
      PERFORM pg_catalog.pgaadauth_create_principal_with_oid(role_name, object_id, 'service', false, false);
      RAISE NOTICE 'created Entra role %', role_name;
    END IF;
  END LOOP;
END $$;

SELECT rolname, principaltype, objectid FROM pg_catalog.pgaadauth_list_principals(false) ORDER BY rolname;
