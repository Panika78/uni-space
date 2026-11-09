#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

project_name="uni-space-healthcheck-${BASHPID}-${RANDOM}"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/uni-space-healthcheck.XXXXXX")
env_file="$temp_dir/test.env"
override_file="$temp_dir/compose.override.yaml"

cat > "$env_file" <<'EOF'
POSTGRES_DB=uni_space_healthcheck_test
POSTGRES_USER=uni_space_healthcheck_test
POSTGRES_PASSWORD=healthcheck-test-password
EOF

cat > "$override_file" <<'EOF'
services:
  db:
    ports: !override []
EOF

compose=(
    docker compose
    --project-name "$project_name"
    --env-file "$env_file"
    --file "$repo_root/compose.yaml"
    --file "$override_file"
)

cleanup() {
    local result=$?
    trap - EXIT
    if ! "${compose[@]}" down --volumes --remove-orphans; then
        printf 'failed to clean isolated Compose project %s\n' "$project_name" >&2
        result=1
    fi
    rm -rf "$temp_dir"
    exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'isolated Compose project: %s\n' "$project_name"
"${compose[@]}" up -d --wait db >/dev/null
db_container=$("${compose[@]}" ps -q db)
test "$(docker inspect --format '{{.State.Health.Status}}' "$db_container")" = "healthy"
printf 'correct password health -> healthy\n'

"${compose[@]}" rm -sf db >/dev/null
POSTGRES_PASSWORD=incorrect-healthcheck-test "${compose[@]}" up -d db >/dev/null
db_container=$("${compose[@]}" ps -q db)

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

"${compose[@]}" rm -sf db >/dev/null
"${compose[@]}" up -d --wait db >/dev/null
db_container=$("${compose[@]}" ps -q db)
test "$(docker inspect --format '{{.State.Health.Status}}' "$db_container")" = "healthy"
printf 'restored password health -> healthy\n'
