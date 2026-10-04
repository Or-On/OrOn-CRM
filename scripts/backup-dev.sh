#!/usr/bin/env bash
set -Eeuo pipefail

readonly ORON_ROOT="${ORON_ROOT:-/opt/oron-dev}"
readonly SHARED_DIR="${ORON_ROOT}/shared"
readonly CURRENT_LINK="${ORON_ROOT}/current"
readonly BACKUP_DIR="${ORON_ROOT}/backups"
database_only=false
case "${1:-}" in
  '') ;;
  --database-only) database_only=true ;;
  *) echo "Usage: backup-dev.sh [--database-only]" >&2; exit 1 ;;
esac
[[ $# -le 1 ]] || { echo "Usage: backup-dev.sh [--database-only]" >&2; exit 1; }

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
# Full scheduled backups cannot race a deployment changing schema/release.
# The database-only pre-deploy mode runs under the caller's deployment lock.
if [[ ${database_only} == false ]]; then
  exec 8>/run/lock/oron-dev-deploy.lock
  flock --shared --nonblock 8 || { echo "Deployment is active; full backup refused" >&2; exit 1; }
fi
umask 077
# shellcheck disable=SC1091
source "${SHARED_DIR}/deployment.env"
release="$(readlink -f "${CURRENT_LINK}")"
if [[ ${release} != "${ORON_ROOT}/releases/"* || ! ${release##*/} =~ ^[0-9a-f]{40}$ ]]; then
  echo "Active release is outside the verified release directory" >&2
  exit 1
fi
compose=(docker compose --env-file "${SHARED_DIR}/deployment.env" \
  --env-file "${release}/images.env" --file "${release}/infra/compose/deployment.yaml")
install -d -m 0700 -o root -g root "${BACKUP_DIR}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ ${database_only} == true ]]; then
  timestamp="${timestamp}-database-only"
fi
temporary_dir="$(mktemp -d --tmpdir="${BACKUP_DIR}" ".${DEPLOYMENT_DATABASE_NAME}-${timestamp}.XXXXXX")"
temporary_archive="${BACKUP_DIR}/.${DEPLOYMENT_DATABASE_NAME}-${timestamp}.backup.tar.gz.tmp"
temporary_checksum="${temporary_archive}.sha256"
destination="${BACKUP_DIR}/${DEPLOYMENT_DATABASE_NAME}-${timestamp}.backup.tar.gz"
destination_checksum="${destination}.sha256"
[[ ! -e ${destination} && ! -e ${destination_checksum} ]] || {
  echo "Backup timestamp already exists; refusing to overwrite recovery evidence" >&2
  exit 1
}
case "$(readlink -f -- "${temporary_dir}")" in
  "${BACKUP_DIR}"/*) ;;
  *) echo "Unsafe backup workspace" >&2; exit 1 ;;
esac
cleanup() {
  rm -f -- "${temporary_archive}" "${temporary_checksum}"
  rm -rf -- "${temporary_dir}"
}
trap cleanup EXIT
if [[ ${database_only} == false ]]; then
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
fi
"${compose[@]}" exec --no-TTY postgres pg_dump --format=custom --no-owner \
  --username platform_migrator --dbname "${DEPLOYMENT_DATABASE_NAME}" \
  >"${temporary_dir}/database.dump"
[[ -s ${temporary_dir}/database.dump ]] || { echo "Database backup output was empty" >&2; exit 1; }
"${compose[@]}" exec --no-TTY postgres psql --username platform_migrator \
  --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
  --command 'SELECT version_num FROM alembic_version' >"${temporary_dir}/schema-head.txt"
readlink -f "${CURRENT_LINK}" | sed 's#.*/##' >"${temporary_dir}/release.txt"
# Recovery needs the exact release artifacts and security ownership contract,
# not just data rows. No private configuration or key material enters this bundle.
"${compose[@]}" exec --no-TTY postgres psql --username platform_migrator \
  --dbname "${DEPLOYMENT_DATABASE_NAME}" --tuples-only --no-align \
  --command "SELECT jsonb_build_object(
    'requiredRoles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'superuser',rolsuper,'bypassRls',rolbypassrls,'login',rolcanlogin,'inherit',rolinherit,'createDb',rolcreatedb,'createRole',rolcreaterole,'replication',rolreplication) ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'platform_%'),
    'roleMemberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',r.rolname,'member',u.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY r.rolname,u.rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE r.rolname LIKE 'platform_%' OR u.rolname LIKE 'platform_%'),'[]'::jsonb),
    'evaluatorCapabilities',COALESCE((SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname='platform_agent_evaluation' AND acl.privilege_type='EXECUTE'),'[]'::jsonb),
    'memoryControllerCapabilities',COALESCE((SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname='platform_memory_review_controller' AND acl.privilege_type='EXECUTE'),'[]'::jsonb),
    'whatsappVerifierCapabilities',COALESCE((SELECT jsonb_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl JOIN pg_roles r ON r.oid=acl.grantee WHERE r.rolname='platform_whatsapp_verifier' AND acl.privilege_type='EXECUTE'),'[]'::jsonb),
    'functionOwners',(SELECT jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'owner',r.rolname) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname IN ('public','platform','ops','messaging','crm','objects','agents','audit','service','automation','support')),
    'protectedTables',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND c.relrowsecurity AND n.nspname NOT IN ('pg_catalog','information_schema')),
    'serverVersionNum',current_setting('server_version_num'))" >"${temporary_dir}/security-contract.json"
