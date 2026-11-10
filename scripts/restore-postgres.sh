#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# = 2 ]] || { echo 'Usage: restore-postgres.sh backup.dump restore_new_database' >&2; exit 1; }
[[ -s "$1" ]] || { echo 'Backup is missing or empty' >&2; exit 1; }
# Only NEW, explicitly named recovery databases. Never clean or overwrite a database.
[[ "$2" =~ ^restore_[a-z0-9_]+$ && ${#2} -le 63 ]] || {
    echo 'Target must start with restore_ and contain only lowercase letters, digits, underscores' >&2
    exit 1
}
bash "$repo_root/scripts/production-compose.sh" exec -T db sh -ec '
    export PGPASSWORD="$(cat /run/secrets/postgres_password)"
    test "$1" != "$POSTGRES_DB" || { echo "Cannot restore over the working database" >&2; exit 1; }
    psql --host="$HOSTNAME" --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password -X -q -v ON_ERROR_STOP=1 -v target="$1" <<SQL
CREATE DATABASE :"target" WITH TEMPLATE=template0 OWNER=uni_space_migrator CONNECTION LIMIT=0;
REVOKE ALL ON DATABASE :"target" FROM PUBLIC, uni_space_api;
GRANT CONNECT ON DATABASE :"target" TO uni_space_migrator;
ALTER DATABASE :"target" CONNECTION LIMIT -1;
SQL
    exec pg_restore --host="$HOSTNAME" --username="$POSTGRES_USER" --no-password \
        --dbname="$1" --role=uni_space_migrator --single-transaction --exit-on-error --no-owner --no-privileges
' sh "$2" < "$1"
echo 'Restore completed in a separate database; validate before switching the application'
