#!/bin/sh
set -eu
# Runs only in db, never in the API image/container. No passwords in argv or SQL files.
export PGPASSWORD="$(cat /run/secrets/postgres_password)"
export API_DB_PASSWORD="$(cat /run/secrets/api_db_password)"
export MIGRATION_DB_PASSWORD="$(cat /run/secrets/migration_db_password)"
[ "${#API_DB_PASSWORD}" -ge 32 ] && [ "${#MIGRATION_DB_PASSWORD}" -ge 32 ] &&
[ "$API_DB_PASSWORD" != "$MIGRATION_DB_PASSWORD" ] &&
[ "$API_DB_PASSWORD" != "$PGPASSWORD" ] && [ "$MIGRATION_DB_PASSWORD" != "$PGPASSWORD" ] || {
    echo 'Database secrets must be distinct; application/migration passwords need at least 32 characters' >&2
    exit 1
}
target=${1:-$POSTGRES_DB}
[ "$POSTGRES_USER" != uni_space_api ] && [ "$POSTGRES_USER" != uni_space_migrator ] || {
    echo 'Admin must be distinct from application and migration roles' >&2; exit 1;
}
psql --host="$HOSTNAME" --username="$POSTGRES_USER" --dbname="$target" \
    --no-password -X -q -v ON_ERROR_STOP=1 -f /opt/uni-space-postgres/privileges.sql
