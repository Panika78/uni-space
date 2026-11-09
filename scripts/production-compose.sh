#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${PROD_ENV_FILE:?Set PROD_ENV_FILE to the absolute external production env file}"
[[ "$PROD_ENV_FILE" = /* && -f "$PROD_ENV_FILE" ]] || {
    echo 'PROD_ENV_FILE must be an existing absolute path' >&2; exit 1;
}
exec docker compose --project-name "${PROD_PROJECT_NAME:-uni-space-prod}" \
    --env-file "$PROD_ENV_FILE" --file "$repo_root/compose.prod.yaml" "$@"
