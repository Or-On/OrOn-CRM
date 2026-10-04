#!/usr/bin/env bash
set -Eeuo pipefail

readonly ORON_ROOT="${ORON_ROOT:-/opt/oron-dev}"
readonly SHARED_DIR="${ORON_ROOT}/shared"
readonly RELEASES_DIR="${ORON_ROOT}/releases"
readonly COMMIT_SHA="${1:-}"
readonly RELEASE_ARCHIVE="${2:-}"
readonly EXPECTED_ARCHIVE_SHA256="${3:-}"
readonly LOCK_FILE="/run/lock/oron-dev-deploy.lock"
readonly DISPATCHER_CONFIG="${SHARED_DIR}/config/dispatcher.env"
readonly WEB_CONFIG="${SHARED_DIR}/config/web.env"
readonly MESSAGING_WORKER_CONFIG="${SHARED_DIR}/config/messaging-worker.env"
readonly MIGRATOR_CONFIG="${SHARED_DIR}/config/migrator.env"
readonly SWEEPER_CONFIG="${SHARED_DIR}/config/sweeper.env"

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
if [[ ! ${EXPECTED_ARCHIVE_SHA256} =~ ^[0-9a-f]{64}$ ]]; then
  echo "The third argument must be the expected lowercase SHA-256 of the archive" >&2
  exit 1
fi
actual_archive_sha256="$(sha256sum "${RELEASE_ARCHIVE}" | cut -d' ' -f1)"
if [[ ${actual_archive_sha256} != "${EXPECTED_ARCHIVE_SHA256}" ]]; then
  echo "Release archive checksum mismatch" >&2
  exit 1
fi

# Serialize and preserve private recovery state before changing any config.
for unit in oron-dev.service oron-dev-backup.service oron-dev-backup.timer; do
  [[ -f /etc/systemd/system/${unit} ]] || {
    echo "Existing DEV systemd unit required; provisioning is not authorized" >&2
    exit 1
  }
done
exec 9>"${LOCK_FILE}"
if ! flock --nonblock 9; then
  echo "Another deployment is already running" >&2
  exit 1
fi
available_bytes="$(df --output=avail -B1 "${ORON_ROOT}" | tail -n 1 | tr -d ' ')"
[[ ${available_bytes} =~ ^[0-9]+$ && ${available_bytes} -ge 5368709120 ]] || {
  echo "At least 5 GiB free disk is required; no automatic pruning is permitted" >&2
  exit 1
}
readonly RECOVERY_DIR="$(mktemp -d "${ORON_ROOT}/pre-deploy-${COMMIT_SHA}.XXXXXX")"
chmod 0700 "${RECOVERY_DIR}"
docker ps --all --format '{{.ID}} {{.Image}} {{.Status}}' >"${RECOVERY_DIR}/containers.txt"
cp -a "${SHARED_DIR}/config" "${RECOVERY_DIR}/config"
cp -a "${SHARED_DIR}/deployment.env" "${RECOVERY_DIR}/deployment.env"
for path in "${ORON_ROOT}/current" "${ORON_ROOT}/deployed-commit"; do
  [[ ! -e ${path} && ! -L ${path} ]] || cp -a "${path}" "${RECOVERY_DIR}/"
done
for unit in oron-dev.service oron-dev-backup.service oron-dev-backup.timer caddy.service; do
  systemctl is-enabled "$unit" >"${RECOVERY_DIR}/${unit}.enabled" 2>&1 || true
  systemctl is-active "$unit" >"${RECOVERY_DIR}/${unit}.active" 2>&1 || true
  [[ ! -f /etc/systemd/system/${unit} ]] || cp -a "/etc/systemd/system/${unit}" "${RECOVERY_DIR}/"
done

restore_private_configuration() {
  # Preflight changes permissions, TTS configuration and a derived sweeper file.
  # Restore the exact private snapshot before restarting any previous image.
  cp -a "${RECOVERY_DIR}/config/." "${SHARED_DIR}/config/" || return
  cp -a "${RECOVERY_DIR}/deployment.env" "${SHARED_DIR}/deployment.env" || return
  if [[ -e ${RECOVERY_DIR}/deployed-commit ]]; then
    cp -a "${RECOVERY_DIR}/deployed-commit" "${ORON_ROOT}/deployed-commit" || return
  else
    rm -f -- "${ORON_ROOT}/deployed-commit" || return
  fi
  if [[ ! -e ${RECOVERY_DIR}/config/sweeper.env ]]; then
    rm -f -- "${SWEEPER_CONFIG}" || return
  fi
}

