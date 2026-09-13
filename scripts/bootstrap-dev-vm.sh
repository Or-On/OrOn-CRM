#!/usr/bin/env bash
set -Eeuo pipefail

readonly ORON_ROOT="${ORON_ROOT:-/opt/oron-dev}"
readonly APP_USER="${APP_USER:-oron}"
readonly REGISTRY_HOST="${REGISTRY_HOST:-}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this bootstrap as root" >&2
  exit 1
fi
if [[ ${ORON_ROOT} != /opt/oron-dev ]]; then
  echo "ORON_ROOT must be /opt/oron-dev for this environment" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  ca-certificates curl docker.io docker-compose-v2 jq openssl tar
systemctl enable --now docker

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${ORON_ROOT}" --shell /usr/sbin/nologin "${APP_USER}"
fi
install -d -m 0755 -o root -g root "${ORON_ROOT}"
install -d -m 0750 -o root -g root \
  "${ORON_ROOT}/releases" "${ORON_ROOT}/shared" "${ORON_ROOT}/scripts" \
  "${ORON_ROOT}/logs" "${ORON_ROOT}/backups"
install -d -m 0700 -o root -g root "${ORON_ROOT}/shared/config"
install -d -m 0750 -o "${APP_USER}" -g "${APP_USER}" "${ORON_ROOT}/shared/data"
install -d -m 0700 -o root -g root "${ORON_ROOT}/shared/data/postgres"
install -d -m 0750 -o root -g root "${ORON_ROOT}/shared/data/caddy"
install -d -m 0770 -o root -g root "${ORON_ROOT}/shared/data/objects"
chown 999:999 "${ORON_ROOT}/shared/data/postgres"
chown 65532:65532 "${ORON_ROOT}/shared/data/caddy"
chown 100:100 "${ORON_ROOT}/shared/data/objects"

install -m 0750 -o root -g root "${REPOSITORY_ROOT}/scripts/deploy-dev.sh" \
  "${ORON_ROOT}/scripts/deploy-dev.sh"
install -m 0750 -o root -g root "${REPOSITORY_ROOT}/scripts/backup-dev.sh" \
  "${ORON_ROOT}/scripts/backup-dev.sh"
install -m 0644 -o root -g root \
  "${REPOSITORY_ROOT}/infra/deployment/systemd/oron-dev.service" \
  /etc/systemd/system/oron-dev.service
install -m 0644 -o root -g root \
  "${REPOSITORY_ROOT}/infra/deployment/systemd/oron-dev-backup.service" \
  /etc/systemd/system/oron-dev-backup.service
install -m 0644 -o root -g root \
  "${REPOSITORY_ROOT}/infra/deployment/systemd/oron-dev-backup.timer" \
  /etc/systemd/system/oron-dev-backup.timer

if [[ -n ${REGISTRY_HOST} ]]; then
  readonly helper_version="2.2.1"
  readonly helper_archive="docker-credential-gcr_linux_amd64-${helper_version}.tar.gz"
  readonly helper_sha256="54733a03c18f230059d89e8976518de9af16cebb74b86ccab5c95c9da66f5912"
  temporary_directory="$(mktemp -d)"
  trap 'rm -rf -- "${temporary_directory}"' EXIT
  curl --fail --location --silent --show-error \
    "https://github.com/GoogleCloudPlatform/docker-credential-gcr/releases/download/v${helper_version}/${helper_archive}" \
    --output "${temporary_directory}/${helper_archive}"
  printf '%s  %s\n' "${helper_sha256}" "${temporary_directory}/${helper_archive}" | sha256sum --check --status
  tar -xzf "${temporary_directory}/${helper_archive}" -C "${temporary_directory}" docker-credential-gcr
  install -m 0755 -o root -g root "${temporary_directory}/docker-credential-gcr" \
    /usr/local/bin/docker-credential-gcr
  HOME=/root docker-credential-gcr configure-docker --registries="${REGISTRY_HOST}"
fi

if ! swapon --show --noheadings | grep -q .; then
  install -d -m 0700 -o root -g root /var/lib/oron
  if [[ ! -f /var/lib/oron/dev.swap ]]; then
    fallocate -l 2G /var/lib/oron/dev.swap
    chmod 0600 /var/lib/oron/dev.swap
    mkswap /var/lib/oron/dev.swap >/dev/null
  fi
  swapon /var/lib/oron/dev.swap
  if ! grep -qF '/var/lib/oron/dev.swap none swap sw 0 0' /etc/fstab; then
    printf '%s\n' '/var/lib/oron/dev.swap none swap sw 0 0' >>/etc/fstab
  fi
fi

systemctl daemon-reload
systemctl enable oron-dev.service oron-dev-backup.timer
systemctl start oron-dev-backup.timer
echo "Or-On DEV VM bootstrap is complete"
