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
  viewer tenant/member administration.

Focused checks are `pnpm --filter @or-on/auth test`,
`pnpm --filter @or-on/web test -- authorization-contract.test.ts`, and the
PostgreSQL authorization suites under `db/tests/postgres/`.