rollback_preflight() {
  local exit_code=$?
  trap - EXIT ERR INT TERM
  [[ ${exit_code} -ne 0 ]] || exit_code=1
  set +e
  if ! restore_private_configuration; then
    echo "Private configuration rollback failed; operator inspection required" >&2
  fi
  exit "${exit_code}"
}
# The later application rollback handler replaces this guard. Keep failed
# admission/config/archive checks recoverable before that handler exists.
trap rollback_preflight EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for file in \
  "${SHARED_DIR}/deployment.env" \
  "${SHARED_DIR}/config/postgres-password.txt" \
  "${SHARED_DIR}/config/owner-password.txt" \
  "${SHARED_DIR}/config/bootstrap-owner.env" \
  "${SHARED_DIR}/config/control-api.env" \
  "${DISPATCHER_CONFIG}" \
  "${SHARED_DIR}/config/messaging-worker.env" \
  "${SHARED_DIR}/config/migrator.env" \
  "${SHARED_DIR}/config/web.env"; do
  if [[ ! -f ${file} ]]; then
    echo "Required private configuration is missing: ${file}" >&2
    exit 1
  fi
  chmod 0600 "${file}"
done

read_private_config_value() {
  local config_file="$1"
  local key="$2"
  local value
  if ! value="$(awk -v key="${key}" '
    index($0, key "=") == 1 {
      count += 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (count != 1 || length(value) == 0) exit 1
      print value
    }
  ' "${config_file}")"; then
    echo "Required ${key} configuration is missing or duplicated in ${config_file}" >&2
    exit 1
  fi
  printf '%s' "${value}"
}

set_private_config_value() {
  local config_file="$1"
  local key="$2"
  local value="$3"
  local temporary
  temporary="$(mktemp "${config_file}.XXXXXX")"
  if ! awk -v key="${key}" -v value="${value}" '
    BEGIN { count = 0 }
    index($0, key "=") == 1 { print key "=" value; count += 1; next }
    { print }
    END { if (count != 1) exit 1 }
  ' "${config_file}" >"${temporary}"; then
    rm -f -- "${temporary}"
    echo "Required ${key} configuration is missing or duplicated in ${config_file}" >&2
    exit 1
  fi
  install -m 0600 -o root -g root "${temporary}" "${config_file}"
  rm -f -- "${temporary}"
}

# Whole sentences give the speech engine their intended punctuation and
# intonation. The retired first-clause optimization split one thought into
# multiple synthesis sessions and made live speech sound clipped.
set_private_config_value "${DISPATCHER_CONFIG}" TTS_FIRST_CLAUSE false

