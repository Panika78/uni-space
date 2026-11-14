"""Run real isolated deployment checks using existing project HTTPX; see PRODUCTION.md."""

import json
import gzip
import re
import hashlib
import os
import secrets
import socket
import ssl
import subprocess
import tempfile
import time
from pathlib import Path
from contextlib import contextmanager
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[1]


def run(args, *, input=None, env=None, success=True, timeout=180):
    result = subprocess.run(
        args,
        cwd=ROOT,
        input=input,
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
    )
    if success and result.returncode:
        # Retain private diagnostics locally; never dump tokens or secret values.
        (ROOT / "work" / "production-command-error.log").write_text(result.stderr)
        raise AssertionError(f"Command failed ({result.returncode}): {args}")
    return result


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextmanager
def resolve_test_hostname():
    """Route only test DNS to loopback; preserve URL, Host, SNI and TLS verification."""
    original = socket.getaddrinfo

    def resolve(host, port, *args, **kwargs):
        if host in ("uni.test", b"uni.test"):
            host = "127.0.0.1"
        return original(host, port, *args, **kwargs)

    with patch("socket.getaddrinfo", side_effect=resolve):
        yield


def create_tls_certificates(temp):
    """One trusted CA and valid/wrong-name/expired leaves, using existing OpenSSL."""
    run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "2",
            "-subj",
            "/CN=Uni Test CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-keyout",
            str(temp / "ca.key"),
            "-out",
            str(temp / "ca.pem"),
        ]
    )
    run(
        [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=uni.test",
            "-keyout",
            str(temp / "tls.key"),
            "-out",
            str(temp / "tls.csr"),
        ]
    )
    (temp / "index").write_text("")
    (temp / "serial").write_text("01\n")
    (temp / "ca.cnf").write_text(f"""[ca]
default_ca = fixture
[fixture]
database = {temp}/index
serial = {temp}/serial
new_certs_dir = {temp}
certificate = {temp}/ca.pem
private_key = {temp}/ca.key
default_md = sha256
default_days = 1
unique_subject = no
policy = names
[names]
commonName = supplied
""")
    for name, hostname in (
        ("valid", "uni.test"),
        ("wrong", "other.test"),
        ("expired", "uni.test"),
    ):
        (temp / "leaf.cnf").write_text(f"""[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:{hostname}
""")
        args = [
            "openssl",
            "ca",
            "-batch",
            "-notext",
            "-config",
            str(temp / "ca.cnf"),
            "-extfile",
            str(temp / "leaf.cnf"),
            "-extensions",
            "server",
            "-in",
            str(temp / "tls.csr"),
            "-out",
            str(temp / f"{name}.pem"),
        ]
        if name == "expired":
            args += ["-startdate", "20200101000000Z", "-enddate", "20200102000000Z"]
        run(args)
    (temp / "tls.pem").write_bytes((temp / "valid.pem").read_bytes())


def assert_tls_verification_error(url, context, expected_code):
    try:
        with httpx.Client(verify=context, trust_env=False, timeout=5) as client:
            client.get(url + "/api/openapi.json")
    except httpx.ConnectError as error:
        cause = error
        seen = set()
        while cause is not None and id(cause) not in seen:
            seen.add(id(cause))
            if isinstance(cause, ssl.SSLCertVerificationError):
                assert cause.verify_code == expected_code, str(cause)
                return
            cause = cause.__cause__ or cause.__context__
        raise AssertionError(
            "Expected an actual certificate verification failure"
        ) from error
    raise AssertionError("Invalid TLS certificate was accepted")


def assert_security_headers(response):
    assert response.headers["strict-transport-security"] == "max-age=31536000"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"
    assert response.headers["x-frame-options"] == "DENY"


def assert_static_delivery(client, page):
    for path in (
        "/",
        "/index.html",
        "/login",
        "/schedule",
        "/services",
        "/schedule/deep/link",
        "/unknown-frontend-route",
    ):
        response = client.get(path)
        assert response.status_code == 200 and response.text == page.text
        assert_security_headers(response)
        assert response.headers["cache-control"] == "no-cache"
    assets = re.findall(r'(?:src|href)="(/assets/[^"?]+\.(?:js|css))"', page.text)
    assert any(path.endswith(".js") for path in assets)
    assert any(path.endswith(".css") for path in assets)
    for path in assets:
        identity = client.get(path, headers={"Accept-Encoding": "identity"})
        assert identity.status_code == 200
        assert "content-encoding" not in identity.headers
        assert_security_headers(identity)
        assert (
            identity.headers["cache-control"] == "public, max-age=31536000, immutable"
        )
        with client.stream(
            "GET", path, headers={"Accept-Encoding": "gzip"}
        ) as response:
            assert response.status_code == 200
            assert_security_headers(response)
            assert response.headers["content-encoding"] == "gzip"
            assert "accept-encoding" in response.headers["vary"].lower()
            assert (
                response.headers["cache-control"] == identity.headers["cache-control"]
            )
            compressed = b"".join(response.iter_raw())
        assert gzip.decompress(compressed) == identity.content
        assert len(compressed) < len(identity.content)
        cached = client.get(
            path,
            headers={
                "If-None-Match": identity.headers["etag"],
                "Accept-Encoding": "identity",
            },
        )
        assert cached.status_code == 304
        assert_security_headers(cached)
        assert cached.headers["cache-control"] == identity.headers["cache-control"]
        print(
            f"PASS: {path}: identity={len(identity.content)}, gzip={len(compressed)}, conditional=304",
            flush=True,
        )
    emblem = client.get("/assets/university-emblem.png")
    assert emblem.status_code == 200
    assert emblem.headers["cache-control"] == "no-cache"
    assert_security_headers(emblem)
    for path in ("/assets/missing.js", "/assets/missing-abcdefgh.js"):
        response = client.get(path)
        assert response.status_code == 404
        assert_security_headers(response)
        assert response.headers["cache-control"] == "no-cache"
    for path in ("/api", "/api/missing-abcdefgh.js", "/api/v1/users/me"):
        response = client.get(path)
        assert response.status_code in (401, 404)
        assert "application/json" in response.headers["content-type"]
        assert_security_headers(response)
        assert "public" not in response.headers.get("cache-control", "")
        assert "immutable" not in response.headers.get("cache-control", "")
    print("PASS: HTTPS static cache/compression, SPA and security headers", flush=True)


