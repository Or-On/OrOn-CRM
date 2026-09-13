#!/usr/bin/env bash
set -Eeuo pipefail

readonly ORON_ROOT="${ORON_ROOT:-/opt/oron-dev}"
readonly SHARED_DIR="${ORON_ROOT}/shared"
readonly CURRENT_LINK="${ORON_ROOT}/current"
readonly BACKUP_DIR="${ORON_ROOT}/backups"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run backup as root" >&2
  exit 1
fi
if [[ ${ORON_ROOT} != /opt/oron-dev || ! -L ${CURRENT_LINK} ]]; then
  echo "No active Or-On DEV release is available" >&2
  exit 1
fi
exec 9>/run/lock/oron-dev-backup.lock
flock --nonblock 9 || { echo "Another backup is already running" >&2; exit 1; }
umask 077
# shellcheck disable=SC1091
source "${SHARED_DIR}/deployment.env"
release="$(readlink -f "${CURRENT_LINK}")"
compose=(docker compose --env-file "${SHARED_DIR}/deployment.env" \
  --env-file "${release}/images.env" --file "${release}/infra/compose/deployment.yaml")
install -d -m 0700 -o root -g root "${BACKUP_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary="${BACKUP_DIR}/.${DEPLOYMENT_DATABASE_NAME}-${timestamp}.dump.tmp"
destination="${BACKUP_DIR}/${DEPLOYMENT_DATABASE_NAME}-${timestamp}.dump"
trap 'rm -f -- "${temporary}"' EXIT
"${compose[@]}" exec --no-TTY postgres pg_dump --format=custom --no-owner \
  --username platform_migrator --dbname "${DEPLOYMENT_DATABASE_NAME}" >"${temporary}"
[[ -s ${temporary} ]] || { echo "Backup output was empty" >&2; exit 1; }
mv -- "${temporary}" "${destination}"
chmod 0600 "${destination}"
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'dev_*.dump' -mtime +7 -delete
echo "Created ${destination}"
