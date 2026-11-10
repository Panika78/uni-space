#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash "$repo_root/scripts/configure-postgres.sh"
bash "$repo_root/scripts/production-compose.sh" run --rm -T migrate alembic upgrade head
bash "$repo_root/scripts/configure-postgres.sh"
