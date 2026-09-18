# Tenant operations configuration

OrOn runs one codebase for materially different businesses. Customer differences are data:

```text
Tenant → enabled modules → process binding → published Agent + Flow
       → authorized agent capability → domain action
```

## Deliberately separate controls

- A **platform module** is a tenant-scoped product area such as Leads, Tickets, Field Service, WhatsApp or Voice. `packages/ts/crm/src/tenant-features.ts` is the catalog; `platform.tenant_feature_entitlements` is the persisted state.
- A **human permission** is granted by the existing `@or-on/auth` role model. Enabling Leads does not grant a viewer write permission, and a tenant administrator cannot use a disabled module merely because their role allows CRM writes.
- An **agent capability** is an operation on an immutable agent version, such as `lead.write` or `ticket.open`. Prompts never grant capabilities. Each capability maps to a required tenant module and is checked during authoring, publication and runtime.
- A **provider kill switch** controls a real external side effect. `ENABLE_REAL_WHATSAPP`, telephony admission and provider credentials remain independent and default off. Enabling the WhatsApp or Voice module does not enable a real provider.
- A **tenant process** is a business-purpose binding around the existing Agent/Flow engine. It pins exact published versions, a supported trigger, channel, business object and explicit priority. It is not another workflow engine.

## Module lifecycle

Feature configuration uses schema version 1 and a bounded JSON object. The current schema intentionally accepts no feature-specific keys; specialized settings, such as Field Service calendar policy, remain in their typed domain table. Future configuration keys require a new typed validator and an explicit schema-version migration.

Enabling validates the dependency graph. Disabling is non-destructive: records, immutable versions and audit history remain. New page/API operations fail with `TENANT_FEATURE_DISABLED`, agent publication rejects incompatible capabilities, database write fences prevent queued jobs from mutating disabled domains, and Voice/WhatsApp workers revalidate immediately before provider work. Re-enabling restores access to preserved data.

Feature and process mutations record the actor, time, revision and safe metadata in `audit.records`. Expected revisions prevent lost updates. Active processes block disabling a module they require; dependent enabled modules also block it. There is no cascade deletion.

## Processes and routing

`automation.tenant_processes` references existing immutable `agents.agent_profile_versions` and `automation.flow_versions`. Supported triggers correspond to real producers. An active binding requires both versions to be published and valid, channel compatibility, enabled required modules and compatible agent capabilities.

Routing orders matches by explicit numeric priority. A unique active precedence constraint prevents two bindings from owning the same trigger/channel/priority. WhatsApp new-conversation assignment and Voice configuration prefer an explicit process; documented tenant defaults remain a fallback only when no process matches. Running conversations keep their pinned agent version. Human ownership remains sticky.

Runtime diagnostics may record tenant, process/version, agent/version, flow/version, trigger, object identifier and result. Prompts and customer message bodies are not process diagnostics.

## Templates and onboarding

The versioned starting templates are Field Service, Lead Generation, Customer Support and Blank/Custom. Application is tenant-scoped and idempotent through `platform.tenant_template_applications`. A retry does not duplicate provenance, and rows whose source is `operator` are not overwritten. Templates never configure credentials or enable real providers.

Low-level tenant provisioning keeps the previously global, non-entitled modules enabled for backward compatibility. The administrative tenant-creation transaction immediately applies the selected template; the Blank template leaves only Contacts enabled. Field Service retains the existing platform entitlement step. Existing tenants are backfilled with previously reachable modules enabled; Field Service and its dependent operational modules inherit the pre-migration effective Field Service state. No business rows are removed or rewritten.

The administrative flow is: create tenant, choose a template, review modules, review exact Agent/Flow process bindings, then configure providers separately. Until public signup is intentionally introduced, this remains in the authenticated tenant/platform administration surface.

## Adding a module

1. Add the key, label, purpose and real dependencies to the canonical TypeScript catalog and the database key constraint.
2. Map its routes and any agent capabilities to that key.
3. Guard the authoritative domain/API boundary and durable worker side effects. Add a database write fence where queued work can mutate the domain.
4. Add it to appropriate templates without changing existing template applications.
5. Add four-tenant, transition, RLS, worker and navigation tests. Never add tenant-name branches.

## Adding a template

Add a versioned catalog entry, validate its dependency closure, expose it in Business configuration and cover idempotence/provenance. A new global template version is only a new onboarding option; it never rewrites an existing tenant automatically.