def main(*, legacy=False):
    project = f"uni-space-production-test-{secrets.token_hex(4)}"
    (ROOT / "work").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="production-", dir=ROOT / "work"
    ) as directory:
        temp = Path(directory)
        for name in ("jwt", "password", "api_password", "migration_password"):
            (temp / name).write_text(
                secrets.token_urlsafe(48) + ("@:/?#$&" if name == "password" else "")
            )
            (temp / name).chmod(0o600)
        create_tls_certificates(temp)
        http_port, https_port = free_port(), free_port()
        public_origin = f"https://uni.test:{https_port}"
        authority = f"uni.test:{https_port}"
        http_origin = f"http://uni.test:{http_port}"
        env_file = temp / "production.env"
        env_file.write_text(
            "\n".join(
                [
                    "RELEASE_TAG=task019",
                    f"PUBLIC_ORIGIN={public_origin}",
                    "POSTGRES_DB=deployment_check",
                    "POSTGRES_USER=deployment_check",
                    f"JWT_SIGNING_KEY_FILE={temp / 'jwt'}",
                    f"POSTGRES_PASSWORD_FILE={temp / 'password'}",
                    f"API_DB_PASSWORD_FILE={temp / 'api_password'}",
                    f"MIGRATION_DB_PASSWORD_FILE={temp / 'migration_password'}",
                    f"TLS_CERT_FILE={temp / 'tls.pem'}",
                    f"TLS_KEY_FILE={temp / 'tls.key'}",
                ]
            )
            + "\n"
        )
        override = temp / "ports.yaml"
        override.write_text(f"""services:
  nginx:
    networks:
      edge:
        aliases: [uni.test]
    ports: !override
      - "127.0.0.1:{http_port}:80"
      - "127.0.0.1:{https_port}:443"
""")
        env = os.environ.copy()
        # Never borrow real deployment parameters or secret paths from the caller.
        for name in (
            "RELEASE_TAG",
            "SERVER_NAME",
            "ALLOWED_ORIGINS",
            "PUBLIC_ORIGIN",
            "POSTGRES_DB",
            "POSTGRES_USER",
            "JWT_SIGNING_KEY_FILE",
            "POSTGRES_PASSWORD_FILE",
            "API_DB_PASSWORD_FILE",
            "MIGRATION_DB_PASSWORD_FILE",
            "TLS_CERT_FILE",
            "TLS_KEY_FILE",
            "PROXY_SUBNET",
            "PROXY_DYNAMIC_RANGE",
            "NGINX_PROXY_IP",
            "HTTP_BIND",
            "HTTPS_BIND",
        ):
            env.pop(name, None)
        env.update(
            APP_ENV="development",
            PROD_ENV_FILE=str(env_file),
            PROD_PROJECT_NAME=project,
        )
        compose = [
            "docker",
            "compose",
            "-p",
            project,
            "--env-file",
            str(env_file),
            "-f",
            str(ROOT / "compose.prod.yaml"),
            "-f",
            str(override),
        ]

        def dc(*args, **kwargs):
            return run([*compose, *args], env=env, **kwargs)

        def sql(query, database="deployment_check"):
            return dc(
                "exec",
                "-T",
                "db",
                "psql",
                "-U",
                "deployment_check",
                "-d",
                database,
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                input=query,
            ).stdout.strip()

        def wait_for_stopped_api_containers():
            deadline = time.monotonic() + 10
            command = [
                "docker",
                "ps",
                "-q",
                "--filter",
                f"label=com.docker.compose.project={project}",
                "--filter",
                "label=com.docker.compose.service=api",
            ]
            while time.monotonic() < deadline:
                result = run(command, success=False)
                if result.returncode == 0 and not result.stdout.strip():
                    return
                time.sleep(0.1)
            raise AssertionError("API containers remained running after Compose stop")

        try:
            config = json.loads(dc("config", "--format", "json").stdout)
            for service in ("api", "db"):
                assert not config["services"][service].get("ports")
            assert "--production" in config["services"]["api"]["command"]
            assert config["services"]["api"]["environment"]["APP_ENV"] == "production"
            assert not set(config["services"]["db"]["networks"]) & set(
                config["services"]["nginx"]["networks"]
            )
            dc("up", "-d", "--wait", "db")
            legacy_snapshot = None
            legacy_refresh = secrets.token_urlsafe(48)
            if legacy:
                # PR #31 baseline: official PG volume, migrations run as POSTGRES_USER.
                baseline = temp / "legacy.yaml"
                baseline.write_text("""services:
  migrate:
    environment:
      DATABASE_USER: deployment_check
      DATABASE_PASSWORD_FILE: /run/secrets/postgres_password
    secrets: !override [postgres_password]
""")
                run(
                    [
                        *compose,
                        "-f",
                        str(baseline),
                        "run",
                        "--rm",
                        "-T",
                        "migrate",
                        "alembic",
                        "upgrade",
                        "head",
                    ],
                    env=env,
                )
                token_hash = hashlib.sha256(legacy_refresh.encode()).hexdigest()
                sql(f"""INSERT INTO users (id,login,password_hash,full_name,role,is_active)
VALUES (900,'legacy-fixture','unusable-fictional-hash','Legacy Fixture','student',true);
INSERT INTO auth_sessions (id,user_id,expires_at)
VALUES (900,900,now()+interval '1 day');
INSERT INTO refresh_tokens (id,session_id,token_hash,expires_at)
VALUES (900,900,decode('{token_hash}','hex'),now()+interval '1 hour');""")
                legacy_snapshot = sql("""SELECT jsonb_build_array(
(SELECT to_jsonb(u) FROM users u WHERE id=900),
(SELECT to_jsonb(s) FROM auth_sessions s WHERE id=900),
(SELECT to_jsonb(r) FROM refresh_tokens r WHERE id=900),
(SELECT version_num FROM alembic_version));""")
                dc("down")
                dc("up", "-d", "--wait", "db")
            run(["bash", "scripts/configure-postgres.sh"], env=env)
            if legacy:
                assert (
                    sql("""SELECT jsonb_build_array(
(SELECT to_jsonb(u) FROM users u WHERE id=900),
(SELECT to_jsonb(s) FROM auth_sessions s WHERE id=900),
(SELECT to_jsonb(r) FROM refresh_tokens r WHERE id=900),
(SELECT version_num FROM alembic_version));""")
                    == legacy_snapshot
                )
                print(
                    "PASS: existing admin-owned volume preserves complete user/session/token/revision",
                    flush=True,
                )
            dc("up", "-d", "api")
            for _ in range(40):
                result = dc(
                    "exec",
                    "-T",
                    "api",
                    "python",
                    "-c",
                    'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/api/openapi.json")',
                    success=False,
                )
                if result.returncode == 0:
                    break
                time.sleep(0.5)
            else:
                raise AssertionError("API HTTP did not start")
            assert dc(
                "exec",
                "-T",
                "api",
                "sh",
                "docker-entrypoint.sh",
                "python",
                "scripts/check_readiness.py",
                success=False,
            ).returncode == (0 if legacy else 1)
            run(["bash", "scripts/migrate-postgres.sh"], env=env)
            dc("up", "-d", "--wait", "--wait-timeout", "120")
            dc("exec", "-T", "nginx", "nginx", "-t")
            dc("run", "--rm", "-T", "migrate", "alembic", "check")
            # F-02/F-03: simulate unsafe historical global AND schema defaults.
            # Include already-created objects; the API currently needs no routines.
            sql("""ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
GRANT SELECT ON TABLES TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
GRANT ALL ON TABLES TO uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
GRANT ALL ON SEQUENCES TO PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator
GRANT EXECUTE ON FUNCTIONS TO PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator IN SCHEMA public
GRANT ALL ON TABLES TO PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator IN SCHEMA public
GRANT ALL ON SEQUENCES TO PUBLIC, uni_space_api;
ALTER DEFAULT PRIVILEGES FOR ROLE uni_space_migrator IN SCHEMA public
GRANT EXECUTE ON FUNCTIONS TO PUBLIC, uni_space_api;
SET ROLE uni_space_migrator;
CREATE TABLE public.existing_acl_fixture (id bigint GENERATED BY DEFAULT AS IDENTITY);
CREATE FUNCTION public.existing_function_fixture() RETURNS name
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT current_user';
RESET ROLE;""")
            assert (
                sql(
                    "SELECT has_function_privilege('uni_space_api', 'public.existing_function_fixture()', 'EXECUTE')"
                )
                == "t"
            )
            # F-04: an ordinary repeat on the running API's database is allowed.
            run(["bash", "scripts/configure-postgres.sh"], env=env)
            sql("""SET ROLE uni_space_migrator;
CREATE TABLE public.future_fixture (id bigint GENERATED BY DEFAULT AS IDENTITY);
CREATE FUNCTION public.future_function_fixture() RETURNS name
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT current_user';
RESET ROLE;""")
            # Inspect stored default ACLs, not merely whether a SELECT happens to fail.
            assert (
                sql("""SELECT count(*) FROM pg_default_acl d,
LATERAL aclexplode(d.defaclacl) a
WHERE d.defaclrole='uni_space_migrator'::regrole
AND (d.defaclnamespace=0 OR d.defaclnamespace='public'::regnamespace)
AND d.defaclobjtype IN ('r','S','f')
AND a.grantee IN (0,'uni_space_api'::regrole::oid);""")
                == "0"
            )
            # Also inspect effective ACLs of both old and new tables/sequences/functions.
            assert (
                sql("""SELECT count(*) FROM pg_class c,
LATERAL aclexplode(coalesce(c.relacl, acldefault(
CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner))) a
WHERE c.relnamespace='public'::regnamespace
AND c.relname IN ('existing_acl_fixture','existing_acl_fixture_id_seq',
                 'future_fixture','future_fixture_id_seq')
AND a.grantee IN (0,'uni_space_api'::regrole::oid);""")
                == "0"
            )
            assert (
                sql("""SELECT count(*) FROM pg_proc p,
LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
WHERE p.pronamespace='public'::regnamespace
AND a.grantee IN (0,'uni_space_api'::regrole::oid);""")
                == "0"
            )
            assert {s["source"] for s in config["services"]["api"]["secrets"]} == {
                "jwt_signing_key",
                "api_db_password",
            }
            assert "POSTGRES_USER" not in config["services"]["api"]["environment"]
            sql(
                "CREATE SCHEMA private_fixture; CREATE TABLE private_fixture.secret (id int);"
            )
            dc(
                "exec",
                "-T",
                "api",
                "sh",
                "docker-entrypoint.sh",
                "python",
                "-c",
                """
from sqlalchemy import text, create_engine
from sqlalchemy.exc import DBAPIError
from app.core.database import engine
from app.core.config import get_settings
from sqlalchemy.engine import make_url
from pathlib import Path
assert not Path('/run/secrets/postgres_password').exists()
assert not Path('/run/secrets/migration_db_password').exists()
with engine.connect() as c:
    row=c.execute(text("SELECT current_user, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user")).one()
    assert tuple(row)==('uni_space_api',False,False,False,False,False)
    assert c.execute(text("SELECT has_table_privilege(current_user,'service_types','SELECT')")).scalar_one()
    assert c.execute(text("SELECT has_table_privilege(current_user,'applications','SELECT')")).scalar_one()
    assert c.execute(text("SELECT has_table_privilege(current_user,'applications','INSERT')")).scalar_one()
    assert c.execute(text("SELECT has_sequence_privilege(current_user,'applications_id_seq','USAGE')")).scalar_one()
    assert c.execute(text("SELECT has_table_privilege(current_user,'news','SELECT')")).scalar_one()
    assert not c.execute(text("SELECT has_sequence_privilege(current_user,'news_id_seq','USAGE')")).scalar_one()
    assert c.execute(text("SELECT has_table_privilege(current_user,'notifications','SELECT')")).scalar_one()
    for privilege in ('INSERT','UPDATE','DELETE'):
        assert not c.execute(text("SELECT has_table_privilege(current_user,'notifications',:privilege)"), {'privilege': privilege}).scalar_one()
    assert not c.execute(text("SELECT has_sequence_privilege(current_user,'notifications_id_seq','USAGE')")).scalar_one()
    for privilege in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
        assert not c.execute(text("SELECT has_table_privilege(current_user,'news',:privilege)"), {'privilege': privilege}).scalar_one()
    assert not c.execute(text("SELECT has_table_privilege(current_user,'applications','UPDATE')")).scalar_one()
    assert not c.execute(text("SELECT has_table_privilege(current_user,'applications','DELETE')")).scalar_one()
    print('PASS: API role flags false; isolated secrets')
    for table in ('users','students','study_groups','programs','org_units','teachers',
                  'disciplines','course_offerings','buildings','rooms','lessons','lesson_groups',
                  'lesson_rooms','news','notifications','academic_terms','course_groups',
                  'assessments','assessment_groups','assessment_results','final_results',
                  'staff_profiles','staff_permissions'):
        assert c.execute(text("SELECT has_table_privilege(current_user, :table, 'SELECT')"), {'table': table}).scalar_one()
        c.execute(text(f"SELECT * FROM public.{table} LIMIT 1")).all()
    for table in ('study_groups','programs','org_units','teachers','disciplines','course_offerings',
                  'buildings','rooms','lessons','lesson_groups','lesson_rooms',
                  'academic_terms','course_groups','assessments','assessment_groups',
                  'assessment_results','final_results','staff_profiles','staff_permissions'):
        for privilege in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'):
            assert not c.execute(text("SELECT has_table_privilege(current_user, :table, :privilege)"),
                                 {'table': table, 'privilege': privilege}).scalar_one()
    print('PASS: profile and schedule SELECT permitted; dependent tables remain read-only')
for statement in (
    "CREATE ROLE forbidden_role", "CREATE DATABASE forbidden_database",
    "CREATE TABLE public.forbidden_table(id int)", "CREATE SCHEMA forbidden_schema",
    "SET ROLE uni_space_migrator", "SET ROLE deployment_check",
    "SELECT * FROM private_fixture.secret", "SELECT * FROM pg_authid",
    "UPDATE users SET role='admin'", "TRUNCATE users",
    "ALTER TABLE users ADD COLUMN forbidden int", "DELETE FROM refresh_tokens",
    "UPDATE alembic_version SET version_num='forbidden'",
    "CREATE TEMP TABLE forbidden_temp(id int)",
    "SELECT * FROM public.future_fixture",
    "SELECT * FROM public.existing_acl_fixture",
    "SELECT public.existing_function_fixture()", "SELECT public.future_function_fixture()",
    "INSERT INTO disciplines (name) VALUES ('forbidden')",
    "UPDATE org_units SET name='forbidden'", "DELETE FROM programs",
    "INSERT INTO news (title,body,is_published) VALUES ('forbidden','forbidden',false)",
    "UPDATE news SET title='forbidden'", "DELETE FROM news", "TRUNCATE news",
    "SELECT nextval('public.news_id_seq')",
    "INSERT INTO notifications (user_id,type,title,body) VALUES (1,'forbidden','forbidden','forbidden')",
    "UPDATE notifications SET title='forbidden'", "DELETE FROM notifications",
    "SELECT nextval('public.notifications_id_seq')",
    "SELECT nextval('public.org_units_id_seq')", "SELECT nextval('public.programs_id_seq')",
    "UPDATE lessons SET status='cancelled'", "DELETE FROM lesson_groups",
    "INSERT INTO assessments (course_offering_id,title,type,max_score) VALUES (1,'forbidden','test',10)",
    "UPDATE assessment_groups SET planned_date=CURRENT_DATE", "DELETE FROM assessment_results",
    "UPDATE final_results SET grade_value=5", "SELECT nextval('public.final_results_id_seq')",
    "SELECT nextval('public.lessons_id_seq')",
    "SELECT nextval('public.users_id_seq')",
    "INSERT INTO staff_profiles (user_id,org_unit_id) VALUES (1,1)",
    "UPDATE staff_profiles SET org_unit_id=1", "DELETE FROM staff_profiles",
    "INSERT INTO staff_permissions (staff_profile_id,permission_code) VALUES (1,'grades.edit')",
    "UPDATE staff_permissions SET permission_code='grades.edit'", "DELETE FROM staff_permissions",
    "SELECT nextval('public.staff_profiles_id_seq')",
    "SELECT nextval('public.staff_permissions_id_seq')",
    "SELECT setval('public.auth_sessions_id_seq', 9999)",
):
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as c: c.execute(text(statement))
    except DBAPIError as e:
        assert e.orig.sqlstate == '42501', (statement, e.orig.sqlstate)
    else: raise AssertionError(statement)
for database in ('postgres','template1'):
    other=create_engine(make_url(get_settings().database_url.get_secret_value()).set(database=database))
    try:
        with other.connect(): pass
    except DBAPIError: pass
    else: raise AssertionError('foreign database accessible')
print('PASS: API rejects DDL, escalation, foreign schema/database, protected writes')
""",
            )
            # SEC-01: test the running binaries, not only image tags in YAML.
            dc(
                "exec",
                "-T",
                "api",
                "python",
                "-c",
                "import sys; assert sys.version_info[:3] == (3, 12, 16)",
            )
            assert "17.11" in dc("exec", "-T", "db", "postgres", "--version").stdout
            assert "nginx/1.30.6" in dc("exec", "-T", "nginx", "nginx", "-v").stderr
            print(
                "PASS: running Python 3.12.16, PostgreSQL 17.11, Nginx 1.30.6",
                flush=True,
            )
            print("PASS: topology, startup, HTTP/DB/schema readiness", flush=True)

            sql("""DROP TABLE public.future_fixture, public.existing_acl_fixture;
DROP FUNCTION public.existing_function_fixture(), public.future_function_fixture();""")
            print(
                "PASS: restricted API role, isolated mounts, negative permissions and default ACL",
                flush=True,
            )

            # F-04: a real DNS URL determines both TLS verification hostname and SNI.
            context = ssl.create_default_context(cafile=str(temp / "ca.pem"))
            sni = []

            def trace(event, info):
                if event == "connection.start_tls.started":
                    sni.append(info["server_hostname"])

            with httpx.Client(verify=context, trust_env=False, timeout=5) as probe:
                assert (
                    probe.get(
                        public_origin + "/api/openapi.json", extensions={"trace": trace}
                    ).status_code
                    == 200
                )
            assert sni and all(name == "uni.test" for name in sni), sni
            # The same certificate intentionally has no IP SAN.
            assert_tls_verification_error(
                f"https://127.0.0.1:{https_port}", context, 64
            )
            for cert, code in (("wrong", 62), ("expired", 10)):
                (temp / "tls.pem").write_bytes((temp / f"{cert}.pem").read_bytes())
                dc("rm", "-s", "-f", "nginx")
                dc("up", "-d", "--wait", "--wait-timeout", "120", "nginx")
                assert_tls_verification_error(public_origin, context, code)
            (temp / "tls.pem").write_bytes((temp / "valid.pem").read_bytes())
            dc("rm", "-s", "-f", "nginx")
            dc("up", "-d", "--wait", "--wait-timeout", "120", "nginx")
            print(
                "PASS: TLS uni.test URL/SNI; wrong hostname, IP SAN and expired certificate rejected",
                flush=True,
            )
            with httpx.Client(
                base_url=public_origin, verify=context, trust_env=False, timeout=5
            ) as static_client:
                assert_static_delivery(static_client, static_client.get("/"))
                # Check legal notices before the separate browser smoke test.
                project_license = static_client.get("/LICENSE")
                assert project_license.status_code == 200
                assert "Copyright (c) 2026 Panika78" in project_license.text
                licenses = static_client.get("/licenses.md")
                assert licenses.status_code == 200
                assert "## react - 19.2.0 (MIT)" in licenses.text
                assert "Permission is hereby granted" in licenses.text
                provenance = static_client.get("/ASSET_PROVENANCE.md")
                assert provenance.status_code == 200
                assert "OpenAI ChatGPT" in provenance.text
            print(
                "PASS: HTTPS project license, bundled dependency licenses and asset provenance",
                flush=True,
            )
            browser_env = env | {
                "PRODUCTION_TEST_URL": public_origin,
                "PRODUCTION_TEST_CERT_FILE": str(temp / "tls.pem"),
            }
            result = run(["node", "deploy/spa.browser.mjs"], env=browser_env)
            print(result.stdout.strip(), flush=True)
            password = secrets.token_urlsafe(24)
            dc(
                "run",
                "--rm",
                "-T",
                "migrate",
                "python",
                "-c",
                """
import sys
from argon2 import PasswordHasher
from app.core.database import SessionLocal
from app.models import OrgUnit, StaffPermission, StaffProfile, User
password_hash = PasswordHasher().hash(sys.stdin.read())
with SessionLocal.begin() as db:
    db.add(User(login="deployment-check", full_name="Deployment Check", role="admin",
                is_active=True, password_hash=password_hash))
    unit = OrgUnit(name="Fictional RBAC Dean", type="dean_office")
    user = User(login="rbac-deployment-check", full_name="Fictional RBAC Staff", role="staff",
                is_active=True, password_hash=password_hash)
    db.add_all([unit, user])
    db.flush()
    profile = StaffProfile(user_id=user.id, org_unit_id=unit.id)
    db.add(profile)
    db.flush()
    db.add_all([
        StaffPermission(staff_profile_id=profile.id, permission_code="grades.edit"),
        StaffPermission(staff_profile_id=profile.id, permission_code="applications.review",
                        scope_org_unit_id=unit.id),
    ])
""",
                input=password,
            )
            dc(
                "run",
                "--rm",
                "-T",
                "migrate",
                "python",
                "-c",
                (ROOT / "deploy/schedule_fixtures.py").read_text(),
                input=password,
            )
            dc(
                "run",
                "--rm",
                "-T",
                "migrate",
                "python",
                "-c",
                (ROOT / "deploy/academics_fixtures.py").read_text(),
            )
            # ACL reapplication must retain schedule reads and all existing auth permissions.
            run(["bash", "scripts/configure-postgres.sh"], env=env)
            staff_user_id, staff_unit_id = (
                sql("""SELECT u.id, p.org_unit_id FROM users u
JOIN staff_profiles p ON p.user_id=u.id WHERE u.login='rbac-deployment-check';""").split(
                    "|"
                )
            )
            with httpx.Client(
                base_url=public_origin, verify=context, trust_env=False, timeout=10
            ) as staff_client:
                staff_login = staff_client.post(
                    "/api/v1/auth/login",
                    headers={"Origin": public_origin},
                    json={"login": "rbac-deployment-check", "password": password},
                )
                assert staff_login.status_code == 200
                staff_context = staff_client.get(
                    "/api/v1/auth/context",
                    headers={
                        "Authorization": "Bearer " + staff_login.json()["access_token"]
                    },
                )
                assert staff_context.status_code == 200
                assert staff_context.headers["cache-control"] == "no-store"
                assert staff_context.json() == {
                    "user_id": staff_user_id,
                    "role": "staff",
                    "org_unit_id": staff_unit_id,
                    "permissions": [
                        {
                            "permission_code": "applications.review",
                            "scope_org_unit_id": staff_unit_id,
                        },
                        {"permission_code": "grades.edit", "scope_org_unit_id": None},
                    ],
                }
                assert staff_client.post(
                    "/api/v1/auth/logout", headers={"Origin": public_origin}
                ).json() == {"session_revoked": True}
            print(
                "PASS: staff login and exact RBAC context under production ACL after reapplication",
                flush=True,
            )
            published_news_id = sql("""INSERT INTO news (title, body, published_at, is_published)
VALUES ('Production ACL fixture', 'Fictional published news', now(), true)
RETURNING id;""")
            hidden_news_id = sql("""INSERT INTO news (title, body, published_at, is_published)
VALUES ('Production hidden fixture', 'Fictional hidden news', NULL, false)
RETURNING id;""")
            notification_id = sql("""INSERT INTO notifications (user_id, type, title, body)
VALUES ((SELECT id FROM users WHERE login='schedule-fixture-1'),
        'acl_fixture', 'Production ACL fixture', 'Fictional private notification')
RETURNING id;""")
            with httpx.Client(
                base_url=public_origin,
                verify=context,
                trust_env=False,
                timeout=10,
            ) as client:
                redirect = httpx.get(
                    http_origin + "/schedule?day=1",
                    trust_env=False,
                )
                assert redirect.status_code == 308
                assert redirect.headers["location"] == public_origin + "/schedule?day=1"
                # F-01: hostile Host cannot reach Starlette's absolute redirect.
                for host in (
                    "attacker.invalid",
                    "uni.test.attacker.invalid",
                    "127.0.0.1",
                    "uni.test:1",
                ):
                    rejected = client.get("/api/docs/", headers={"Host": host})
                    assert rejected.status_code == 421
                    assert "location" not in rejected.headers
                    rejected = httpx.get(
                        http_origin + "/api/docs/",
                        headers={"Host": host},
                        trust_env=False,
                    )
                    if host != "uni.test:1":
                        assert rejected.status_code == 421
                        assert "location" not in rejected.headers
                    else:
                        assert rejected.status_code == 308
                        assert (
                            rejected.headers["location"] == public_origin + "/api/docs/"
                        )
                # Use a raw TLS request: HTTPX correctly refuses duplicate Host locally.
                for host_lines in (
                    "Host: ",
                    f"Host: {authority}\r\nHost: attacker.invalid",
                ):
                    with socket.create_connection(
                        ("uni.test", https_port), timeout=5
                    ) as tcp:
                        with context.wrap_socket(
                            tcp, server_hostname="uni.test"
                        ) as tls:
                            tls.sendall(
                                (
                                    "GET /api/docs/ HTTP/1.1\r\n"
                                    + host_lines
                                    + "\r\nConnection: close\r\n\r\n"
                                ).encode()
                            )
                            assert (
                                tls.recv(4096).split(b"\r\n", 1)[0]
                                == b"HTTP/1.1 400 Bad Request"
                            )
                assert (
                    client.get(
                        "/api/docs/", headers={"Host": authority.upper()}
                    ).headers["location"]
                    == public_origin + "/api/docs"
                )
                print(
                    "PASS: untrusted Host rejected; upstream redirects use canonical authority",
                    flush=True,
                )
                page = client.get("/")
                assert page.status_code == 200 and '<div id="root">' in page.text
                assert page.headers["strict-transport-security"] == "max-age=31536000"
                assert page.headers["cache-control"] == "no-cache"
                # This unknown URL tests only nginx fallback, not React routing.
                assert client.get("/schedule/deep/link").text == page.text
                assert client.get("/schedule").text == page.text
                assert (
                    client.get("/api/openapi.json").json()["info"]["title"]
                    == "Uni Space API"
                )
                assert client.get("/assets/missing.js").status_code == 404
                # SEC-03: a fictional query must reach the real API but neither log.
                query_marker = "fictional-sec03-query-marker"
                access_line = "GET /api/openapi.json 200"
                before_logs = dc("logs", "nginx").stdout
                before = before_logs.count(access_line)
                redirect_line = "GET /schedule 308"
                before_redirect = before_logs.count(redirect_line)
                assert (
                    client.get(
                        "/api/openapi.json", params={"probe": query_marker}
                    ).status_code
                    == 200
                )
                assert (
                    httpx.get(
                        http_origin + "/schedule",
                        params={"probe": query_marker},
                        trust_env=False,
                    ).status_code
                    == 308
                )
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    nginx_logs = dc("logs", "nginx").stdout
                    if (
                        nginx_logs.count(access_line) > before
                        and nginx_logs.count(redirect_line) > before_redirect
                    ):
                        break
                    time.sleep(0.05)
                assert nginx_logs.count(access_line) > before
                assert nginx_logs.count(redirect_line) > before_redirect
                api_logs = dc("logs", "api").stdout
                assert "Uvicorn running" in api_logs
                assert query_marker not in api_logs and query_marker not in nginx_logs
                assert "GET /api/openapi.json?" not in api_logs
                print(
                    "PASS: production query marker absent from API/nginx logs; diagnostics remain",
                    flush=True,
                )
                for path in ("/api", "/api/no-such-route"):
                    missing = client.get(path)
                    assert missing.status_code == 404
                    assert "application/json" in missing.headers["content-type"]
                scheme = client.get("/api/docs/", headers={"X-Forwarded-Proto": "http"})
                assert scheme.status_code == 307
                assert scheme.headers["location"] == public_origin + "/api/docs"
                for headers in (
                    {},
                    {"Origin": http_origin},
                    {"Origin": "https://evil.test"},
                    {"Origin": "null"},
                    [("Origin", public_origin), ("Origin", public_origin)],
                ):
                    denied = client.post("/api/v1/auth/refresh", headers=headers)
                    assert denied.status_code == 403
                    assert denied.json()["error"]["code"] == "origin_not_allowed"
                origin = {"Origin": public_origin}
                if legacy:
                    with httpx.Client(
                        base_url=public_origin,
                        verify=context,
                        trust_env=False,
                        timeout=10,
                    ) as previous:
                        previous.cookies.set(
                            "uni_space_refresh",
                            legacy_refresh,
                            domain="uni.test",
                            path="/api/v1/auth",
                        )
                        denied_legacy_refresh = previous.post(
                            "/api/v1/auth/refresh", headers=origin
                        )
                        assert denied_legacy_refresh.status_code == 401
                        assert (
                            denied_legacy_refresh.json()["error"]["code"]
                            == "invalid_refresh"
                        )
                        logout = previous.post("/api/v1/auth/logout", headers=origin)
                        assert logout.status_code == 200
                        assert logout.json() == {"session_revoked": False}
                        assert any(
                            value.startswith("uni_space_refresh=")
                            and "Max-Age=0" in value
                            and "Path=/api/v1/auth" in value
                            and "Domain=" not in value
                            for value in logout.headers.get_list("set-cookie")
                        )
                    assert (
                        sql("SELECT revoked_at IS NULL FROM auth_sessions WHERE id=900")
                        == "t"
                    )
                    assert (
                        sql(
                            "SELECT revoked_at IS NULL FROM refresh_tokens WHERE id=900"
                        )
                        == "t"
                    )
                    print(
                        "PASS: pre-transition cookie is rejected, cleared host-only, and does not select a session",
                        flush=True,
                    )
                student_login = client.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": "schedule-fixture-1", "password": password},
                )
                assert student_login.status_code == 200
                schedule_headers = {
                    "Authorization": "Bearer " + student_login.json()["access_token"]
                }
                notifications = client.get(
                    "/api/v1/notifications", headers=schedule_headers
                )
                assert notifications.status_code == 200, notifications.text
                assert notifications.headers["cache-control"] == "no-store"
                assert [item["id"] for item in notifications.json()["items"]] == [
                    notification_id
                ]
                print(
                    "PASS: real personal notification SELECT under uni_space_api",
                    flush=True,
                )
                news_page = client.get("/api/v1/news", headers=schedule_headers)
                assert news_page.status_code == 200, news_page.text
                assert any(
                    item["id"] == published_news_id
                    and item["title"] == "Production ACL fixture"
                    for item in news_page.json()["items"]
                )
                news_detail = client.get(
                    f"/api/v1/news/{published_news_id}", headers=schedule_headers
                )
                assert news_detail.status_code == 200, news_detail.text
                assert news_detail.json()["body"] == "Fictional published news"
                assert (
                    client.get(
                        f"/api/v1/news/{hidden_news_id}", headers=schedule_headers
                    ).status_code
                    == 404
                )
                print(
                    "PASS: real news list/detail and hidden-ID filtering under uni_space_api",
                    flush=True,
                )
                academics = client.get("/api/v1/academics", headers=schedule_headers)
                assert academics.status_code == 200, academics.text
                assert academics.headers["cache-control"] == "no-store"
                academic_items = academics.json()["items"]
                scored = next(
                    i
                    for i in academic_items
                    if i["discipline"]["name"] == "Успеваемость: тестовый предмет 1"
                )
                assert (
                    scored["total_score"],
                    scored["max_score"],
                    scored["graded_assessment_count"],
                    scored["assessment_count"],
                ) == (6, 30, 2, 3)
                assert scored["final_result"]["has_debt"] is True
                assert (
                    client.get(
                        "/api/v1/academics?student_id=1", headers=schedule_headers
                    ).status_code
                    == 422
                )
                print(
                    "PASS: real /academics under restricted uni_space_api after repeated ACL",
                    flush=True,
                )
                profile = client.get("/api/v1/users/me", headers=schedule_headers)
                assert profile.status_code == 200, profile.text
                assert profile.headers["cache-control"] == "no-store"
                first_profile = profile.json()
                assert first_profile["login"] == "schedule-fixture-1"
                assert first_profile["full_name"] == "Вымышленный Студент 1"
                assert first_profile["group"]["name"] == "ТЕСТ-1"
                assert first_profile["program"]["code"] == "schedule-fixture"
                assert (
                    first_profile["faculty"]["name"] == "Тестовый вымышленный факультет"
                )
                assert (
                    client.get(
                        "/api/v1/users/me",
                        params={"student_id": "999"},
                        headers=schedule_headers,
                    ).status_code
                    == 422
                )
                assert (
                    client.get(
                        "/api/v1/users/999", headers=schedule_headers
                    ).status_code
                    == 404
                )
                assert (
                    client.get(
                        "/api/v1/schedule",
                        params={
                            "date_from": "2026-11-10",
                            "date_to": "2026-11-10",
                            "group_id": "999",
                        },
                        headers=schedule_headers,
                    ).status_code
                    == 422
                )
                schedule = client.get(
                    "/api/v1/schedule",
                    params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
                    headers=schedule_headers,
                )
                assert schedule.status_code == 200, schedule.text
                assert schedule.headers["cache-control"] == "no-store"
                items = schedule.json()["items"]
                assert len(items) == 5 and len({item["id"] for item in items}) == 5
                shared = next(item for item in items if len(item["rooms"]) == 2)
                assert len(shared["groups"]) == 2
                assert any(item["latest_lesson"] for item in items)
                assert not any(
                    item["course_offering"]["discipline"]["name"]
                    == "Только вторая группа"
                    for item in items
                )
                print(
                    "PASS: real GET /schedule under uni_space_api after repeated ACL; rooms, groups, moves, isolation",
                    flush=True,
                )
                moved = next(item for item in items if item["status"] == "moved")
                assert moved["latest_lesson"]["starts_at"].startswith("2026-12-20")
                second_login = client.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": "schedule-fixture-2", "password": password},
                )
                assert second_login.status_code == 200
                second_schedule = client.get(
                    "/api/v1/schedule",
                    params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
                    headers={
                        "Authorization": "Bearer " + second_login.json()["access_token"]
                    },
                )
                second_academics = client.get(
                    "/api/v1/academics",
                    headers={
                        "Authorization": "Bearer " + second_login.json()["access_token"]
                    },
                )
                assert second_academics.status_code == 200
                second_scored = next(
                    i
                    for i in second_academics.json()["items"]
                    if i["course_offering_id"] == scored["course_offering_id"]
                )
                assert second_scored["total_score"] == 18
                assert second_scored["final_result"]["grade_value"] == 5
                assert second_schedule.status_code == 200
                second_headers = {
                    "Authorization": "Bearer " + second_login.json()["access_token"]
                }
                second_notifications = client.get(
                    "/api/v1/notifications", headers=second_headers
                )
                assert second_notifications.status_code == 200
                assert second_notifications.json()["items"] == []
                print(
                    "PASS: production role notification query remains isolated by user",
                    flush=True,
                )
                second_profile = client.get("/api/v1/users/me", headers=second_headers)
                assert second_profile.status_code == 200
                assert second_profile.json()["login"] == "schedule-fixture-2"
                assert second_profile.json()["full_name"] == "Вымышленный Студент 2"
                assert second_profile.json()["group"]["name"] == "ТЕСТ-2"
                for key in ("id", "student_id", "group"):
                    assert second_profile.json()[key] != first_profile[key]
                assert (
                    client.get("/api/v1/users/me", headers=schedule_headers).status_code
                    == 401
                )
                print(
                    "PASS: real /users/me and /schedule for two students under uni_space_api; foreign selectors rejected",
                    flush=True,
                )
                second_items = second_schedule.json()["items"]
                assert len(second_items) == 2
                assert any(
                    item["course_offering"]["discipline"]["name"]
                    == "Только вторая группа"
                    for item in second_items
                )
                assert not any(
                    item["course_offering"]["discipline"]["name"]
                    == "Только первая группа"
                    for item in second_items
                )
                print(
                    "PASS: second student's real schedule remains isolated under restricted role",
                    flush=True,
                )
                login = client.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": "deployment-check", "password": password},
                )
                assert login.status_code == 200
                set_cookies = login.headers.get_list("set-cookie")
                cookie = next(
                    value
                    for value in set_cookies
                    if value.startswith("__Host-uni_space_refresh=")
                ).lower()
                for flag in ("secure", "httponly", "samesite=lax", "path=/"):
                    assert flag in cookie
                assert "domain=" not in cookie
                assert any(
                    value.startswith("uni_space_refresh=")
                    and "max-age=0" in value.lower()
                    and "path=/api/v1/auth" in value.lower()
                    for value in set_cookies
                )
                assert login.headers["cache-control"] == "no-store"
                assert (
                    client.post("/api/v1/auth/refresh", headers=origin).status_code
                    == 200
                )
                logout = client.post("/api/v1/auth/logout", headers=origin)
                assert logout.status_code == 200
                assert logout.json() == {"session_revoked": True}
                assert (
                    client.post("/api/v1/auth/refresh", headers=origin).status_code
                    == 401
                )
            if not legacy:
                # Persist a real student application, then restart both containers while
                # retaining Compose volumes and compare the complete row in PostgreSQL.
                student_login = f"persistence-{secrets.token_hex(8)}"
                student_password = secrets.token_urlsafe(24)
                dc(
                    "run",
                    "--rm",
                    "-T",
                    "migrate",
                    "python",
                    "-c",
                    """
import sys
from argon2 import PasswordHasher
from app.core.database import SessionLocal
from app.models import OrgUnit, Program, Student, StudyGroup, User
login, password = sys.stdin.read().splitlines()
with SessionLocal.begin() as db:
    faculty = OrgUnit(name=login, type="faculty")
    db.add(faculty)
    db.flush()
    program = Program(code=login, name=login, direction_code=login,
                      direction_name=login, faculty_id=faculty.id)
    db.add(program)
    db.flush()
    group = StudyGroup(name=login, program_id=program.id, course_number=1)
    user = User(login=login, full_name=login, role="student", is_active=True,
                password_hash=PasswordHasher().hash(password))
    db.add_all([group, user])
    db.flush()
    db.add(Student(user_id=user.id, group_id=group.id, academic_status="enrolled"))
""",
                    input=f"{student_login}\n{student_password}",
                )
                with httpx.Client(
                    base_url=public_origin, verify=context, trust_env=False, timeout=10
                ) as student_client:
                    student_auth = student_client.post(
                        "/api/v1/auth/login",
                        headers=origin,
                        json={"login": student_login, "password": student_password},
                    )
                    assert student_auth.status_code == 200
                    student_headers = {
                        **origin,
                        "Authorization": f"Bearer {student_auth.json()['access_token']}",
                    }
                    assert (
                        student_client.get(
                            "/api/v1/services", headers=student_headers
                        ).status_code
                        == 200
                    )
                    submitted = student_client.post(
                        "/api/v1/applications",
                        headers=student_headers,
                        json={
                            "service_code": "study_certificate",
                            "form_data": {
                                "place_of_submission": "Restart persistence — 東京"
                            },
                        },
                    )
                    assert submitted.status_code == 201
                    application_id = int(submitted.json()["id"])
                    application_path = f"/api/v1/applications/{application_id}"
                    assert (
                        student_client.get(
                            application_path, headers=student_headers
                        ).json()
                        == submitted.json()
                    )
                    application_page = student_client.get(
                        "/api/v1/applications", headers=student_headers
                    )
                    assert application_page.status_code == 200
                    assert submitted.json() in application_page.json()["items"]
                persisted_before = sql(
                    f"SELECT to_jsonb(a) FROM applications a WHERE id={application_id}"
                )
                assert persisted_before
                dc("restart", "api")
                dc("up", "-d", "--wait", "--wait-timeout", "120", "api")
                dc("restart", "db")
                dc("up", "-d", "--wait", "--wait-timeout", "120")
                persisted_after = sql(
                    f"SELECT to_jsonb(a) FROM applications a WHERE id={application_id}"
                )
                assert persisted_after == persisted_before
                with httpx.Client(
                    base_url=public_origin, verify=context, trust_env=False, timeout=10
                ) as after_restart:
                    assert (
                        after_restart.get(
                            "/api/v1/services", headers=student_headers
                        ).status_code
                        == 200
                    )
                    assert (
                        after_restart.get(
                            application_path, headers=student_headers
                        ).json()
                        == submitted.json()
                    )
                    assert (
                        submitted.json()
                        in after_restart.get(
                            "/api/v1/applications", headers=student_headers
                        ).json()["items"]
                    )
                print(
                    "PASS: PostgreSQL application row unchanged after API and DB restart with persistent volume",
                    flush=True,
                )
                sql(
                    f"""DELETE FROM applications WHERE id={application_id};
DELETE FROM refresh_tokens WHERE session_id IN (
    SELECT id FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE login='{student_login}')
);
DELETE FROM auth_sessions WHERE user_id=(SELECT id FROM users WHERE login='{student_login}');
DELETE FROM students WHERE user_id=(SELECT id FROM users WHERE login='{student_login}');
DELETE FROM users WHERE login='{student_login}';
DELETE FROM study_groups WHERE name='{student_login}';
DELETE FROM programs WHERE code='{student_login}';
DELETE FROM org_units WHERE name='{student_login}';"""
                )
            print(
                "PASS: verified TLS, SPA/API, scheme, Origin, auth and cookie",
                flush=True,
            )
            dc("restart", "api")
            dc("up", "-d", "--wait", "--wait-timeout", "120")
            client_code = """
import http.client, ssl, sys
context = ssl.create_default_context(cadata=sys.stdin.read())
from urllib.parse import urlsplit
origin = sys.argv[1]
authority = urlsplit(origin).netloc
import socket
for service in ("api", "db"):
    try:
        socket.getaddrinfo(service, None)
    except socket.gaierror:
        pass
    else:
        raise AssertionError("internal service visible on edge network")
for index in range(6):
    c = http.client.HTTPSConnection("uni.test", context=context, timeout=5)
    c.request("POST", "/api/v1/auth/login", body="{}", headers={
        "Origin": origin, "Content-Type": "application/json", "Host": authority,
        "X-Forwarded-For": f"198.51.100.{index + 1}", "X-Real-IP": "203.0.113.1",
        "X-Forwarded-Proto": "http", "Forwarded": "for=203.0.113.2;proto=http"})
    r = c.getresponse()
    assert r.status == (422 if index < 5 else 429), r.status
    r.read()
    c.close()
"""
            started = time.monotonic()
            peers = []
            for number in (1, 2):
                name = f"{project}-client-{number}"
                # Keep the first peer alive so Docker cannot reuse its dynamic IP.
                run(
                    [
                        "docker",
                        "run",
                        "-d",
                        "--name",
                        name,
                        "--network",
                        f"{project}_edge",
                        "--entrypoint",
                        "sleep",
                        "uni-space-api:task019",
                        "180",
                    ]
                )
                result = run(
                    [
                        "docker",
                        "exec",
                        "-i",
                        name,
                        "python",
                        "-c",
                        client_code,
                        public_origin,
                    ],
                    input=(temp / "ca.pem").read_text(),
                    success=False,
                )
                # This anonymous client sends only {}, never credentials or tokens.
                assert result.returncode == 0, (
                    f"Anonymous peer check failed: {result.stderr[-4000:]}"
                )
                info = json.loads(run(["docker", "inspect", name]).stdout)[0]
                peer = info["NetworkSettings"]["Networks"][f"{project}_edge"][
                    "IPAddress"
                ]
                peers.append(peer)
                assert f"{peer} POST /api/v1/auth/login" in dc("logs", "nginx").stdout
            assert len(set(peers)) == 2
            assert time.monotonic() - started < 60, (
                "Compare client limits within one rate-limit window"
            )
            for number in (1, 2):
                run(["docker", "rm", "-f", f"{project}-client-{number}"])
            rogue_code = """
import http.client, sys
origin = sys.argv[1]
c = http.client.HTTPConnection("api", 8000, timeout=5)
c.request("GET", "/api/docs/", headers={"X-Forwarded-Proto": "https"})
r = c.getresponse()
assert r.status == 307 and r.getheader("Location") == "http://api:8000/api/docs"
r.read()
c.close()
for index in range(6):
    c = http.client.HTTPConnection("api", 8000, timeout=5)
    c.request("POST", "/api/v1/auth/login", body="{}", headers={
        "Origin": origin, "Content-Type": "application/json",
        "X-Forwarded-For": f"203.0.113.{index + 1}", "X-Forwarded-Proto": "https"})
    r = c.getresponse()
    assert r.status == (422 if index < 5 else 429), r.status
    r.read()
"""
            run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--network",
                    f"{project}_proxy",
                    "--entrypoint",
                    "python",
                    "uni-space-api:task019",
                    "-c",
                    rogue_code,
                    public_origin,
                ]
            )
            assert "POST /api/v1/auth/login" not in dc("logs", "api").stdout
            print(
                "PASS: actual client IP, independent limits, spoofing and untrusted peer",
                flush=True,
            )
            for setting in (
                "COOKIE_SECURE=false",
                'ALLOWED_ORIGINS=["http://uni.test"]',
                'ALLOWED_ORIGINS=["https://*"]',
                'TRUSTED_PROXY_IPS=["*"]',
                "TRUSTED_PROXY_IPS=[]",
                'TRUSTED_PROXY_IPS=["8.8.8.0/24"]',
                'TRUSTED_PROXY_IPS=["10.0.0.0/8"]',
                'TRUSTED_PROXY_IPS=["172.30.19.0/24"]',
                'ALLOWED_ORIGINS=["https://other.test"]',
                "PUBLIC_ORIGIN=https://other.test",
                "PUBLIC_ORIGIN=https://uni.test:443",
                "PROXY_HEADERS_ENABLED=false",
            ):
                result = dc(
                    "run",
                    "--rm",
                    "--no-deps",
                    "-T",
                    "-e",
                    "APP_ENV=development",
                    "-e",
                    setting,
                    "api",
                    success=False,
                    timeout=20,
                )
                assert result.returncode != 0
                assert "Invalid or missing environment settings" in result.stderr
                assert "Uvicorn running" not in result.stderr
            key = (temp / "jwt").read_text()
            (temp / "jwt").write_text(
                "development-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
            )
            result = dc(
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "-e",
                "APP_ENV=development",
                "api",
                success=False,
                timeout=20,
            )
            (temp / "jwt").write_text(key)
            assert result.returncode != 0
            assert "Invalid or missing environment settings" in result.stderr
            assert (
                "development-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
                not in result.stderr
            )
            print(
                "PASS: actual production command rejects insecure settings despite development env",
                flush=True,
            )
            snapshot = """SELECT jsonb_build_object(
'users', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM users t),
'staff_profiles', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM staff_profiles t),
'staff_permissions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM staff_permissions t),
'sessions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth_sessions t),
'refresh', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM refresh_tokens t),
'revisions', (SELECT jsonb_agg(to_jsonb(t)) FROM alembic_version t),
'academic_terms', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM academic_terms t),
'disciplines', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM disciplines t),
'course_offerings', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM course_offerings t),
'course_groups', (SELECT jsonb_agg(to_jsonb(t) ORDER BY course_offering_id,group_id) FROM course_groups t),
'buildings', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM buildings t),
'rooms', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM rooms t),
'lessons', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lessons t),
'lesson_groups', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM lesson_groups t),
'lesson_rooms', (SELECT jsonb_agg(to_jsonb(t) ORDER BY lesson_id,room_id) FROM lesson_rooms t),
'assessments', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM assessments t),
'assessment_groups', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM assessment_groups t),
'assessment_results', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM assessment_results t),
'final_results', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM final_results t),
'notifications', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM notifications t));"""
            expected = sql(snapshot)
            assert sql(
                "SELECT count(*) FROM users u JOIN auth_sessions s ON s.user_id=u.id JOIN refresh_tokens r ON r.session_id=s.id WHERE u.login IN ('deployment-check','legacy-fixture');"
            ) == ("3" if legacy else "2")
            backup = temp / "backup.dump"
            run(["bash", "scripts/backup-postgres.sh", str(backup)], env=env)
            assert backup.stat().st_mode & 0o777 == 0o600
            assert (
                run(
                    ["bash", "scripts/backup-postgres.sh", str(backup)],
                    env=env,
                    success=False,
                ).returncode
                != 0
            )
            assert (
                run(
                    [
                        "bash",
                        "scripts/restore-postgres.sh",
                        str(backup),
                        "deployment_check",
                    ],
                    env=env,
                    success=False,
                ).returncode
                != 0
            )
            run(
                [
                    "bash",
                    "scripts/restore-postgres.sh",
                    str(backup),
                    "restore_deployment_check",
                ],
                env=env,
            )
            assert sql(snapshot, "restore_deployment_check") == expected
            assert (
                run(
                    [
                        "bash",
                        "scripts/restore-postgres.sh",
                        str(backup),
                        "restore_deployment_check",
                    ],
                    env=env,
                    success=False,
                ).returncode
                != 0
            )
            dc(
                "run",
                "--rm",
                "-T",
                "-e",
                "DATABASE_NAME=restore_deployment_check",
                "migrate",
                "python",
                "scripts/check_migrations.py",
            )
            database_acls = "SELECT jsonb_agg(jsonb_build_array(datname,datacl) ORDER BY datname) FROM pg_database"
            before_switch = sql(database_acls)
            rejected = run(
                ["bash", "scripts/configure-postgres.sh", "restore_deployment_check"],
                env=env,
                success=False,
            )
            assert (
                rejected.returncode != 0
                and "Stop all API containers" in rejected.stderr
            )
            assert sql(database_acls) == before_switch
            # A new engine connection must still work after the rejected switch.
            dc(
                "exec",
                "-T",
                "api",
                "sh",
                "docker-entrypoint.sh",
                "python",
                "scripts/check_migrations.py",
            )
            print(
                "PASS: live API blocks database switch before ACL changes; new connections work",
                flush=True,
            )
            # Switch only this isolated stack to the verified restore, then back.
            dc("stop", "nginx", "api")
            wait_for_stopped_api_containers()
            run(
                ["bash", "scripts/configure-postgres.sh", "restore_deployment_check"],
                env=env,
            )
            recovery = temp / "recovery.yaml"
            recovery.write_text("""services:
  api:
    environment:
      DATABASE_NAME: restore_deployment_check
""")
            run(
                [
                    *compose,
                    "-f",
                    str(recovery),
                    "up",
                    "-d",
                    "--force-recreate",
                    "--wait",
                    "--wait-timeout",
                    "120",
                    "api",
                    "nginx",
                ],
                env=env,
            )
            with httpx.Client(
                base_url=public_origin, verify=context, trust_env=False, timeout=10
            ) as restored:
                assert (
                    restored.post(
                        "/api/v1/auth/login",
                        headers=origin,
                        json={"login": "deployment-check", "password": password},
                    ).status_code
                    == 200
                )
                assert (
                    restored.post("/api/v1/auth/refresh", headers=origin).status_code
                    == 200
                )
                logout = restored.post("/api/v1/auth/logout", headers=origin)
                assert logout.status_code == 200
                assert logout.json() == {"session_revoked": True}
                restored_login = restored.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": "schedule-fixture-1", "password": password},
                )
                assert restored_login.status_code == 200
                restored_schedule = restored.get(
                    "/api/v1/schedule",
                    params={"date_from": "2026-11-10", "date_to": "2026-11-10"},
                    headers={
                        "Authorization": "Bearer "
                        + restored_login.json()["access_token"]
                    },
                )
                restored_academics = restored.get(
                    "/api/v1/academics",
                    headers={
                        "Authorization": "Bearer "
                        + restored_login.json()["access_token"]
                    },
                )
                restored_notifications = restored.get(
                    "/api/v1/notifications",
                    headers={
                        "Authorization": "Bearer "
                        + restored_login.json()["access_token"]
                    },
                )
                assert restored_notifications.status_code == 200
                assert restored_notifications.json() == notifications.json()
                assert restored_academics.status_code == 200
                assert restored_academics.json()["items"] == academic_items
                assert restored_schedule.status_code == 200
                assert restored_schedule.json()["items"] == items
                restored_profile = restored.get(
                    "/api/v1/users/me",
                    headers={
                        "Authorization": "Bearer "
                        + restored_login.json()["access_token"]
                    },
                )
                assert restored_profile.status_code == 200
                assert restored_profile.json() == first_profile
                print(
                    "PASS: restored schedule data and restricted API permissions survive recovery",
                    flush=True,
                )
            assert sql(snapshot) == expected
            # Even when Compose/db still names the old DB, inspect the recovery API's
            # actual runtime DATABASE_NAME. Implicit switch-back must be refused too.
            before_switch = sql(database_acls)
            rejected = run(
                ["bash", "scripts/configure-postgres.sh"], env=env, success=False
            )
            assert (
                rejected.returncode != 0
                and "Stop all API containers" in rejected.stderr
            )
            assert sql(database_acls) == before_switch
            dc("stop", "nginx", "api")
            wait_for_stopped_api_containers()
            run(["bash", "scripts/configure-postgres.sh"], env=env)
            print(
                "PASS: restored database HTTPS login/refresh/logout; source unchanged",
                flush=True,
            )
            dc("down")
            dc("up", "-d", "--wait", "--wait-timeout", "120")
            assert sql(snapshot) == expected
            run(["bash", "scripts/migrate-postgres.sh"], env=env)
            dc(
                "up",
                "-d",
                "--force-recreate",
                "--wait",
                "--wait-timeout",
                "120",
                "api",
                "nginx",
            )
            assert sql(snapshot) == expected
            print(
                "PASS: backup/restore records, FK links, Alembic; persistent volume; repeat update",
                flush=True,
            )
            logs = dc("logs", "api", "db", "nginx").stdout
            for name in ("jwt", "password", "api_password", "migration_password"):
                value = (temp / name).read_text()
                assert value not in logs and value not in dc("config").stdout
                dc(
                    "exec",
                    "-T",
                    "nginx",
                    "sh",
                    "-c",
                    "if grep -R -F -q -f /dev/stdin /usr/share/nginx/html; then exit 1; fi",
                    input=value,
                )
            print(
                "PASS: secrets absent from logs, Compose values and frontend bundle",
                flush=True,
            )
        finally:
            for number in (1, 2):
                run(["docker", "rm", "-f", f"{project}-client-{number}"], success=False)
            dc("down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    with resolve_test_hostname():
        main()
        main(legacy=True)
