#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
[[ $# = 3 ]] || { echo 'Usage: restore-application-data.sh backup-dir restore_database restore_volume' >&2; exit 1; }
backup_dir=$(cd "$1" && pwd)
database=$2
volume=$3
[[ -s "$backup_dir/database.dump" && -s "$backup_dir/attachments.tar.gz" ]] || {
    echo 'Backup directory must contain database.dump and attachments.tar.gz' >&2; exit 1;
}
[[ "$volume" =~ ^restore_[a-z0-9_]+$ && ${#volume} -le 63 ]] || {
    echo 'Target volume must start with restore_ and use lowercase letters, digits, underscores' >&2; exit 1;
}
if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo 'Target volume already exists; refusing to overwrite it' >&2; exit 1
fi
compose=(bash "$repo_root/scripts/production-compose.sh")
api_image=$("${compose[@]}" images -q api | head -n 1)
[[ -n "$api_image" ]] || { echo 'Production API image is missing' >&2; exit 1; }
docker volume create "$volume" >/dev/null
docker run --rm --network none -v "$volume:/restore" -v "$backup_dir:/backup:ro" \
    --entrypoint python "$api_image" -c \
    'import tarfile; from pathlib import Path; root=Path("/restore").resolve(); t=tarfile.open("/backup/attachments.tar.gz", "r:gz"); members=[]
for m in t.getmembers():
 p=(root/m.name).resolve()
 if p != root and root not in p.parents: raise SystemExit("unsafe attachment archive")
 if m.issym() or m.islnk() or not (m.isfile() or m.isdir()): raise SystemExit("unsupported archive entry")
 members.append(m)
t.extractall(root, members=members); [p.chmod(0o700 if p.is_dir() else 0o600) for p in root.rglob("*")]; root.chmod(0o700)'
bash "$repo_root/scripts/restore-postgres.sh" "$backup_dir/database.dump" "$database"
echo "Restored database $database and files to new volume $volume; validate both before switching the application"
