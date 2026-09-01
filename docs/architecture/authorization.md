# Authorization and tenant switching

Authorization is the intersection of an active canonical user, an active tenant,
an active membership, the membership role's explicit permissions, route/domain
policy, and PostgreSQL RLS. Missing information denies access.

| Permission | owner | admin | agent | viewer |
| --- | :---: | :---: | :---: | :---: |
| View foundation/system health | yes | yes | yes | yes |
| Read CRM/messaging/live records | yes | yes | yes | yes |
| Operate conversations and assigned work | yes | yes | yes | no |
| Manage campaigns/flows | yes | yes | no | no |
| Manage members and invitations | yes | yes | no | no |
| Change member roles | yes | limited | no | no |
| Transfer ownership/remove final owner | explicit protected workflow | no | no | no |
| Manage tenant/security settings | yes | limited | no | no |

The TypeScript permission matrix is the application policy vocabulary. It does
not replace RLS. The BFF validates permission before opening a transaction, and
the transaction sets tenant/user/role context from the resolved server-side
session. Tenant IDs supplied in routes or payloads are object identifiers to
validate, not trusted context.

Tenant switching is a state-changing operation protected by CSRF and origin
checks. It verifies membership inside PostgreSQL and atomically replaces the
session token/digest and selected tenant. The previous token stops working.
