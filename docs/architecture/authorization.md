# Authorization and tenant switching

Authorization is the intersection of an active canonical user, an active tenant,
an active membership, the membership role's explicit permissions, route/domain
policy, and PostgreSQL RLS. Missing information denies access.

| Permission                              |            owner            |  admin  | agent | viewer |
| --------------------------------------- | :-------------------------: | :-----: | :---: | :----: |
| View foundation/system health           |             yes             |   yes   |  yes  |  yes   |
| Read CRM/messaging/live records         |             yes             |   yes   |  yes  |  yes   |
| Operate conversations and assigned work |             yes             |   yes   |  yes  |   no   |
| Manage campaigns/flows                  |             yes             |   yes   |  no   |   no   |
| Manage members and invitations          |             yes             |   yes   |  no   |   no   |
| Change member roles                     |             yes             | limited |  no   |   no   |
| Transfer ownership/remove final owner   | explicit protected workflow |   no    |  no   |   no   |
| Manage tenant/security settings         |             yes             | limited |  no   |   no   |

Platform super-administrator is an account flag, not a fifth tenant role. It
receives every typed permission and permits tenant inventory/creation while
still using an explicitly selected tenant context for tenant-owned data. Tenant
`admin` has the full product permission set inside its tenant, but database
ownership guards prevent it from granting, demoting, or removing an `owner`.
Only an owner (or platform super-administrator) may manage ownership, and the
last owner cannot be removed or demoted.

The TypeScript permission matrix is the application policy vocabulary. It does
not replace RLS. The BFF validates permission before opening a transaction, and
the transaction sets tenant/user/role context from the resolved server-side
session. Tenant IDs supplied in routes or payloads are object identifiers to
validate, not trusted context.

Tenant switching is a state-changing operation protected by CSRF and origin
checks. It verifies membership inside PostgreSQL and atomically replaces the
session token/digest and selected tenant. The previous token stops working.

## Technician application scope

`technician` is a canonical tenant role with `platform:read`,
`field-service:read` and `field-service:operate`. A technician session works
inside a dedicated Field Service application rather than the workspace:
`applicationScope()` classifies the session, and only `field-service:*`
permissions may be exercised inside it. `platform:read` therefore still powers
the application shell (tenant branding, enabled modules, logo) through the
explicit `withCurrentShellTenant` boundary, while every workspace page and API
that asks for it — profile, settings, tenants, platform health — denies a
technician. The public session publishes the scope and the permissions that
remain usable in it, so navigation, the command palette and quick actions
project the same rule the server enforces. Direct navigation to a workspace
route is redirected to `/field-service` by the root layout (from the
proxy-supplied request path) and independently denied by each page guard.

## Shared technician accounts

One technician account may be signed in on many devices at once, each used by a
different physical technician. Simultaneous sessions are preserved: a new login
never revokes a sibling session, and sign-out revokes only the presenting one.
Because `user_id` no longer identifies the person doing field work, each
authenticated session names its physical technician once, and PostgreSQL stores
that binding against the exact `auth_session_id`
(`service.technician_session_bindings`, written only by SECURITY DEFINER
functions and readable only by its own session).

`service.current_session_technician_id()` is the single resolver: an
individually linked account (`service.technicians.linked_user_id`) keeps its own
profile, and a shared account resolves the technician bound to this still-valid
session while shared technician login is enabled. Case access, technician
visibility, the dispatch queue, self-claim, technician-created cases, visit
identity, report work and evidence all resolve through it, so two technicians
sharing one login never inherit each other's work. Confirmation uses the
profile's employee identifier, which is never returned to the device.

## Enforcement and verification

The same canonical authorization decision is used for the public session,
server-side tenant transactions, control-plane service grants, live-agent
grants, and outbound-call dispatcher grants. Interactive voice grants require
`voice:operate`; read access alone is insufficient. Platform tenant inventory
and creation additionally require the super-administrator account flag at the
API boundary.

Regression coverage verifies:

- every role against every permission, including denied combinations;
- every role-assignment pair, including the owner-only boundary;
- high-risk API mutations against their required permission token;
- super-administrator-only tenant inventory and creation;
- PostgreSQL tenant isolation, fail-closed context, runtime-role privileges,
  DDL denial, audit immutability, and service-domain separation;
- owner/admin member-management behavior and explicit rejection of agent and
  viewer tenant/member administration;
- technician application scope on the server and in the shell, simultaneous
  sessions of one account, per-session technician bindings, session-aware
  queue/claim/case creation and report isolation.

Focused checks are `pnpm --filter @or-on/auth test`,
`pnpm --filter @or-on/web test -- authorization-contract.test.ts`, and the
PostgreSQL authorization suites under `db/tests/postgres/`, including
`db/tests/postgres/test_technician_sessions.py` for shared technician
accounts.
