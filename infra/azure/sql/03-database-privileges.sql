-- Step 3 of 3. Run as the local administrator, connected to the application database.
-- Input: -v database=portfolio_pilot
-- Runtime identities get DML on application tables (current and future ones created by the
-- migrator) and nothing else: no DDL, no access to other databases. Idempotent.
\set ON_ERROR_STOP on
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO pp_runtime, pp_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO pp_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE pp_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pp_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE pp_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pp_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pp_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pp_runtime;

-- The migration ledger is the migrator's alone (no-op before the first migration).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM pp_runtime;
  END IF;
END $$;
