#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# -le 1 ]] || { echo 'Usage: configure-postgres.sh [database]' >&2; exit 1; }
bash "$repo_root/scripts/production-compose.sh" exec -T db \
    sh /opt/uni-space-postgres/configure.sh "${1:-}"