# Older DEV hosts were provisioned before the session sweeper existed. Reuse
# the dispatcher's already-provisioned voice DSN for that first release so a
# missing derived config does not block a safe deployment. Existing files are
# still validated below and are never replaced silently.
if [[ ! -f ${SWEEPER_CONFIG} ]]; then
  [[ $(stat --format='%u' "${DISPATCHER_CONFIG}") -eq 0 ]] || {
    echo "Private runtime configuration must be owned by root: ${DISPATCHER_CONFIG}" >&2
    exit 1
  }
  voice_database_url="$(read_private_config_value "${DISPATCHER_CONFIG}" VOICE_DATABASE_URL)"
  [[ ${voice_database_url} == postgresql://platform_voice:* ]] || {
    echo "dispatcher.env VOICE_DATABASE_URL must log in as platform_voice" >&2
    exit 1
  }
  install -m 0600 -o root -g root /dev/null "${SWEEPER_CONFIG}"
  printf 'DATABASE_URL=%s\nSTALE_SESSION_MINUTES=120\nSWEEP_INTERVAL_SECONDS=3600\n' \
    "${voice_database_url}" >"${SWEEPER_CONFIG}"
fi
chmod 0600 "${SWEEPER_CONFIG}"

# Field-service evidence crosses the web, messaging, and voice runtimes. Refuse
# a release when an older host configuration would make those services encrypt
# or locate the same private object differently.
for config_file in "${DISPATCHER_CONFIG}" "${WEB_CONFIG}" "${MESSAGING_WORKER_CONFIG}" \
  "${MIGRATOR_CONFIG}" "${SWEEPER_CONFIG}"; do
  [[ $(stat --format='%u' "${config_file}") -eq 0 ]] || {
    echo "Private runtime configuration must be owned by root: ${config_file}" >&2
    exit 1
  }
done
SHARED_FIELD_CIPHER_KEY="$(read_private_config_value "${DISPATCHER_CONFIG}" FIELD_CIPHER_LOCAL_KEY)"
readonly SHARED_FIELD_CIPHER_KEY
SHARED_BLIND_INDEX_KEY="$(read_private_config_value "${DISPATCHER_CONFIG}" BLIND_INDEX_KEY)"
readonly SHARED_BLIND_INDEX_KEY
for config_file in "${WEB_CONFIG}" "${MESSAGING_WORKER_CONFIG}"; do
  [[ $(read_private_config_value "${config_file}" FIELD_CIPHER_LOCAL_KEY) == "${SHARED_FIELD_CIPHER_KEY}" ]] || {
    echo "FIELD_CIPHER_LOCAL_KEY must match across field-service runtimes" >&2
    exit 1
  }
  [[ $(read_private_config_value "${config_file}" BLIND_INDEX_KEY) == "${SHARED_BLIND_INDEX_KEY}" ]] || {
    echo "BLIND_INDEX_KEY must match across field-service runtimes" >&2
    exit 1
  }
done
for config_file in "${DISPATCHER_CONFIG}" "${WEB_CONFIG}" "${MESSAGING_WORKER_CONFIG}"; do
  [[ $(read_private_config_value "${config_file}" ARTIFACTS_BACKEND) == local ]] || {
    echo "ARTIFACTS_BACKEND must be local in ${config_file}" >&2
    exit 1
  }
  [[ $(read_private_config_value "${config_file}" ARTIFACTS_LOCAL_ROOT) == /var/lib/oron/objects ]] || {
    echo "ARTIFACTS_LOCAL_ROOT is invalid in ${config_file}" >&2
    exit 1
  }
done
if ! FIELD_CIPHER_BYTES="$(printf '%s' "${SHARED_FIELD_CIPHER_KEY}" | base64 --decode 2>/dev/null | wc -c)" ||
  [[ ${FIELD_CIPHER_BYTES} -ne 32 ]]; then
  echo "FIELD_CIPHER_LOCAL_KEY must decode to exactly 32 bytes" >&2
  exit 1
fi
if ! BLIND_INDEX_BYTES="$(printf '%s' "${SHARED_BLIND_INDEX_KEY}" | base64 --decode 2>/dev/null | wc -c)" ||
  [[ ${BLIND_INDEX_BYTES} -lt 32 ]]; then
  echo "BLIND_INDEX_KEY must decode to at least 32 bytes" >&2
  exit 1
fi

# The session sweeper holds a database login, so it is pinned to the one the
# voice dispatcher already holds: the voice role may only reach every tenant's
# stale sessions through platform.fail_stale_voice_sessions. Requiring the exact
# same DSN means the sweeper can never silently carry migration credentials or
# activate a historical Or-on login.
[[ $(read_private_config_value "${SWEEPER_CONFIG}" DATABASE_URL) == postgresql://platform_voice:* ]] || {
  echo "sweeper.env DATABASE_URL must log in as platform_voice" >&2
  exit 1
}
[[ $(read_private_config_value "${SWEEPER_CONFIG}" DATABASE_URL) == "$(read_private_config_value "${DISPATCHER_CONFIG}" VOICE_DATABASE_URL)" ]] || {
  echo "sweeper.env DATABASE_URL must equal dispatcher.env VOICE_DATABASE_URL" >&2
  exit 1
}


# The Python voice runtime uses UID 100 while the Node web and messaging
# runtimes use GID 1000. The root is private to those principals; each adapter
# keeps its own descendants at its stricter application-level modes.
readonly PRIVATE_OBJECTS_DIR="${SHARED_DIR}/data/objects"
install -d -m 0770 -o 100 -g 1000 "${PRIVATE_OBJECTS_DIR}"

umask 077
readonly RELEASE_DIR="${RELEASES_DIR}/${COMMIT_SHA}"
readonly STAGING_DIR="${RELEASES_DIR}/.staging-${COMMIT_SHA}"
readonly CURRENT_LINK="${ORON_ROOT}/current"
previous_release=""
if [[ -L ${CURRENT_LINK} ]]; then
  previous_release="$(readlink -f "${CURRENT_LINK}")"
fi

rm -rf -- "${STAGING_DIR}"
install -d -m 0750 -o root -g root "${STAGING_DIR}"
python3 - "${RELEASE_ARCHIVE}" "${STAGING_DIR}" <<'PY'
import os
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

expected_files = {
    "images.env",
    "db/contracts/schema-manifest.json",
    "infra/caddy/Caddyfile.deployment",
    "infra/compose/deployment.yaml",
    "infra/deployment/systemd/oron-dev-backup.service",
    "infra/deployment/systemd/oron-dev-backup.timer",
    "infra/deployment/systemd/oron-dev-recovery.service",
    "infra/deployment/systemd/oron-dev-recovery.timer",
    "infra/deployment/systemd/oron-dev.service",
    "scripts/backup-dev.sh",
    "scripts/deploy-dev.sh",
    "scripts/restore-dev-backup.py",
    "scripts/recover_unhealthy.py",
}
expected_directories = {
    str(parent)
    for name in expected_files
    for parent in PurePosixPath(name).parents
    if str(parent) != "."
}
destination = Path(sys.argv[2]).resolve(strict=True)
members: dict[str, tarfile.TarInfo] = {}
total_size = 0
root_seen = False

with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive.getmembers():
        normalized = member.name.removeprefix("./").rstrip("/")
        if normalized in {"", "."} and member.isdir():
            if root_seen:
                raise SystemExit("Duplicate release archive root entry")
            root_seen = True
            continue
        path = PurePosixPath(normalized)
        if (
            not normalized
            or "\\" in normalized
            or path.is_absolute()
            or ".." in path.parts
        ):
            raise SystemExit(f"Unsafe release archive entry: {member.name}")
        if normalized in members:
            raise SystemExit(f"Duplicate release archive entry: {normalized}")
        members[normalized] = member
        if member.isdir():
            if normalized not in expected_directories:
                raise SystemExit(f"Unexpected release directory: {normalized}")
            continue
        if not member.isreg():
            raise SystemExit(f"Unsafe release archive entry type: {normalized}")
        if normalized not in expected_files:
            raise SystemExit(f"Unexpected release file: {normalized}")
        if member.mode & 0o022:
            raise SystemExit(f"Writable release file mode is not allowed: {normalized}")
        if member.size > 2 * 1024 * 1024:
            raise SystemExit(f"Release file exceeds the 2 MiB limit: {normalized}")
        total_size += member.size
    regular_files = {name for name, member in members.items() if member.isreg()}
    if regular_files != expected_files:
        missing = sorted(expected_files - regular_files)
        extra = sorted(regular_files - expected_files)
        raise SystemExit(f"Invalid release contents; missing={missing}, extra={extra}")
    if total_size > 8 * 1024 * 1024:
        raise SystemExit("Release archive exceeds the 8 MiB uncompressed limit")
    for name in sorted(expected_files):
        member = members[name]
        target = (destination / name).resolve()
        if destination not in target.parents:
            raise SystemExit(f"Unsafe extraction target: {name}")
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o750)
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"Unable to read release file: {name}")
        with source, target.open("xb") as output:
            shutil.copyfileobj(source, output)
        if name.startswith("scripts/"):
            mode = 0o750
        elif name == "infra/caddy/Caddyfile.deployment":
            # The edge container is deliberately unprivileged (UID 65532) and
            # must be able to read this non-secret bind-mounted configuration.
            mode = 0o644
        else:
            mode = 0o640
        os.chmod(target, mode)
