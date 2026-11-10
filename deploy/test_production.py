"""Run real isolated deployment checks using existing project HTTPX; see PRODUCTION.md."""

import json
import os
import secrets
import socket
import ssl
import subprocess
import tempfile
import time
from pathlib import Path

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


def main():
    project = f"uni-space-production-test-{secrets.token_hex(4)}"
    (ROOT / "work").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="production-", dir=ROOT / "work"
    ) as directory:
        temp = Path(directory)
        for name in ("jwt", "password"):
            (temp / name).write_text(
                secrets.token_urlsafe(48) + ("@:/?#$&" if name == "password" else "")
            )
            (temp / name).chmod(0o600)
        run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=uni.test",
                "-addext",
                "subjectAltName=DNS:uni.test,DNS:nginx,IP:127.0.0.1",
                "-keyout",
                str(temp / "tls.key"),
                "-out",
                str(temp / "tls.pem"),
            ]
        )
        http_port, https_port = free_port(), free_port()
        env_file = temp / "production.env"
        env_file.write_text(
            "\n".join(
                [
                    "RELEASE_TAG=task019",
                    "SERVER_NAME=uni.test",
                    f"ALLOWED_ORIGINS='{json.dumps(['https://uni.test', f'https://127.0.0.1:{https_port}'])}'",
                    "POSTGRES_DB=deployment_check",
                    "POSTGRES_USER=deployment_check",
                    f"JWT_SIGNING_KEY_FILE={temp / 'jwt'}",
                    f"POSTGRES_PASSWORD_FILE={temp / 'password'}",
                    f"TLS_CERT_FILE={temp / 'tls.pem'}",
                    f"TLS_KEY_FILE={temp / 'tls.key'}",
                ]
            )
            + "\n"
        )
        override = temp / "ports.yaml"
        override.write_text(f"""services:
  nginx:
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
            "POSTGRES_DB",
            "POSTGRES_USER",
            "JWT_SIGNING_KEY_FILE",
            "POSTGRES_PASSWORD_FILE",
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
            assert (
                dc(
                    "exec",
                    "-T",
                    "api",
                    "sh",
                    "docker-entrypoint.sh",
                    "python",
                    "scripts/check_readiness.py",
                    success=False,
                ).returncode
                != 0
            )
            dc("run", "--rm", "-T", "api", "alembic", "upgrade", "head")
            dc("up", "-d", "--wait", "--wait-timeout", "120")
            dc("exec", "-T", "nginx", "nginx", "-t")
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
            browser_env = env | {
                "PRODUCTION_TEST_URL": f"https://127.0.0.1:{https_port}",
                "PRODUCTION_TEST_CERT_FILE": str(temp / "tls.pem"),
            }
            result = run(["node", "deploy/spa.browser.mjs"], env=browser_env)
            print(result.stdout.strip(), flush=True)
            password = secrets.token_urlsafe(24)
            dc(
                "exec",
                "-T",
                "api",
                "sh",
                "docker-entrypoint.sh",
                "python",
                "-c",
                """
import sys
from argon2 import PasswordHasher
from app.core.database import SessionLocal
from app.models.accounts import User
with SessionLocal.begin() as db:
    db.add(User(login="deployment-check", full_name="Deployment Check", role="admin",
                is_active=True, password_hash=PasswordHasher().hash(sys.stdin.read())))
""",
                input=password,
            )
            context = ssl.create_default_context(cafile=str(temp / "tls.pem"))
            with httpx.Client(
                base_url=f"https://127.0.0.1:{https_port}",
                verify=context,
                trust_env=False,
                headers={"Host": "uni.test"},
                timeout=10,
            ) as client:
                redirect = httpx.get(
                    f"http://127.0.0.1:{http_port}/schedule?day=1",
                    headers={"Host": "attacker.invalid"},
                    trust_env=False,
                )
                assert redirect.status_code == 308
                assert redirect.headers["location"] == "https://uni.test/schedule?day=1"
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
                        f"http://127.0.0.1:{http_port}/schedule",
                        params={"probe": query_marker},
                        headers={"Host": "uni.test"},
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
                assert scheme.headers["location"] == "https://uni.test/api/docs"
                for headers in (
                    {},
                    {"Origin": "http://uni.test"},
                    {"Origin": "https://evil.test"},
                    {"Origin": "null"},
                    [("Origin", "https://uni.test"), ("Origin", "https://uni.test")],
                ):
                    denied = client.post("/api/v1/auth/refresh", headers=headers)
                    assert denied.status_code == 403
                    assert denied.json()["error"]["code"] == "origin_not_allowed"
                origin = {"Origin": "https://uni.test"}
                login = client.post(
                    "/api/v1/auth/login",
                    headers=origin,
                    json={"login": "deployment-check", "password": password},
                )
                assert login.status_code == 200
                cookie = login.headers["set-cookie"].lower()
                for flag in ("secure", "httponly", "samesite=lax", "path=/api/v1/auth"):
                    assert flag in cookie
                assert "domain=" not in cookie
                assert login.headers["cache-control"] == "no-store"
                assert (
                    client.post("/api/v1/auth/refresh", headers=origin).status_code
                    == 200
                )
                assert (
                    client.post("/api/v1/auth/logout", headers=origin).status_code
                    == 204
                )
                assert (
                    client.post("/api/v1/auth/refresh", headers=origin).status_code
                    == 401
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
import socket
for service in ("api", "db"):
    try:
        socket.getaddrinfo(service, None)
    except socket.gaierror:
        pass
    else:
        raise AssertionError("internal service visible on edge network")
for index in range(6):
    c = http.client.HTTPSConnection("nginx", context=context, timeout=5)
    c.request("POST", "/api/v1/auth/login", body="{}", headers={
        "Origin": "https://uni.test", "Content-Type": "application/json",
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
                    ["docker", "exec", "-i", name, "python", "-c", client_code],
                    input=(temp / "tls.pem").read_text(),
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
import http.client
c = http.client.HTTPConnection("api", 8000, timeout=5)
c.request("GET", "/api/docs/", headers={"X-Forwarded-Proto": "https"})
r = c.getresponse()
assert r.status == 307 and r.getheader("Location") == "http://api:8000/api/docs"
r.read()
c.close()
for index in range(6):
    c = http.client.HTTPConnection("api", 8000, timeout=5)
    c.request("POST", "/api/v1/auth/login", body="{}", headers={
        "Origin": "https://uni.test", "Content-Type": "application/json",
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
'sessions', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM auth_sessions t),
'refresh', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM refresh_tokens t),
'revisions', (SELECT jsonb_agg(to_jsonb(t)) FROM alembic_version t));"""
            expected = sql(snapshot)
            assert (
                sql(
                    "SELECT count(*) FROM users u JOIN auth_sessions s ON s.user_id=u.id JOIN refresh_tokens r ON r.session_id=s.id;"
                )
                == "2"
            )
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
                "api",
                "python",
                "scripts/check_migrations.py",
            )
            dc("down")
            dc("up", "-d", "--wait", "--wait-timeout", "120")
            assert sql(snapshot) == expected
            dc("run", "--rm", "-T", "api", "alembic", "upgrade", "head")
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
            for name in ("jwt", "password"):
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
    main()
