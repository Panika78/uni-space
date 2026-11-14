#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p work
rm -f work/news-browser-failure.png work/news-browser-detail.png
FIXTURE_ENV="$ROOT_DIR/work/news-browser.env"
API_LOG="$ROOT_DIR/work/news-browser-api.log"
VITE_LOG="$ROOT_DIR/work/news-browser-vite.log"
rm -f "$API_LOG" "$VITE_LOG"
PYTHON_VERSION="${NEWS_TEST_PYTHON_VERSION:-3.12.16}"
export NEWS_TEST_PYTHON_VERSION="$PYTHON_VERSION"
API_PID=""
VITE_PID=""
TEST_PID=""
MANAGE_COMPOSE="${NEWS_TEST_MANAGE_COMPOSE:-0}"
COMPOSE_CLEANUP_REQUIRED=0
COMPOSE_FILE=compose.test.yaml
COMPOSE_PROJECT=uni-space-test
: "${APP_ENV:=test}"
: "${DATABASE_URL:=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test}"
: "${JWT_SIGNING_KEY:=test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ}"
: "${COOKIE_SECURE:=false}"
: "${ALLOWED_ORIGINS:=[\"http://localhost:5173\"]}"
export APP_ENV DATABASE_URL JWT_SIGNING_KEY COOKIE_SECURE ALLOWED_ORIGINS

cleanup() {
  local status=$?
  local cleanup_status=0
  local attempt
  trap - EXIT INT TERM
  rm -f "$FIXTURE_ENV"
  for pid in "$TEST_PID" "$API_PID" "$VITE_PID"; do
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || true
    fi
  done
  for attempt in $(seq 1 10); do
    local active=false
    for pid in "$TEST_PID" "$API_PID" "$VITE_PID"; do
      if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
        active=true
      fi
    done
    [[ "$active" == false ]] && break
    sleep 0.2
  done
  for pid in "$TEST_PID" "$API_PID" "$VITE_PID"; do
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  if [[ "$COMPOSE_CLEANUP_REQUIRED" == 1 ]]; then
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans \
      || cleanup_status=$?
  fi
  if (( status != 0 )); then
    echo "News browser E2E failed (exit $status). Recent server logs:"
    tail -n 60 "$API_LOG" "$VITE_LOG" 2>/dev/null || true
  fi
  if (( cleanup_status != 0 )); then
    echo "News E2E Compose cleanup failed (exit $cleanup_status)." >&2
    if (( status == 0 )); then
      status=$cleanup_status
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$APP_ENV" != test || ! "$DATABASE_URL" =~ ^postgresql\+psycopg://uni_space_test:test-only-password@(localhost|127\.0\.0\.1):[0-9]+/uni_space_test$ ]]; then
  echo 'Refusing to run news browser E2E outside a localhost uni_space_test database.' >&2
  exit 2
fi
if [[ -z "${PLAYWRIGHT_MODULE:-}" ]]; then
  echo 'Set PLAYWRIGHT_MODULE to the pinned Playwright 1.57.0 module path.' >&2
  exit 2
fi
if [[ "$MANAGE_COMPOSE" != 0 && "$MANAGE_COMPOSE" != 1 ]]; then
  echo 'NEWS_TEST_MANAGE_COMPOSE must be 0 or 1.' >&2
  exit 2
fi

if ! python3 - <<'PY'
import socket
import sys

conflicts = []
for port in (8000, 5173):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", port))
    except OSError:
        conflicts.append(port)
if conflicts:
    print("News E2E port conflict on 127.0.0.1:" + ", 127.0.0.1:".join(map(str, conflicts)))
    sys.exit(1)
PY
then
  echo 'Free ports 8000 and 5173 before running news browser E2E.' >&2
  exit 2
fi

if [[ "$MANAGE_COMPOSE" == 1 ]]; then
  COMPOSE_CLEANUP_REQUIRED=1
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --wait test-db
fi

uv run --locked --python "$PYTHON_VERSION" --project backend alembic -c backend/alembic.ini upgrade head
PYTHONPATH=backend uv run --locked --python "$PYTHON_VERSION" --project backend \
  python backend/scripts/seed_news_browser_fixtures.py > "$FIXTURE_ENV"
chmod 600 "$FIXTURE_ENV"
# The file contains only short-lived, fictional test credentials and is removed by cleanup.
set -a
source "$FIXTURE_ENV"
set +a
export NEWS_TEST_URL=http://localhost:5173

setsid bash -c 'cd backend && exec uv run --locked --python "$NEWS_TEST_PYTHON_VERSION" uvicorn app.main:app --no-access-log --host 127.0.0.1 --port 8000' \
  > "$API_LOG" 2>&1 < /dev/null &
API_PID=$!
setsid bash -c 'cd frontend && exec npm run dev -- --host 127.0.0.1 --strictPort' \
  > "$VITE_LOG" 2>&1 < /dev/null &
VITE_PID=$!

ready=false
for attempt in $(seq 1 90); do
  if ! kill -0 -- "-$API_PID" 2>/dev/null; then
    echo 'The news API process exited before readiness.' >&2
    break
  fi
  if ! kill -0 -- "-$VITE_PID" 2>/dev/null; then
    echo 'The Vite process exited before readiness.' >&2
    break
  fi
  if curl --silent --fail --max-time 2 http://127.0.0.1:8000/api/openapi.json >/dev/null \
    && curl --silent --fail --max-time 2 http://127.0.0.1:5173/login >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'API or Vite did not become ready within 90 seconds.' >&2
  exit 1
fi

setsid env PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" node frontend/e2e/news.browser.mjs &
TEST_PID=$!
set +e
completed_pid=""
wait -n -p completed_pid "$API_PID" "$VITE_PID" "$TEST_PID"
completed_status=$?
set -e
if [[ "$completed_pid" != "$TEST_PID" ]]; then
  echo "A news E2E server process exited before the browser test (exit $completed_status)." >&2
  exit 1
fi
TEST_PID=""
if (( completed_status != 0 )); then
  exit "$completed_status"
fi
if ! kill -0 -- "-$API_PID" 2>/dev/null \
  || ! kill -0 -- "-$VITE_PID" 2>/dev/null \
  || ! curl --silent --fail --max-time 2 http://127.0.0.1:8000/api/openapi.json >/dev/null \
  || ! curl --silent --fail --max-time 2 http://127.0.0.1:5173/login >/dev/null; then
  echo 'A news E2E server stopped before the browser run completed.' >&2
  exit 1
fi
if [[ "$COMPOSE_CLEANUP_REQUIRED" == 1 ]]; then
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans
  COMPOSE_CLEANUP_REQUIRED=0
fi
