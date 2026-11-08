#!/bin/sh
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
    exec "$@"
fi

export DATABASE_URL="$(python -c '
import os

from app.core.config import create_database_url

print(create_database_url(
    username=os.environ["DATABASE_USER"],
    password=os.environ["DATABASE_PASSWORD"],
    host=os.environ["DATABASE_HOST"],
    port=int(os.environ["DATABASE_PORT"]),
    database=os.environ["DATABASE_NAME"],
))
')"

exec "$@"
