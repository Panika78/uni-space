#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# = 1 ]] || { echo 'Usage: backup-postgres.sh /private/path/backup.dump' >&2; exit 1; }
umask 077
output=$1
[[ ! -e "$output" ]] || { echo 'Backup destination already exists' >&2; exit 1; }
temporary=$(mktemp "${output}.partial.XXXXXX")
trap 'rm -f "$temporary"' EXIT
bash "$repo_root/scripts/production-compose.sh" exec -T db sh -ec '
    export PGPASSWORD="$(cat /run/secrets/postgres_password)"
    exec pg_dump --host="$HOSTNAME" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
        --no-password --format=custom --no-owner --no-privileges
' > "$temporary"
# Atomic publication without replacing an earlier backup (including races).
ln "$temporary" "$output"
echo 'Backup completed'
