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
    ('users','auth_sessions','refresh_tokens','students','alembic_version',
     'study_groups','programs','org_units','teachers','disciplines','course_offerings',
     'buildings','rooms','lessons','lesson_groups','lesson_rooms','subgroups',
     'service_types','applications','application_history','news','notifications',
     'academic_terms','course_groups',
     'assessments','assessment_groups','assessment_results','final_results',
     'staff_profiles','staff_permissions','teaching_assignments','user_preferences') \gexec
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
-- Explicit API write allowlist; history is append-only for the runtime role.
SELECT format('GRANT INSERT, UPDATE ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public' AND tablename IN ('auth_sessions','refresh_tokens','user_preferences') \gexec
SELECT format('GRANT INSERT ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public' AND tablename IN ('applications', 'application_history') \gexec
SELECT format('GRANT USAGE ON SEQUENCE %s TO uni_space_api',
              pg_get_serial_sequence(format('public.%I', tablename), 'id'))
FROM pg_tables WHERE schemaname='public'
  AND tablename IN ('applications', 'application_history') \gexec
SELECT 'GRANT UPDATE (review_status, form_data, reviewer_user_id, feedback, updated_at, version)
        ON public.applications TO uni_space_api'
WHERE to_regclass('public.applications') IS NOT NULL \gexec
-- Login row locks use the administration activity column; revoke legacy identifier ACL.
SELECT 'REVOKE UPDATE (id) ON public.users FROM uni_space_api'
WHERE to_regclass('public.users') IS NOT NULL \gexec
SELECT 'GRANT UPDATE (is_active) ON public.users TO uni_space_api'
WHERE to_regclass('public.users') IS NOT NULL \gexec
-- Administration: immutable role/password, explicit profiles and append-only audit.
SELECT format('GRANT INSERT ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public' AND tablename IN
    ('users','students','staff_profiles','staff_permissions','audit_events') \gexec
SELECT format('GRANT USAGE ON SEQUENCE %s TO uni_space_api',
              pg_get_serial_sequence(format('public.%I', tablename), 'id'))
FROM pg_tables WHERE schemaname='public' AND tablename IN
    ('users','students','staff_profiles','staff_permissions') \gexec
SELECT 'GRANT UPDATE (user_id) ON public.teachers TO uni_space_api'
WHERE to_regclass('public.teachers') IS NOT NULL \gexec
SELECT 'GRANT UPDATE (org_unit_id) ON public.staff_profiles TO uni_space_api'
WHERE to_regclass('public.staff_profiles') IS NOT NULL \gexec
SELECT 'GRANT DELETE ON public.staff_permissions TO uni_space_api'
WHERE to_regclass('public.staff_permissions') IS NOT NULL \gexec
-- Academic writes and invoker-trigger / row-lock requirements.
SELECT 'GRANT UPDATE (planned_date, lesson_id, date_needs_confirmation, id)
        ON public.assessment_groups TO uni_space_api'
WHERE to_regclass('public.assessment_groups') IS NOT NULL \gexec
SELECT 'GRANT UPDATE (id, max_score) ON public.assessments TO uni_space_api'
WHERE to_regclass('public.assessments') IS NOT NULL \gexec
SELECT format('GRANT UPDATE (id) ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public'
  AND tablename IN ('students','teaching_assignments','course_offerings') \gexec
SELECT 'GRANT UPDATE (group_id) ON public.course_groups TO uni_space_api'
WHERE to_regclass('public.course_groups') IS NOT NULL \gexec
SELECT 'GRANT INSERT, UPDATE, DELETE ON public.assessment_results TO uni_space_api'
WHERE to_regclass('public.assessment_results') IS NOT NULL \gexec
SELECT 'GRANT UPDATE (grade_value, passed, retake_date, retake_location)
        ON public.final_results TO uni_space_api'
WHERE to_regclass('public.final_results') IS NOT NULL \gexec
SELECT 'GRANT INSERT, DELETE ON public.final_results TO uni_space_api'
WHERE to_regclass('public.final_results') IS NOT NULL \gexec
SELECT 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.attendance TO uni_space_api'
WHERE to_regclass('public.attendance') IS NOT NULL \gexec
-- Schedule: no physical lesson deletion or UPDATE of authors/history pointers.
SELECT 'GRANT INSERT, UPDATE (id, course_offering_id, teacher_id, starts_at, ends_at, kind, status, version)
        ON public.lessons TO uni_space_api'
WHERE to_regclass('public.lessons') IS NOT NULL \gexec
SELECT format('GRANT INSERT, DELETE ON public.%I TO uni_space_api', tablename)
FROM pg_tables WHERE schemaname='public' AND tablename IN ('lesson_groups','lesson_rooms') \gexec
SELECT 'GRANT UPDATE (room_id) ON public.lesson_rooms TO uni_space_api'
WHERE to_regclass('public.lesson_rooms') IS NOT NULL \gexec
SELECT 'GRANT UPDATE (id) ON public.lesson_groups TO uni_space_api'
WHERE to_regclass('public.lesson_groups') IS NOT NULL \gexec
-- INSERT identity + RETURNING needs no sequence USAGE and no payload SELECT.
SELECT 'GRANT INSERT, SELECT (id, created_at) ON public.audit_events TO uni_space_api'
WHERE to_regclass('public.audit_events') IS NOT NULL \gexec
COMMIT;
