#!/usr/bin/env bash
set -Eeuo pipefail
set -m

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
umask 077
mkdir -p work
FIXTURE_ENV="$(mktemp "$ROOT_DIR/work/password-browser.env.XXXXXXXX")"
API_LOG="$ROOT_DIR/work/password-browser-api.log"
VITE_LOG="$ROOT_DIR/work/password-browser-vite.log"
API_PID=""
VITE_PID=""

: "${APP_ENV:=test}"
: "${DATABASE_URL:=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test}"
: "${JWT_SIGNING_KEY:=test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ}"
: "${COOKIE_SECURE:=false}"
: "${API_PORT:=8000}"
: "${VITE_PORT:=5173}"
: "${API_PROXY_TARGET:=http://localhost:$API_PORT}"
: "${ALLOWED_ORIGINS:=[\"http://localhost:$VITE_PORT\"]}"
: "${PLAYWRIGHT_MODULE:?Set PLAYWRIGHT_MODULE to the pinned Playwright 1.57.0 module path}"
: "${PASSWORD_TEST_PYTHON_VERSION:=3.12.16}"
export APP_ENV DATABASE_URL JWT_SIGNING_KEY COOKIE_SECURE ALLOWED_ORIGINS API_PORT VITE_PORT API_PROXY_TARGET

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  for pid in "$API_PID" "$VITE_PID"; do
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ -n "${PASSWORD_E2E_SUFFIX:-}" ]]; then
    UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uni-space-uv-cache}" uv run --locked \
      --python "$PASSWORD_TEST_PYTHON_VERSION" --project backend \
      python backend/scripts/cleanup_password_browser_fixtures.py || cleanup_status=$?
  fi
  rm -f "$FIXTURE_ENV"
  if (( status != 0 )); then
    echo "Password browser E2E failed (exit $status). API log tail:"
    tail -n 40 "$API_LOG" 2>/dev/null || true
    echo "Vite log tail:"
    tail -n 20 "$VITE_LOG" 2>/dev/null || true
  fi
  if (( status == 0 )); then status=$cleanup_status; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$APP_ENV" != test || ! "$DATABASE_URL" =~ ^postgresql\+psycopg://uni_space_test:test-only-password@(localhost|127\.0\.0\.1):[0-9]+/uni_space_test$ ]]; then
  echo 'Refusing to run password browser E2E outside localhost uni_space_test.' >&2
  exit 2
fi
API_PORT="$API_PORT" VITE_PORT="$VITE_PORT" python3 - <<'PY'
import os
import socket
for port in (int(os.environ["API_PORT"]), int(os.environ["VITE_PORT"])):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))
PY

uv run --locked --python "$PASSWORD_TEST_PYTHON_VERSION" --project backend \
  alembic -c backend/alembic.ini upgrade head
PYTHONPATH=backend uv run --locked --python "$PASSWORD_TEST_PYTHON_VERSION" --project backend \
  python backend/scripts/seed_password_browser_fixtures.py > "$FIXTURE_ENV"
[[ "$(stat -c '%a' "$FIXTURE_ENV")" == 600 ]]
set -a
source "$FIXTURE_ENV"
set +a
export PASSWORD_E2E_URL="http://localhost:$VITE_PORT" PLAYWRIGHT_MODULE

(cd backend && exec uv run --locked --python "$PASSWORD_TEST_PYTHON_VERSION" python \
  scripts/password_e2e_server.py) > "$API_LOG" 2>&1 &
API_PID=$!
(cd frontend && exec npm run dev -- --host 127.0.0.1 --port "$VITE_PORT" --strictPort) > "$VITE_LOG" 2>&1 &
VITE_PID=$!

ready=false
for _ in $(seq 1 90); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:$API_PORT/api/openapi.json" >/dev/null \
    && curl --silent --fail --max-time 2 "http://127.0.0.1:$VITE_PORT/login" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'API or Vite did not become ready.' >&2; exit 1; }
node frontend/e2e/password.browser.mjs