if find "${release}" -xdev \( -type l -o -type f -links +1 \) -print -quit | grep -q .; then
  echo "Release artifact contains a link; backup refused" >&2
  exit 1
fi
tar --create --file "${temporary_dir}/release.tar" --directory "${release}" \
  --sort=name --format=posix --pax-option=delete=atime,delete=ctime .
python3 - "${temporary_dir}" "${DEPLOYMENT_DATABASE_NAME}" "${database_only}" <<'PY'
import json
import re
import sys
from pathlib import Path
root = Path(sys.argv[1])
head = (root / 'schema-head.txt').read_text().strip()
release = (root / 'release.txt').read_text().strip()
contract = json.loads((root / 'security-contract.json').read_text())
if not re.fullmatch(r'[0-9a-f]{12}', head) or not re.fullmatch(r'[0-9a-f]{40}', release):
    raise SystemExit('One valid schema head and immutable release are required')
if not contract.get('requiredRoles') or not contract.get('protectedTables'):
    raise SystemExit('Recovery security contract is incomplete')
evaluator = 'platform_agent_evaluation'
evaluator_roles = [r for r in contract['requiredRoles'] if r['name'] == evaluator]
if evaluator_roles:
    flags = ('superuser', 'bypassRls', 'login', 'inherit', 'createDb', 'createRole', 'replication')
    expected = {
        'platform.claim_agent_quality_evaluation()',
        'platform.append_agent_quality_case(uuid,uuid,uuid,jsonb)',
        'platform.finalize_agent_quality_evaluation(uuid,uuid)',
        'platform.fail_agent_quality_evaluation(uuid,uuid,text)',
        'platform.queue_nightly_agent_quality_evaluations(integer)',
    }
    if (len(evaluator_roles) != 1 or any(evaluator_roles[0].get(k) is not False for k in flags)
        or any(evaluator in (r['role'], r['member']) for r in contract['roleMemberships'])
        or set(contract['evaluatorCapabilities']) != expected):
        raise SystemExit('Evaluator recovery security contract is unsafe')
controller = 'platform_memory_review_controller'
controller_roles = [r for r in contract['requiredRoles'] if r['name'] == controller]
if controller_roles:
    flags = ('superuser', 'bypassRls', 'login', 'inherit', 'createDb', 'createRole', 'replication')
    expected = {'platform.current_tenant_id()', 'agents.attest_real_memory_source(uuid,text)'}
    capabilities = contract.get('memoryControllerCapabilities', [])
    if (len(controller_roles) != 1 or any(controller_roles[0].get(k) is not False for k in flags)
        or any(controller in (r['role'], r['member']) for r in contract['roleMemberships'])
        or len(capabilities) != len(expected) or set(capabilities) != expected):
        raise SystemExit('Memory controller recovery security contract is unsafe')
controller = 'platform_whatsapp_verifier'
controller_roles = [r for r in contract['requiredRoles'] if r['name'] == controller]
if controller_roles:
    flags = ('superuser', 'bypassRls', 'login', 'inherit', 'createDb', 'createRole', 'replication')
    expected = {'agents.attest_whatsapp_signature(uuid,text,jsonb)'}
    capabilities = contract.get('whatsappVerifierCapabilities', [])
    if (len(controller_roles) != 1 or any(controller_roles[0].get(k) is not False for k in flags)
        or any(controller in (r['role'], r['member']) for r in contract['roleMemberships'])
        or len(capabilities) != len(expected) or set(capabilities) != expected):
        raise SystemExit('WhatsApp verifier recovery security contract is unsafe')
(root / 'backup-manifest.json').write_text(json.dumps({
    'formatVersion': 2, 'database': sys.argv[2], 'schemaHead': head, 'release': release,
    'databaseOnly': sys.argv[3] == 'true', 'objectsIncluded': sys.argv[3] != 'true',
    'releaseIncluded': True, 'keyMaterialIncluded': False,
    'keyEscrowStatus': 'external_required', 'serverVersionNum': contract['serverVersionNum'],
}, sort_keys=True))
PY
backup_members=(database.dump release.txt schema-head.txt security-contract.json release.tar backup-manifest.json)
if [[ ${database_only} == false ]]; then
  tar --create --file "${temporary_dir}/objects.tar" --directory "${objects_dir}" \
    --sort=name --format=posix --pax-option=delete=atime,delete=ctime .
  backup_members+=(objects.tar)
fi
(
  cd "${temporary_dir}"
  sha256sum "${backup_members[@]}" >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
tar --create --gzip --file "${temporary_archive}" --directory "${temporary_dir}" \
  --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
  "${backup_members[@]}" SHA256SUMS
gzip --test "${temporary_archive}"
sha256sum "${temporary_archive}" | sed "s#${temporary_archive}#$(basename "${destination}")#" \
  >"${temporary_checksum}"
chmod 0600 "${temporary_archive}" "${temporary_checksum}"
mv -- "${temporary_archive}" "${destination}"
mv -- "${temporary_checksum}" "${destination_checksum}"
# Retention requires a separately approved maintenance action. Preserve all backups.
if [[ ${database_only} == true ]]; then
  echo "Created pre-deploy database-only backup ${destination}"
else
  echo "Created database and private-object backup ${destination}"
fi
