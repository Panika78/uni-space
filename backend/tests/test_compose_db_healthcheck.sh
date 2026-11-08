#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

restore_database() {
    docker compose rm -sf db >/dev/null 2>&1 || true
    docker compose up -d --wait db >/dev/null 2>&1 || true
}
trap restore_database EXIT

docker compose rm -sf db >/dev/null
docker compose up -d --wait db >/dev/null
db_container=$(docker compose ps -q db)
test "$(docker inspect --format '{{.State.Health.Status}}' "$db_container")" = "healthy"
printf 'correct password health -> healthy\n'

docker compose rm -sf db >/dev/null
POSTGRES_PASSWORD=incorrect-healthcheck-test docker compose up -d db >/dev/null
db_container=$(docker compose ps -q db)

health_status=starting
for ((attempt = 1; attempt <= 45; attempt++)); do
    health_status=$(docker inspect --format '{{.State.Health.Status}}' "$db_container")
    if [ "$health_status" = "unhealthy" ]; then
        break
    fi
    if [ "$health_status" = "healthy" ]; then
        printf 'incorrect password unexpectedly became healthy\n' >&2
        exit 1
    fi
    sleep 1
done

test "$health_status" = "unhealthy"
if docker inspect --format '{{json .State.Health.Log}}' "$db_container" \
    | grep -F 'incorrect-healthcheck-test' >/dev/null; then
    printf 'health diagnostics exposed the test password\n' >&2
    exit 1
fi
printf 'incorrect password health -> unhealthy\n'
printf 'health diagnostics secret probe -> absent\n'

docker compose rm -sf db >/dev/null
docker compose up -d --wait db >/dev/null
db_container=$(docker compose ps -q db)
test "$(docker inspect --format '{{.State.Health.Status}}' "$db_container")" = "healthy"
trap - EXIT
printf 'restored password health -> healthy\n'
