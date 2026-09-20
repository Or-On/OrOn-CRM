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

Feature configuration uses schema version 1 and a bounded JSON object. Field Service accepts a strictly validated `workflow` policy: required intake fields, photo policy, technician self-assignment, and required report fields. Integration settings, such as calendar policy, remain in their typed domain table. Unknown configuration keys are rejected by both the application and database.

Enabling validates the dependency graph. Disabling is non-destructive: records, immutable versions and audit history remain. New page/API operations fail with `TENANT_FEATURE_DISABLED`, agent publication rejects incompatible capabilities, database write fences prevent queued jobs from mutating disabled domains, and Voice/WhatsApp workers revalidate immediately before provider work. Re-enabling restores access to preserved data.

Feature and process mutations record the actor, time, revision and safe metadata in `audit.records`. Expected revisions prevent lost updates. A proposed package must contain its full dependency closure and every module its active processes require. There is no cascade deletion.

## Review and activation

`platform.tenant_configuration_releases` stores the complete versioned package: template provenance, enabled modules, module configuration and exact process bindings. Owners and tenant administrators save drafts and submit them. Only a platform super administrator can approve or reject a submitted revision. Editing a submitted revision returns it to draft; stale saves and reviews fail rather than overwrite another operator's work.

Approval validates published same-tenant versions and channel/capability compatibility again, then atomically activates modules, the service policy and process bindings. Failed approval rolls back all changes. Direct module and process edits cannot bypass the review boundary. Rejected releases remain in history without changing the active package. To revert, submit the earlier configuration as a new reviewed release rather than rewriting history.

Existing tenants receive a published baseline preserving current behavior. New tenants start with Contacts only and the selected package as a draft. For initial setup, approve the module package, author and publish the agents/flows, then submit and approve their exact process bindings. A channel without an approved binding is shown as not configured. Publishing a new agent alone does not activate it for new conversations. Existing legacy defaults remain eligible only until the first reviewed replacement, and existing conversations keep their pinned versions.

## Processes and routing

`automation.tenant_processes` references existing immutable `agents.agent_profile_versions` and `automation.flow_versions`. Supported triggers correspond to real producers. An active binding requires both versions to be published and valid, channel compatibility, enabled required modules and compatible agent capabilities.

Routing orders matches by explicit numeric priority. Validation rejects ambiguous wildcard/channel precedence. WhatsApp new-conversation assignment and Voice admission prefer an explicit process; voice callbacks must select an approved agent/flow pair, checked again by the worker. A missing approved voice binding cannot fall back to a retained legacy prompt in a governed tenant. Conversation reassignment is checked at the database boundary too. Running conversations keep their pinned agent version; service drafts/cases also retain their intake/report policy snapshot. Human ownership remains sticky. Disabling a module still fences its next mutation, including paused/ended voice-session actions.

Runtime diagnostics may record tenant, process/version, agent/version, flow/version, trigger, object identifier and result. Prompts and customer message bodies are not process diagnostics.

## Templates and onboarding

The versioned starting templates include Field Service, Lead Generation, Customer Support, Leads + Support, Leads Only and Blank/Custom. Templates populate a draft; they never configure credentials, approve their own changes, or enable real providers. Historical template-application provenance is retained.

Low-level tenant provisioning retains legacy defaults for integration compatibility. The administrative tenant-creation transaction immediately initializes the reviewed package lifecycle with only Contacts active. Field Service retains the separate platform entitlement step. No existing business records are removed or rewritten.

Examples are configuration, never tenant-name branches:

| Business          | Starting package | Workflow                                                                                                            |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| Or-On             | Leads + Support  | WhatsApp/voice leads and support, with separate explicitly granted actions                                          |
| ProTouch          | Field Service    | WhatsApp/voice customer, chain, store, exact fault and photos; linked ticket/incident; technician claim and reports |
| Leads-only tenant | Leads Only       | Contacts and leads; channels and automation added only when approved                                                |

The administrative flow is: create tenant, choose a template, approve modules, author published Agent/Flow versions, approve their exact bindings, then configure and verify providers separately. Tenant knowledge, business prompts, chain/store directories and channel credentials must be supplied by the operator; templates do not invent them. Until public signup is intentionally introduced, this remains in authenticated administration.

## Shared service intake and technician experience

The `service.intake` capability runs on both WhatsApp and voice and requires Field Service and Tickets. The platform supplies known contact/transport phone and directory context; the model proposes facts, while shared SQL validates missing fields and persists the result. A customer confirmation creates one linked ticket and service case, with idempotent retries. Only a successful receipt permits a creation claim. Voice never accepts a model-supplied caller number or collects plaintext government identification; approval rejects voice service policies requiring `nationalId`.

The retail policy asks for customer, chain, store, fault and exact failure, requests photos without blocking on them, and permits technician self-assignment. Required photos instead block confirmation. Voice can queue an eligible WhatsApp photo request; absence of a reachable configured channel is reported honestly. Follow-up evidence is associated with the intake/case, including after confirmation. Prompts use these server-supplied requirements rather than hardcoded tenant scripts.

Technicians see a minimal available queue and their assigned work. Claiming is atomic and exclusive; full customer/case access follows successful assignment. Managers can reassign through the audited assignment API and maintain the chain/store directory. Report requirements come from the case's pinned policy. The UI uses the shared page headers, surfaces, status feedback and bilingual responsive shell; disabled modules disappear from navigation, dashboard actions and command-palette results.

## Adding a module

1. Add the key, label, purpose and real dependencies to the canonical TypeScript catalog and the database key constraint.
2. Map its routes and any agent capabilities to that key.
3. Guard the authoritative domain/API boundary and durable worker side effects. Add a database write fence where queued work can mutate the domain.
4. Add it to appropriate templates without changing existing template applications.
5. Add four-tenant, transition, RLS, worker and navigation tests. Never add tenant-name branches.

## Adding a template

Add a versioned catalog entry, validate its dependency closure, expose it in Business configuration and cover idempotence/provenance. A new global template version is only a new onboarding option; it never rewrites an existing tenant automatically.
