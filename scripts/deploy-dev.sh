#!/usr/bin/env bash
set -Eeuo pipefail

readonly ORON_ROOT="${ORON_ROOT:-/opt/oron-dev}"
readonly SHARED_DIR="${ORON_ROOT}/shared"
readonly RELEASES_DIR="${ORON_ROOT}/releases"
readonly COMMIT_SHA="${1:-}"
readonly RELEASE_ARCHIVE="${2:-}"
readonly LOCK_FILE="/run/lock/oron-dev-deploy.lock"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run deployment as root" >&2
  exit 1
fi
if [[ ${ORON_ROOT} != /opt/oron-dev ]]; then
  echo "ORON_ROOT must be /opt/oron-dev for this environment" >&2
  exit 1
fi
if [[ ! ${COMMIT_SHA} =~ ^[0-9a-f]{40}$ ]]; then
  echo "The first argument must be a full lowercase Git commit SHA" >&2
  exit 1
fi
if [[ ! -f ${RELEASE_ARCHIVE} ]]; then
  echo "Release archive not found: ${RELEASE_ARCHIVE}" >&2
  exit 1
fi
for file in \
  "${SHARED_DIR}/deployment.env" \
  "${SHARED_DIR}/config/postgres-password.txt" \
  "${SHARED_DIR}/config/owner-password.txt" \
  "${SHARED_DIR}/config/bootstrap-owner.env" \
  "${SHARED_DIR}/config/control-api.env" \
  "${SHARED_DIR}/config/dispatcher.env" \
  "${SHARED_DIR}/config/messaging-worker.env" \
  "${SHARED_DIR}/config/migrator.env" \
  "${SHARED_DIR}/config/web.env"; do
  if [[ ! -f ${file} ]]; then
    echo "Required private configuration is missing: ${file}" >&2
    exit 1
  fi
  chmod 0600 "${file}"
done

exec 9>"${LOCK_FILE}"
if ! flock --nonblock 9; then
  echo "Another deployment is already running" >&2
  exit 1
fi

umask 077
readonly RELEASE_DIR="${RELEASES_DIR}/${COMMIT_SHA}"
readonly STAGING_DIR="${RELEASES_DIR}/.staging-${COMMIT_SHA}"
readonly CURRENT_LINK="${ORON_ROOT}/current"
previous_release=""
if [[ -L ${CURRENT_LINK} ]]; then
  previous_release="$(readlink -f "${CURRENT_LINK}")"
fi

python3 - "${RELEASE_ARCHIVE}" <<'PY'
import sys
import tarfile
from pathlib import PurePosixPath

with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit(f"Unsafe release archive entry: {member.name}")
PY
rm -rf -- "${STAGING_DIR}"
install -d -m 0750 -o root -g root "${STAGING_DIR}"
tar -xzf "${RELEASE_ARCHIVE}" -C "${STAGING_DIR}"
for file in \
  "${STAGING_DIR}/images.env" \
  "${STAGING_DIR}/infra/compose/deployment.yaml" \
  "${STAGING_DIR}/infra/caddy/Caddyfile.deployment"; do
  [[ -f ${file} ]] || { echo "Release payload is missing ${file}" >&2; exit 1; }
done
if grep -Ev '^(WEB|CONTROL_API|MESSAGING_WORKER|DISPATCHER|MIGRATOR)_IMAGE=[^[:space:]]+@sha256:[0-9a-f]{64}$' \
  "${STAGING_DIR}/images.env" | grep -q .; then
  echo "images.env must contain only the five immutable image digest references" >&2
  exit 1
fi
if [[ $(wc -l <"${STAGING_DIR}/images.env") -ne 5 ]]; then
  echo "images.env must contain exactly five image references" >&2
  exit 1
fi
if [[ -d ${RELEASE_DIR} ]]; then
  if [[ ${previous_release} == "${RELEASE_DIR}" ]]; then
    rm -rf -- "${STAGING_DIR}"
  else
    rm -rf -- "${RELEASE_DIR}"
    mv -- "${STAGING_DIR}" "${RELEASE_DIR}"
  fi
else
  mv -- "${STAGING_DIR}" "${RELEASE_DIR}"
fi