PY
for file in \
  "${STAGING_DIR}/images.env" \
  "${STAGING_DIR}/infra/compose/deployment.yaml" \
  "${STAGING_DIR}/infra/caddy/Caddyfile.deployment"; do
  [[ -f ${file} ]] || { echo "Release payload is missing ${file}" >&2; exit 1; }
done
mapfile -t image_lines <"${STAGING_DIR}/images.env"
declare -A release_images=()
for line in "${image_lines[@]}"; do
  if [[ ! ${line} =~ ^(WEB|CONTROL_API|MESSAGING_WORKER|DISPATCHER|MIGRATOR)_IMAGE=([^[:space:]]+)@sha256:([0-9a-f]{64})$ ]]; then
    echo "images.env contains an invalid immutable image reference" >&2
    exit 1
  fi
  key="${BASH_REMATCH[1]}_IMAGE"
  if [[ -n ${release_images[${key}]+present} ]]; then
    echo "images.env contains a duplicate ${key}" >&2
    exit 1
  fi
  release_images["${key}"]="${BASH_REMATCH[2]}@sha256:${BASH_REMATCH[3]}"
done
if [[ ${#release_images[@]} -ne 5 ]]; then
  echo "images.env must contain each of the five image keys exactly once" >&2
  exit 1
fi
if [[ -d ${RELEASE_DIR} ]]; then
  if [[ ${previous_release} == "${RELEASE_DIR}" ]]; then
    rm -rf -- "${STAGING_DIR}"
  else
    echo "Existing inactive release directory preserved; inspect before retry" >&2
    exit 1
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
previous_optional_services=()
deployment_succeeded=false
schema_migration_started=false
schema_head_before_migration=""
rollback() {
  local exit_code=$?
  trap - EXIT ERR INT TERM
  [[ ${deployment_succeeded} == true ]] && return
  # Explicit exits (including the active-call safety refusal) do not run ERR.
  # An unexpected clean exit is also an incomplete deployment.
  [[ ${exit_code} -ne 0 ]] || exit_code=1
  set +e
  echo "Deployment of ${COMMIT_SHA} failed; attempting application rollback" >&2
  if ! restore_private_configuration; then
    echo "Private configuration rollback failed; prior applications were not restarted" >&2
    exit "${exit_code}"
  fi
  if [[ -n ${previous_release} && -d ${previous_release} ]]; then
    # A successful DDL migration can revoke/replace runtime contracts. Never
    # restart an older image against an advanced or unreadable schema. PostgreSQL
    # Alembic runs transactionally; unchanged head is the narrow recovery case.
    if [[ ${schema_migration_started} == true ]]; then
      schema_head_after_failure="$(timeout --kill-after=1s 5s docker compose \
        --env-file "${SHARED_DIR}/deployment.env" \
        --env-file "${previous_release}/images.env" \
        --file "${previous_release}/infra/compose/deployment.yaml" \
        exec --no-TTY postgres psql --username platform_migrator \
        --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
        --command "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version")"
      schema_probe_status=$?
      if [[ ${schema_probe_status} -ne 0 || ! ${schema_head_before_migration} =~ ^[0-9a-f]{12}$ ||
            ${schema_head_after_failure} != "${schema_head_before_migration}" ]]; then
        echo "Automatic application rollback refused: schema advanced or compatibility could not be proved. Prior images were not restarted; operator must choose a compatible forward image or an approved backup recovery." >&2
        exit "${exit_code}"
      fi
    fi
    # Bound the complete Compose operation, not only its healthcheck wait.
    # Allow at most 6 seconds for schema verification and 5 for termination.
    # The configured recovery commands remain within the two-minute budget.
    timeout --kill-after=5s 105s docker compose \
      --env-file "${SHARED_DIR}/deployment.env" \
      --env-file "${previous_release}/images.env" \
      --file "${previous_release}/infra/compose/deployment.yaml" \
      up --detach --remove-orphans --wait --wait-timeout 90 \
      postgres control-api web caddy "${previous_optional_services[@]}"
    rollback_status=$?
    if [[ ${rollback_status} -ne 0 ]]; then
      echo "Application rollback did not prove readiness (status ${rollback_status}); operator intervention required" >&2
    fi
    ln -sfn "${previous_release}" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "${CURRENT_LINK}"
  elif [[ ${native_caddy_was_active} == true ]]; then
    systemctl start caddy || true
  fi
  exit "${exit_code}"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
command -v timeout >/dev/null || { echo "GNU timeout is required for bounded rollback" >&2; exit 1; }

# shellcheck disable=SC1091
source "${SHARED_DIR}/deployment.env"
if [[ ! ${PLATFORM_ORIGIN:-} =~ ^https://([A-Za-z0-9.-]+)$ ]]; then
  echo "PLATFORM_ORIGIN must be an HTTPS origin with a DNS hostname and no path" >&2
  exit 1
fi
readonly PLATFORM_HOST="${BASH_REMATCH[1]}"
if [[ ${PLATFORM_HOST} == .* || ${PLATFORM_HOST} == *. || ${PLATFORM_HOST} == *..* ]]; then
  echo "PLATFORM_ORIGIN contains an invalid DNS hostname" >&2
  exit 1
fi
if [[ -n ${previous_release} ]]; then
  mapfile -t previous_running_services < <(compose_previous ps --services --filter status=running)
  for service in "${previous_running_services[@]}"; do
    if [[ ${service} == messaging-worker || ${service} == dispatcher || ${service} == sweeper ]]; then
      previous_optional_services+=("${service}")
    fi
  done
fi
compose config --quiet
# Preserve canonical installed units; refuse drift rather than silently overwrite.
for unit in oron-dev.service oron-dev-backup.service oron-dev-backup.timer; do
  cmp -s "${RELEASE_DIR}/infra/deployment/systemd/${unit}" "/etc/systemd/system/${unit}" || {
    echo "Existing systemd unit differs from the reviewed release; explicit repair required: ${unit}" >&2
    exit 1
  }
done
# Preserve all images; insufficient disk aborts instead of pruning.
# Pull each immutable application image explicitly before inspecting its digest
# or stopping the currently running application. Compose can omit profiled
# one-shot services such as the migrator from an aggregate pull even when their
# profiles are enabled, so release admission must not rely on profile selection.
for key in WEB_IMAGE CONTROL_API_IMAGE MESSAGING_WORKER_IMAGE DISPATCHER_IMAGE MIGRATOR_IMAGE; do
  docker pull "${release_images[${key}]}"
done
compose pull postgres caddy
for image in "${release_images[@]}"; do
  revision="$(docker image inspect "${image}" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  if [[ ${revision} != "${COMMIT_SHA}" ]]; then
    echo "Image source revision does not match the requested release" >&2
    exit 1
  fi
done
compose up --detach postgres
# Refuse bootstrap and reserve space for backup before stopping admission.
user_count="$(compose exec --no-TTY postgres psql --username platform_migrator \
  --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
  --command 'SELECT count(*) FROM users')"
[[ ${user_count} =~ ^[0-9]+$ && ${user_count} -gt 0 ]] || {
  echo "Existing nonempty identity database required; bootstrap is not authorized" >&2
  exit 1
}
database_bytes="$(compose exec --no-TTY postgres psql --username platform_migrator \
  --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
  --command 'SELECT pg_database_size(current_database())')"
available_bytes="$(df --output=avail -B1 "${ORON_ROOT}" | tail -n 1 | tr -d ' ')"
[[ ${database_bytes} =~ ^[0-9]+$ && ${available_bytes} =~ ^[0-9]+$ &&
   ${available_bytes} -ge $((database_bytes * 2 + 1073741824)) ]] || {
  echo "Insufficient disk for retained database backup and migration reserve" >&2
  exit 1
}
if [[ -n ${previous_release} ]]; then
  # Keep webhook ingestion and replies available during voice drain. Stop
  # admission only once the voice gate passes, immediately before migration.
  # Run the existing least-privileged, bounded stale-session repair once before
  # waiting. Its configured cutoff must remain above the maximum live-call
  # budget; never shorten it merely to make a deployment proceed.
  compose_previous --profile workers run --rm --no-deps sweeper oron-sessions-sweeper
  active_calls=0
  for _ in {1..36}; do
    active_calls="$(compose_previous exec --no-TTY postgres psql \
      --username platform_migrator --dbname "${DEPLOYMENT_DATABASE_NAME}" \
      --tuples-only --no-align \
      --command "SELECT count(*) FROM public.sessions WHERE status='started' AND ended_at IS NULL")"
    [[ ${active_calls} == 0 ]] && break
    sleep 5
  done
  if [[ ${active_calls} != 0 ]]; then
    echo "Active voice sessions did not drain; refusing to migrate or disconnect callers" >&2
    exit 1
  fi
  # The periodic sweeper also writes the voice schema. Stop it before the
  # backup/migration boundary, after the one-shot repair and call drain.
  compose_previous stop --timeout 120 messaging-worker web caddy
  compose_previous stop --timeout 120 dispatcher control-api sweeper
  "${RELEASE_DIR}/scripts/backup-dev.sh" --database-only
fi
if [[ -n ${previous_release} ]]; then
  schema_head_before_migration="$(compose exec --no-TTY postgres psql \
    --username platform_migrator --dbname "${DEPLOYMENT_DATABASE_NAME}" \
    --tuples-only --no-align \
    --command "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version")"
  [[ ${schema_head_before_migration} =~ ^[0-9a-f]{12}$ ]] || {
    echo "Existing schema must have one verified Alembic head before migration" >&2
    exit 1
  }
fi
printf '%s\n' "$schema_head_before_migration" >"${RECOVERY_DIR}/schema-before.txt"
schema_migration_started=true
compose --profile release run --rm migrator

if systemctl is-active --quiet caddy; then
  native_caddy_was_active=true
  systemctl stop caddy
fi
compose --profile workers --profile voice up --detach --remove-orphans --wait --wait-timeout 240

for service_and_key in \
  "web WEB_IMAGE" \
  "control-api CONTROL_API_IMAGE" \
  "messaging-worker MESSAGING_WORKER_IMAGE" \
  "dispatcher DISPATCHER_IMAGE" \
  "sweeper MIGRATOR_IMAGE"; do
  read -r service key <<<"${service_and_key}"
  container_id="$(compose ps --quiet "${service}")"
  [[ -n ${container_id} ]] || { echo "Expected service is not running: ${service}" >&2; exit 1; }
  running_image_id="$(docker inspect "${container_id}" --format '{{.Image}}')"
  expected_image_id="$(docker image inspect "${release_images[${key}]}" --format '{{.Id}}')"
  if [[ ${running_image_id} != "${expected_image_id}" ]]; then
    echo "Running ${service} does not use the intended immutable image" >&2
    exit 1
  fi
done

messaging_worker_id="$(compose ps --quiet messaging-worker)"
messaging_worker_health="$(docker inspect "${messaging_worker_id}" \
  --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}')"
if [[ ${messaging_worker_health} != healthy ]]; then
  echo "Messaging worker did not prove a fresh polling loop and database readiness" >&2
  exit 1
fi

for _ in {1..48}; do
  if curl --fail --silent --max-time 10 \
    --resolve "${PLATFORM_HOST}:443:127.0.0.1" "${PLATFORM_ORIGIN}/login" >/dev/null; then
    break
  fi
  sleep 5
done
if ! curl --fail --silent --show-error --max-time 10 \
  --resolve "${PLATFORM_HOST}:443:127.0.0.1" "${PLATFORM_ORIGIN}/login" >/dev/null; then
  echo "Local edge readiness failed; capturing bounded diagnostics before rollback" >&2
  compose ps >&2 || true
  compose logs --no-color --tail 100 caddy >&2 || true
  ss -ltn '( sport = :80 or sport = :443 )' >&2 || true
  exit 1
fi
http_origin="http://${PLATFORM_HOST}"
redirect_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --resolve "${PLATFORM_HOST}:80:127.0.0.1" "${http_origin}/")"
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
# Preserve existing systemd units, enablement and timer state. Units must already
# follow /opt/oron-dev/current; provisioning or unit repair is a separate action.
deployment_succeeded=true
trap - EXIT ERR INT TERM

# Preserve all release directories and images for explicit recovery/maintenance.
echo "Successfully deployed ${COMMIT_SHA}"
