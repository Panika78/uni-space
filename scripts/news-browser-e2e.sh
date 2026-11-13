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

cleanup() {
  local status=$?
  local attempt
  trap - EXIT INT TERM
  rm -f "$FIXTURE_ENV"
  for pid in "$API_PID" "$VITE_PID"; do
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || true
    fi
  done
  for attempt in $(seq 1 10); do
    local active=false
    for pid in "$API_PID" "$VITE_PID"; do
      if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
        active=true
      fi
    done
    [[ "$active" == false ]] && break
    sleep 0.2
  done
  for pid in "$API_PID" "$VITE_PID"; do
    if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || true
    fi
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
  if (( status != 0 )); then
    echo "News browser E2E failed (exit $status). Recent server logs:"
    tail -n 60 "$API_LOG" "$VITE_LOG" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

: "${APP_ENV:=test}"
: "${DATABASE_URL:=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test}"
: "${JWT_SIGNING_KEY:=test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ}"
: "${COOKIE_SECURE:=false}"
: "${ALLOWED_ORIGINS:=[\"http://localhost:5173\"]}"
export APP_ENV DATABASE_URL JWT_SIGNING_KEY COOKIE_SECURE ALLOWED_ORIGINS
if [[ "$APP_ENV" != test || ! "$DATABASE_URL" =~ ^postgresql\+psycopg://uni_space_test:test-only-password@(localhost|127\.0\.0\.1):[0-9]+/uni_space_test$ ]]; then
  echo 'Refusing to run news browser E2E outside a localhost uni_space_test database.' >&2
  exit 2
fi
if [[ -z "${PLAYWRIGHT_MODULE:-}" ]]; then
  echo 'Set PLAYWRIGHT_MODULE to the pinned Playwright 1.57.0 module path.' >&2
  exit 2
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

setsid bash -c 'cd backend && exec uv run --locked --python "$NEWS_TEST_PYTHON_VERSION" uvicorn app.main:app --host 127.0.0.1 --port 8000' \
  > "$API_LOG" 2>&1 < /dev/null &
API_PID=$!
setsid bash -c 'cd frontend && exec npm run dev -- --host 127.0.0.1' \
  > "$VITE_LOG" 2>&1 < /dev/null &
VITE_PID=$!

ready=false
for attempt in $(seq 1 90); do
  if curl --silent --fail http://127.0.0.1:8000/api/openapi.json >/dev/null \
    && curl --silent --fail http://127.0.0.1:5173/login >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'API or Vite did not become ready within 90 seconds.' >&2
  exit 1
fi

PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" node frontend/e2e/news.browser.mjs