compose() {
  docker compose \
    --env-file "${SHARED_DIR}/deployment.env" \
    --env-file "${RELEASE_DIR}/images.env" \
    --file "${RELEASE_DIR}/infra/compose/deployment.yaml" "$@"
}
compose_previous() {
  docker compose \
    --env-file "${SHARED_DIR}/deployment.env" \
    --env-file "${previous_release}/images.env" \
    --file "${previous_release}/infra/compose/deployment.yaml" "$@"
}

native_caddy_was_active=false
rollback() {
  exit_code=$?
  trap - ERR
  echo "Deployment of ${COMMIT_SHA} failed; attempting application rollback" >&2
  if [[ -n ${previous_release} && -d ${previous_release} ]]; then
    compose_previous --profile workers --profile voice up --detach --remove-orphans --wait --wait-timeout 180 || true
    ln -sfn "${previous_release}" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "${CURRENT_LINK}"
  elif [[ ${native_caddy_was_active} == true ]]; then
    systemctl start caddy || true
  fi
  exit "${exit_code}"
}
trap rollback ERR

compose config --quiet
compose pull
compose up --detach postgres
if [[ -n ${previous_release} ]]; then
  "${ORON_ROOT}/scripts/backup-dev.sh"
fi
compose --profile release run --rm migrator

# Bootstrap is deliberately gated by the authoritative identity table. The
# bootstrap program independently rechecks the entire empty-database invariant.
# shellcheck disable=SC1091
source "${SHARED_DIR}/deployment.env"
user_count="$(compose exec --no-TTY postgres psql --username platform_migrator \
  --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
  --command 'SELECT count(*) FROM users')"
if [[ ${user_count} == 0 ]]; then
  compose --profile bootstrap run --rm bootstrap-owner
fi

if systemctl is-active --quiet caddy; then
  native_caddy_was_active=true
  systemctl stop caddy
fi
compose --profile workers --profile voice up --detach --remove-orphans --wait --wait-timeout 240

for _ in {1..48}; do
  if curl --fail --silent --show-error --max-time 10 "${PLATFORM_ORIGIN}/login" >/dev/null; then
    break
  fi
  sleep 5
done
curl --fail --silent --show-error --max-time 10 "${PLATFORM_ORIGIN}/login" >/dev/null
http_origin="http://${PLATFORM_ORIGIN#https://}"
redirect_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "${http_origin}/")"
if [[ ${redirect_status} != 301 && ${redirect_status} != 308 ]]; then
  echo "HTTP did not redirect to HTTPS (status ${redirect_status})" >&2
  exit 1
fi

ln -sfn "${RELEASE_DIR}" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"
printf '%s\n' "${COMMIT_SHA}" >"${ORON_ROOT}/deployed-commit"
chmod 0644 "${ORON_ROOT}/deployed-commit"

install -m 0750 -o root -g root "${RELEASE_DIR}/scripts/deploy-dev.sh" \
  "${ORON_ROOT}/scripts/deploy-dev.sh"
install -m 0750 -o root -g root "${RELEASE_DIR}/scripts/backup-dev.sh" \
  "${ORON_ROOT}/scripts/backup-dev.sh"
for unit in oron-dev.service oron-dev-backup.service oron-dev-backup.timer; do
  install -m 0644 -o root -g root "${RELEASE_DIR}/infra/deployment/systemd/${unit}" \
    "/etc/systemd/system/${unit}"
done
systemctl daemon-reload
systemctl enable oron-dev.service oron-dev-backup.timer >/dev/null
systemctl disable caddy >/dev/null 2>&1 || true
systemctl start oron-dev-backup.timer
trap - ERR

# Keep the active release and the four newest predecessors. Never touch shared data.
mapfile -t old_releases < <(find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d \
  ! -name '.staging-*' -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
for old_release in "${old_releases[@]}"; do
  resolved="$(readlink -f -- "${old_release}")"
  if [[ ${resolved} == "${RELEASES_DIR}/"* && ${resolved} != "${RELEASE_DIR}" ]]; then
    rm -rf -- "${resolved}"
  fi
done
docker image prune --force --filter 'until=168h' >/dev/null
echo "Successfully deployed ${COMMIT_SHA}"
