#!/usr/bin/env bash
# Local PostgreSQL for development and for scripts/prod.sh (no root needed).
# PostgreSQL binaries come from ../.devenv (a conda environment) when present, otherwise from PATH.
# The role, database and port are taken from DATABASE_URL (environment, else .env), default
# postgres://texdraft@127.0.0.1:5433/texdraft.
#   bash scripts/dev-services.sh start|stop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVENV="${DEVENV:-$ROOT/../.devenv}"
[ -d "$DEVENV/bin" ] && export PATH="$DEVENV/bin:$PATH"
PGDATA="$ROOT/.devdata/pg"

URL="${DATABASE_URL:-$(grep -sE '^DATABASE_URL=' "$ROOT/.env" | tail -1 | cut -d= -f2- || true)}"
URL="${URL:-postgres://texdraft@127.0.0.1:5433/texdraft}"
rest="${URL#*://}"                 # user[:pass]@host:port/db
creds="${rest%%@*}"
DBUSER="${creds%%:*}"
hostport="${rest#*@}"; hostport="${hostport%%/*}"
DBNAME="${rest##*/}"; DBNAME="${DBNAME%%\?*}"
PGPORT="${PGPORT:-${hostport##*:}}"
[ "$PGPORT" = "$hostport" ] && PGPORT=5432

case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      mkdir -p "$PGDATA"
      initdb -D "$PGDATA" -U "$DBUSER" --auth=trust -E UTF8 >/dev/null
      echo "initialized $PGDATA"
    fi
    if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
      echo "postgres already running"
    else
      pg_ctl -D "$PGDATA" -l "$ROOT/.devdata/pg.log" -o "-p $PGPORT -k /tmp" -w start
    fi
    psql -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='$DBNAME'" | grep -q 1 \
      || createdb -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" "$DBNAME"
    echo "postgres ready on 127.0.0.1:$PGPORT (database $DBNAME)"
    ;;
  stop)
    pg_ctl -D "$PGDATA" -m fast stop || true
    ;;
  *) echo "usage: $0 start|stop"; exit 1 ;;
esac
