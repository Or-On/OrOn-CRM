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
temporary_dir="$(mktemp -d --tmpdir="${BACKUP_DIR}" ".${DEPLOYMENT_DATABASE_NAME}-${timestamp}.XXXXXX")"
temporary_archive="${BACKUP_DIR}/.${DEPLOYMENT_DATABASE_NAME}-${timestamp}.backup.tar.gz.tmp"
temporary_checksum="${temporary_archive}.sha256"
destination="${BACKUP_DIR}/${DEPLOYMENT_DATABASE_NAME}-${timestamp}.backup.tar.gz"
destination_checksum="${destination}.sha256"
case "$(readlink -f -- "${temporary_dir}")" in
  "${BACKUP_DIR}"/*) ;;
  *) echo "Unsafe backup workspace" >&2; exit 1 ;;
esac
cleanup() {
  rm -f -- "${temporary_archive}" "${temporary_checksum}"
  rm -rf -- "${temporary_dir}"
}
trap cleanup EXIT
objects_dir="${DEPLOYMENT_DATA_DIR:?DEPLOYMENT_DATA_DIR is required}/objects"
if [[ ${objects_dir} != /* || ! -d ${objects_dir} ]]; then
  echo "Private object directory is missing or not absolute" >&2
  exit 1
fi
if find "${objects_dir}" -xdev \( -type l -o -type f -links +1 \) -print -quit | grep -q .; then
  echo "Private object storage contains a symlink or hard-linked file; backup refused" >&2
  exit 1
fi
if find "${objects_dir}" -xdev ! -type d ! -type f -print -quit | grep -q .; then
  echo "Private object storage contains an unsupported file type; backup refused" >&2
  exit 1
fi
"${compose[@]}" exec --no-TTY postgres pg_dump --format=custom --no-owner \
  --username platform_migrator --dbname "${DEPLOYMENT_DATABASE_NAME}" \
  >"${temporary_dir}/database.dump"
[[ -s ${temporary_dir}/database.dump ]] || { echo "Database backup output was empty" >&2; exit 1; }
"${compose[@]}" exec --no-TTY postgres psql --username platform_migrator \
  --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
  --command 'SELECT version_num FROM alembic_version' >"${temporary_dir}/schema-head.txt"
readlink -f "${CURRENT_LINK}" | sed 's#.*/##' >"${temporary_dir}/release.txt"
tar --create --file "${temporary_dir}/objects.tar" --directory "${objects_dir}" \
  --sort=name --format=posix --pax-option=delete=atime,delete=ctime .
(
  cd "${temporary_dir}"
  sha256sum database.dump objects.tar release.txt schema-head.txt >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
tar --create --gzip --file "${temporary_archive}" --directory "${temporary_dir}" \
  --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
  database.dump objects.tar release.txt schema-head.txt SHA256SUMS
gzip --test "${temporary_archive}"
sha256sum "${temporary_archive}" | sed "s#${temporary_archive}#$(basename "${destination}")#" \
  >"${temporary_checksum}"
chmod 0600 "${temporary_archive}" "${temporary_checksum}"
mv -- "${temporary_archive}" "${destination}"
mv -- "${temporary_checksum}" "${destination_checksum}"
find "${BACKUP_DIR}" -maxdepth 1 -type f \
  \( -name '*.backup.tar.gz' -o -name '*.backup.tar.gz.sha256' \) -mtime +7 -delete
echo "Created database and private-object backup ${destination}"
