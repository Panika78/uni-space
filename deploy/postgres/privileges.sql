-- Dedicated application cluster. Explicitly run for fresh AND existing volumes.
-- Avoid logging password-bearing statements even with verbose server defaults.
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
SET log_min_error_statement = 'panic';
\getenv api_password API_DB_PASSWORD
\getenv migration_password MIGRATION_DB_PASSWORD
BEGIN;
SELECT pg_advisory_xact_lock(220022);
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='uni_space_api'))
       OR EXISTS (SELECT FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='uni_space_api'))
       OR EXISTS (SELECT FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='uni_space_api')) THEN
        RAISE EXCEPTION 'API role unexpectedly owns objects; inspect before retrying';
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
               WHERE r.rolname IN ('uni_space_api', 'uni_space_migrator')) THEN
        RAISE EXCEPTION 'Reserved roles have unexpected memberships; inspect before retrying';
    END IF;
END $$;
SELECT 'CREATE ROLE uni_space_api' WHERE NOT EXISTS
    (SELECT FROM pg_roles WHERE rolname='uni_space_api') \gexec
SELECT 'CREATE ROLE uni_space_migrator' WHERE NOT EXISTS
    (SELECT FROM pg_roles WHERE rolname='uni_space_migrator') \gexec
ALTER ROLE uni_space_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE uni_space_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE uni_space_api PASSWORD :'api_password';
ALTER ROLE uni_space_migrator PASSWORD :'migration_password';
-- CONNECT is otherwise inherited from PUBLIC on every PostgreSQL database.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC, uni_space_api, uni_space_migrator', datname)
FROM pg_database WHERE datallowconn \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO uni_space_api, uni_space_migrator', current_database()) \gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC, uni_space_api;
ALTER SCHEMA public OWNER TO uni_space_migrator;
GRANT USAGE ON SCHEMA public TO uni_space_api;
-- Transfer only this database's application objects, never admin-owned shared objects.
SELECT format('ALTER TABLE public.%I OWNER TO uni_space_migrator', c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') \gexec
SELECT format('ALTER SEQUENCE public.%I OWNER TO uni_space_migrator', c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='S' \gexec
SELECT format('ALTER TYPE public.%I OWNER TO uni_space_migrator', t.typname)
FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname='public' AND t.typtype='e' \gexec
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, uni_space_api;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, uni_space_api;
-- No application routines are required by the current API. Include existing
-- functions/procedures, especially SECURITY DEFINER routines, in the deny policy.
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, uni_space_api;
SELECT format('GRANT SELECT ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public' AND tablename IN
    ('users','auth_sessions','refresh_tokens','students','alembic_version') \gexec
SELECT format('GRANT USAGE ON SEQUENCE %s TO uni_space_api',
              pg_get_serial_sequence(format('public.%I', tablename), 'id'))
FROM pg_tables WHERE schemaname='public' AND tablename IN
    ('auth_sessions','refresh_tokens') \gexec
-- Schema REVOKE cannot undo a global default GRANT: reset both levels.
-- Functions have PUBLIC EXECUTE even without an explicit default ACL row.
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
    REVOKE ALL ON TABLES FROM PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
    REVOKE ALL ON SEQUENCES FROM PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
    REVOKE ALL ON FUNCTIONS FROM PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator IN SCHEMA public
    REVOKE ALL ON TABLES FROM PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator IN SCHEMA public
    REVOKE ALL ON FUNCTIONS FROM PUBLIC, uni_space_api;
-- The only current API writes are session/token creation, rotation and revocation.
SELECT format('GRANT INSERT, UPDATE ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public' AND tablename IN ('auth_sessions','refresh_tokens') \gexec
-- SELECT FOR UPDATE in login requires UPDATE on at least one user column.
-- Grant only the immutable-by-API identifier, not password/role/active fields.
SELECT 'GRANT UPDATE (id) ON public.users TO uni_space_api'
WHERE to_regclass('public.users') IS NOT NULL \gexec
COMMIT;
