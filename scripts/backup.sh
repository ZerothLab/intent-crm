#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo 'Usage: sh scripts/backup.sh DESTINATION.dump [ENV_FILE] [COMPOSE_FILE]' >&2
  exit 64
fi
destination=$1
case "$destination" in
  /*) ;;
  *) echo 'Backup destination must be an absolute path in a private directory.' >&2; exit 64 ;;
esac
env_file=${2:-.env.docker}
compose_file=${3:-compose.production.yaml}
if [ -e "$destination" ] || [ -L "$destination" ]; then
  echo 'Backup destination already exists. Choose a new filename.' >&2
  exit 1
fi

umask 077
temporary=$(mktemp "${destination}.partial.XXXXXX")
trap 'rm -f "$temporary"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$temporary"
test -s "$temporary" || { echo 'Database backup was empty.' >&2; exit 1; }
docker compose --env-file "$env_file" -f "$compose_file" exec -T postgres \
  pg_restore --list < "$temporary" > /dev/null

# A hard link publishes the completed archive without overwriting another backup.
ln "$temporary" "$destination"
echo 'Database backup completed and its archive index was verified.'
