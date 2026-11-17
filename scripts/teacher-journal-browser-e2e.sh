#!/usr/bin/env bash
set -Eeuo pipefail
set -m

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
umask 077
TEMP_DIR="$(mktemp -d /tmp/uni-space-teacher-journal.XXXXXXXX)"
UV_CACHE_DIR="${UV_CACHE_DIR:-$TEMP_DIR/uv-cache}"
PYTHON_TEST_VERSION="${TEACHER_JOURNAL_TEST_PYTHON_VERSION:-3.12.16}"
API_LOG="$TEMP_DIR/api.log"
VITE_LOG="$TEMP_DIR/vite.log"
FIXTURE_ENV="$TEMP_DIR/fixtures.env"
API_PID=""
VITE_PID=""
TEST_PID=""
COMPOSE_FILE=compose.test.yaml
COMPOSE_PROJECT=uni-space-test
COMPOSE_CLEANUP_REQUIRED=0
: "${APP_ENV:=test}"
: "${DATABASE_URL:=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test}"
: "${JWT_SIGNING_KEY:=test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ}"
: "${COOKIE_SECURE:=false}"
: "${ALLOWED_ORIGINS:=[\"http://localhost:5173\"]}"
export APP_ENV DATABASE_URL JWT_SIGNING_KEY COOKIE_SECURE ALLOWED_ORIGINS UV_CACHE_DIR PYTHON_TEST_VERSION
PLAYWRIGHT_MODULE="${PLAYWRIGHT_MODULE:-/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs}"
CHROMIUM_PATH="${CHROMIUM_PATH:-$(command -v chromium || true)}"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  for pid in "$TEST_PID" "$API_PID" "$VITE_PID"; do
    [[ -z "$pid" ]] || kill -- "-$pid" 2>/dev/null || true
  done
  for pid in "$TEST_PID" "$API_PID" "$VITE_PID"; do
    [[ -z "$pid" ]] || wait "$pid" 2>/dev/null || true
  done
  if [[ "$COMPOSE_CLEANUP_REQUIRED" == 1 ]]; then
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans
  fi
  if (( status != 0 )); then
    echo 'Teacher journal browser E2E failed; recent API and Vite logs:'
    tail -n 80 "$API_LOG" "$VITE_LOG" 2>/dev/null || true
  fi
  rm -rf "$TEMP_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$APP_ENV" != test || ! "$DATABASE_URL" =~ ^postgresql\+psycopg://uni_space_test:test-only-password@(localhost|127\.0\.0\.1):[0-9]+/uni_space_test$ ]]; then
  echo 'Refusing to run teacher journal E2E outside localhost uni_space_test.' >&2
  exit 2
fi
if [[ ! -f "$PLAYWRIGHT_MODULE" ]]; then
  echo 'Set PLAYWRIGHT_MODULE to an installed Playwright module.' >&2
  exit 2
fi

COMPOSE_CLEANUP_REQUIRED=1
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down --volumes --remove-orphans
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d --wait test-db
uv run --locked --python "$PYTHON_TEST_VERSION" --project backend alembic -c backend/alembic.ini upgrade head
PYTHONPATH=backend uv run --locked --python "$PYTHON_TEST_VERSION" --project backend \
  python frontend/e2e/teacher-journal-fixtures.py > "$FIXTURE_ENV"
set -a
source "$FIXTURE_ENV"
set +a
export PLAYWRIGHT_MODULE CHROMIUM_PATH
export TEACHER_JOURNAL_TEST_URL=http://localhost:5173

(cd backend && exec uv run --locked --python "$PYTHON_TEST_VERSION" uvicorn app.main:app --no-access-log --host 127.0.0.1 --port 8000) > "$API_LOG" 2>&1 < /dev/null &
API_PID=$!
(cd frontend && exec npm run dev -- --host 127.0.0.1 --strictPort) > "$VITE_LOG" 2>&1 < /dev/null &
VITE_PID=$!

ready=false
for attempt in $(seq 1 90); do
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

node frontend/e2e/teacher-journal.browser.mjs &
TEST_PID=$!
wait "$TEST_PID"
TEST_PID=""
