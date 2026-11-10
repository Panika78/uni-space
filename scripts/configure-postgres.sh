#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# -le 1 ]] || { echo 'Usage: configure-postgres.sh [database]' >&2; exit 1; }
target=${1:-$(bash "$repo_root/scripts/production-compose.sh" exec -T db printenv POSTGRES_DB)}
# Inspect runtime containers, not the possibly already edited env/Compose config.
# Compose labels also include one-off/paused/restarting API containers.
# A Docker listing/inspection failure must fail closed before executing SQL.
containers=$(docker ps -q \
    --filter "label=com.docker.compose.project=${PROD_PROJECT_NAME:-uni-space-prod}" \
    --filter label=com.docker.compose.service=api)
for container in $containers; do
    container_env=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container")
    running_database=
    database_url=
    while IFS= read -r setting; do
        case "$setting" in
            DATABASE_NAME=*) running_database=${setting#DATABASE_NAME=} ;;
            DATABASE_URL=*) database_url=${setting#DATABASE_URL=} ;;
        esac
    done <<< "$container_env"
    if [[ -n "$database_url" || -z "$running_database" || "$running_database" != "$target" ]]; then
        echo 'Stop all API containers before switching database (or when runtime database is unknown)' >&2
        exit 1
    fi
done
bash "$repo_root/scripts/production-compose.sh" exec -T db \
    sh /opt/uni-space-postgres/configure.sh "$target"
