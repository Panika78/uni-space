#!/usr/bin/env bash
# Runs against an existing isolated database/API/Vite by default. CI supplies these.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${APP_ENV:=test}"
: "${DATABASE_URL:=postgresql+psycopg://uni_space_test:test-only-password@127.0.0.1:55432/uni_space_test}"
: "${JWT_SIGNING_KEY:=test-only-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ}"
: "${NOTIFICATION_TEST_PYTHON_VERSION:=3.12.16}"
export APP_ENV DATABASE_URL JWT_SIGNING_KEY NOTIFICATION_TEST_PYTHON_VERSION
mkdir -p work
export NOTIFICATION_FIXTURE_FILE="$PWD/work/notifications-fixture.json"
PYTHONPATH=backend uv run --locked --python "$NOTIFICATION_TEST_PYTHON_VERSION" --project backend \
  python frontend/e2e/notifications-fixtures.py > "$NOTIFICATION_FIXTURE_FILE"
node frontend/e2e/notifications-read.browser.mjs
