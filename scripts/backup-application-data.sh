#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# = 1 ]] || { echo 'Usage: backup-application-data.sh /private/path/new-backup-dir' >&2; exit 1; }
destination=$1
[[ "$destination" = /* && ! -e "$destination" ]] || {
    echo 'Destination must be a new absolute path' >&2; exit 1;
}
umask 077
mkdir -m 700 "$destination"
compose=(bash "$repo_root/scripts/production-compose.sh")
api_container=$("${compose[@]}" ps -aq api | head -n 1)
[[ -n "$api_container" ]] || { rmdir "$destination"; echo 'Production API container is missing' >&2; exit 1; }
api_image=$(docker inspect --format '{{.Config.Image}}' "$api_container")
stopped=0
restart_api() { if [[ "$stopped" = 1 ]]; then "${compose[@]}" start api >/dev/null; fi; }
stopped=1
trap restart_api EXIT
"${compose[@]}" stop api >/dev/null
bash "$repo_root/scripts/backup-postgres.sh" "$destination/database.dump"
# The API is stopped, so the database dump and volume archive describe one state.
docker run --rm --network none --volumes-from "$api_container:ro" \
    --entrypoint python "$api_image" -c \
    'import sys, tarfile; from pathlib import Path; root=Path("/var/lib/uni-space/attachments"); tar=tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz"); [tar.add(path, arcname=path.relative_to(root)) for path in root.rglob("*") if path.is_file() and not path.is_symlink()]; tar.close()' \
    > "$destination/attachments.tar.gz"
chmod 600 "$destination/database.dump" "$destination/attachments.tar.gz"
echo 'Consistent database and attachment backup completed'
