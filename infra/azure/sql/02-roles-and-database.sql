-- Step 2 of 3. Run as the server's local administrator (non-superuser, CREATEROLE/CREATEDB),
-- connected to database `postgres`.
-- Inputs:
--   -v database=portfolio_pilot
--   -v migrator_verifier='SCRAM-SHA-256$4096:...'  (from infra/azure/scripts/scram-verifier.mjs;
--      the plaintext password never reaches the server or its logs)
--   -v runtime_roles='id-pp-dev-api,id-pp-dev-ingestion,id-pp-dev-outbox,id-pp-dev-agent'
-- Creates: pp_runtime (NOLOGIN group with DML only), pp_migrator (owns the database and schema),
-- and the database itself. Idempotent; re-running rotates the migrator password.
\set ON_ERROR_STOP on
SELECT set_config('pp.runtime_roles', :'runtime_roles', false) \g /dev/null
SELECT set_config('pp.migrator_verifier', :'migrator_verifier', false) \g /dev/null

DO $$
DECLARE
  role_name text;
BEGIN
  IF current_setting('pp.migrator_verifier') !~ '^SCRAM-SHA-256\$4096:' THEN
    RAISE EXCEPTION 'migrator_verifier must be a SCRAM-SHA-256 verifier, not a password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pp_runtime') THEN
    CREATE ROLE pp_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pp_migrator') THEN
    EXECUTE format('CREATE ROLE pp_migrator LOGIN PASSWORD %L', current_setting('pp.migrator_verifier'));
  ELSE
    EXECUTE format('ALTER ROLE pp_migrator PASSWORD %L', current_setting('pp.migrator_verifier'));
  END IF;
  FOREACH role_name IN ARRAY string_to_array(current_setting('pp.runtime_roles'), ',') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      RAISE EXCEPTION 'Runtime role % does not exist: run 01-entra-principals.sql first', role_name;
    END IF;
    EXECUTE format('GRANT pp_runtime TO %I', role_name);
  END LOOP;
END $$;

-- PostgreSQL 16+: the creator holds ADMIN OPTION but needs membership to create objects owned by,
-- or set default privileges for, the migration role.
GRANT pp_migrator TO CURRENT_USER;

SELECT format('CREATE DATABASE %I OWNER pp_migrator ENCODING ''UTF8''', :'database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database') \gexec
