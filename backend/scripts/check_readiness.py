"""Check the real HTTP process and the database's migration heads without a new API."""

from urllib.request import ProxyHandler, build_opener

from check_migrations import main as check_migrations

try:
    with build_opener(ProxyHandler({})).open(
        "http://127.0.0.1:8000/api/openapi.json", timeout=2
    ) as response:
        if response.status != 200:
            raise RuntimeError("API is not ready")
    check_migrations()
except Exception:
    # Connection exceptions may include credentials; keep Docker health logs safe.
    raise SystemExit("API HTTP/database/migration readiness check failed") from None
