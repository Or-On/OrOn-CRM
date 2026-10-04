#!/usr/bin/env bash
# Read-only acceptance receipt; never emit environment contents or customer data.
set -Eeuo pipefail
[[ ${EUID} -eq 0 && ${1:-} =~ ^[0-9a-f]{40}$ ]] || exit 1
expected_commit="$1"
root=/opt/oron-dev
[[ $(cat "${root}/deployed-commit") == "$expected_commit" ]] || exit 1
release="$(readlink -f "${root}/current")"
[[ "$release" == "${root}/releases/${expected_commit}" ]] || exit 1
# These are root-controlled configuration files, never untrusted request input.
# shellcheck disable=SC1091
source "${root}/shared/deployment.env"
# shellcheck disable=SC1091
source "${release}/images.env"
compose=(docker compose --env-file "${root}/shared/deployment.env"
  --env-file "${release}/images.env" --file "${release}/infra/compose/deployment.yaml")
expected_schema_head="$(python3 - "${release}/db/contracts/schema-manifest.json" <<'PY'
import json
import re
import sys
from pathlib import Path

head = json.loads(Path(sys.argv[1]).read_text())["alembic_head"]
if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{12}", head):
    raise SystemExit("Release manifest must contain one valid Alembic head")
print(head)
PY
)"
for pair in "web WEB_IMAGE" "control-api CONTROL_API_IMAGE" \
  "messaging-worker MESSAGING_WORKER_IMAGE" "dispatcher DISPATCHER_IMAGE" "sweeper MIGRATOR_IMAGE"; do
  read -r service key <<<"$pair"
  container="$("${compose[@]}" ps --quiet "$service")"
  [[ -n "$container" ]] || exit 1
  [[ $(docker inspect "$container" --format '{{.State.Status}}') == running ]] || exit 1
  actual="$(docker inspect "$container" --format '{{.Image}}')"
  [[ "$actual" == "$(docker image inspect "${!key}" --format '{{.Id}}')" ]] || exit 1
  revision="$(docker image inspect "$actual" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  [[ "$revision" == "$expected_commit" ]] || exit 1
  printf 'VERIFIED service=%s image=%s revision=%s\n' "$service" "$actual" "$revision"
done
worker="$("${compose[@]}" ps --quiet messaging-worker)"
[[ $(docker inspect "$worker" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}') == healthy ]] || exit 1
head="$("${compose[@]}" exec --no-TTY postgres psql --username platform_migrator \
  --dbname "$DEPLOYMENT_DATABASE_NAME" --tuples-only --no-align \
  --command "SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version")"
[[ "$head" == "$expected_schema_head" ]] || exit 1
printf 'VERIFIED deployed_commit=%s schema=%s worker=healthy\n' "$expected_commit" "$head"
