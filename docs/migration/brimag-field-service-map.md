# Brimag field-service source-to-target map

## Verified repositories

- Target: `Abssel-AI/OrOn-CRM`, branch `main`, baseline commit `a7d18bc7bf937154af9d120fede61355a0a09271`.
- Read-only reference: `Abssel-AI/Brimag`, branch `main`, commit `08228541cf0ccf7f65eb8517ec9c5346c29f280f`.

No Brimag runtime, database, credentials, customer records, deployment settings, or branding is linked to the CRM.

## Capability mapping

| Reference behavior                                | CRM-native implementation                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technician report handler and application service | Tenant-scoped field-service use cases in `@or-on/crm`, exposed through authenticated Next.js route handlers                                             |
| Technician report repository                      | Additive PostgreSQL `service` schema with forced RLS and composite tenant foreign keys                                                                  |
| Private report storage                            | Existing `objects.object_metadata` plus a root-confined private-object adapter with signature/MIME/size validation                                      |
| Report images and browser preparation             | CRM upload routes and a small client preparation helper supporting camera capture and file selection                                                    |
| OCR extraction and correction                     | Durable `ops.jobs` work with proposed/confirmed values, provenance, confidence, review states, and human-edit protection                                |
| Report lifecycle and required-photo rules         | Draft, review, finalized, and superseded revisions with server-side validation and immutable finalized revisions                                        |
| Existing filtering and exports                    | CRM-native case filters, branded print/PDF views, finalized-report XLSX, CSV/JSON indexes, bounded case ZIP dossiers, and authorized evidence downloads |
| Technician identity snapshots                     | Visit/session-specific technician identity assertions; never a mutable “current technician” on a shared user                                            |

## Explicit exclusions

- BI, finance, collection-report ingestion, morning reports, and unrelated analytics.
- Brimag-specific LG/compressor rules, source authentication, infrastructure, deployment assumptions, and hard-coded names.
- Source migrations copied verbatim, public evidence storage, production data, or a runtime dependency on the reference checkout.
- Source Playwright and ExcelJS runtime assumptions. The CRM uses its Hebrew-safe browser-print/PDF path and a bounded, dependency-free OOXML/ZIP boundary rather than copying the reference application's headless-browser deployment or package graph.

## Implementation sequence

1. Add the typed feature registry, entitlement/activation state, permissions, branding, customer classifications, stores, and protected customer dossier fields.
2. Add tenant-isolated cases, appointments, visits, session identities, signatures, report revisions, evidence links, OCR results, audit history, and processing state.
3. Add server-only CRM use cases, private-object handling, authenticated APIs, and worker-safe feature rechecks.
4. Connect canonical WhatsApp messages, conversations, calls, transcripts, and durable intake correlation without introducing a second webhook pipeline.
5. Add CRM-native responsive pages/settings in English and Hebrew, then validate migrations, RLS, authorization, workflows, uploads, OCR contracts, exports, and regressions with synthetic fixtures only.
