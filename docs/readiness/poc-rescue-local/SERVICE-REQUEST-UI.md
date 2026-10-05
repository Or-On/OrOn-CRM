# Digital service request UI — October 5, 2026

The user clarified that the fault description is free text. The public `/service-request` form therefore contains name, free-text fault, location, photo upload and an explicit confirmation. It does not offer a configured fault list or open a case from a WhatsApp text reply. The phone and worker behavior is verified by their owning workstreams.

## Public form and isolation

- The bearer capability and tenant are read from the URL fragment, then sent only in authorization headers to the fixed `/api/service-request` endpoint. Query/path credentials are not accepted. The page is noindex, no-referrer and uses an absolute generic document title; the body displays the business name returned for the validated capability.
- The public page bypasses the authenticated shell and technician redirect. Tests cover both existing workspace and technician sessions. No ambient CRM session authorizes the public API.
- A changed fragment clears the old customer draft, file selection and confirmation. A late response from the old link cannot populate the new form. No token is placed in rendered DOM or browser storage.
- JPEG, PNG and WebP are offered: at most five photos, 12 MiB per photo, 20 MiB aggregate. The API uses the existing actual-content image validator and private staging. The server's `photoRequired` follows the configured photo policy; requested photos remain optional.
- Validation or uncertain submission retains the draft and selected files. Duplicate submission returns the original case reference. Only a confirmed successful receipt replaces the form and receives keyboard focus.

## HTTP and file persistence

The 21 HTTP tests use real `Request`, multipart parsing, content validation and private temporary-file staging/promotion/discard. Database methods are controlled fixtures; the root workstream separately tests actual PostgreSQL authorization, row locking, duplicate submission and case/photo linkage. GET projects only public fields, never intake IDs. Invalid capabilities are rejected before upload buffering; POST additionally verifies the configured origin and a single explicit confirmation.

An independent voice-workstream review identified the ambiguous COMMIT acknowledgement case. After all photos for a created receipt have been promoted, a connection failure must preserve them because the database may have committed their references. A fresh read returning the submitted reference reconciles to HTTP 200. An unavailable or negative read returns a recoverable error and preserves the private files. Failures before promotion completion clean up their own staged files. The three failure-injection tests exercise all ambiguous outcomes with actual files. The reviewer cleared the final repair. Private orphan reconciliation after an indeterminate outcome remains an operational limitation; no automatic orphan cleanup is claimed.

## Templates and settings

Inbox template buttons, manual template mode, dialog content and send handlers require `templatesEnabled === true`; missing or false capabilities hide them. Backend authorization remains independent. The empty conversation prompt does not suggest templates when disabled. Existing delivery-surface fixtures explicitly opt in to retain their intended template assertions.

Field operations form mode states that the call gathers name and fault and sends a web-form link. It hides template configuration, the legacy form-field selector and the unrelated request-photo toggle. Regular messages require an open messaging window; unavailable delivery stays pending, without a template or telephone collection fallback. The editor explicitly distinguishes optional photo uploads from the separate required-photo policy.

## External submission visibility

The service overview refreshes its current server route every five seconds while visible and idle. The inquiry and field-service lists refresh their existing read APIs using the applied filters; typed filter drafts stay in place. This is polling plus request latency, not instantaneous push. Polling pauses while hidden, while an editable control has focus, during an open modal, and while a list or mutation is pending. Loading older pages also pauses polling, preserving the expanded records. A visible notice and “Return to latest” action explicitly resume updates. The hook prevents overlapping asynchronous polls and removes timers/listeners on unmount.

Six focused timer/component cases prove a new inquiry and service case appear without manual reload, current overview period and filter drafts remain, dialogs preserve unsaved forms, expanded older pages stay until explicit return, and hidden/editing/in-flight/unmounted states do not poll. Together with existing service-manager, field-service and technician tests, the focused run passed 39 tests (`service-live-refresh-pagination.log`).

## Browser and automated evidence

Root used the available IAB on an owned isolated preview database. EN/HE form loading and native confirmation blocking passed. Submitting a valid 32×32 synthetic PNG created fictional reference `FS-2026-DB6D15DA`; the root checked its database photo/source linkage. The earlier 1×1 PNG rejection was expected image-safety behavior, not a product defect. No customer data or external provider send was used.

Root measured widths 320, 375, 390, 430, 768, 1366 and 1920 with no document horizontal overflow (recorded client widths exclude the scrollbar). Evidence is in `.artifacts/digital-form-preview/responsive-proof.json`, `mobile-form.jpg` and `mobile-receipt.jpg`. UI reviewed both images; the receipt heading needed extra separation from body text, so final CSS adds a 16-pixel gap and a heading-sized focus outline. Root recaptured the final receipt and UI visually confirmed the repaired spacing and focus. The captures predate business-name display; that refinement has component/API evidence rather than a claimed fresh browser capture. `browser-readback.json` confirms one case awaiting scheduling and one available private photo whose bytes and checksum match.

The full web suite passed **163 files / 1,017 tests / zero skips** with a newly migrated disposable PostgreSQL database (`service-request-web-final.log`). This pass includes public API/form, capability gates and settings wording, and precedes the later refresh hook and business-name refinement. The later combined public API/form, live refresh and business-settings pass contains **4 files / 57 tests / zero skips** (`service-request-branding-final.log`), in addition to the final 39-case refresh/adjacent-page pass above. The final lint-only adjustments passed **24 form/refresh tests** (`service-ui-lint-followup-tests.log`). Original development data was not used. No deployment or live acceptance is claimed by this document.

Workspace gates passed: formatting (`digital-form-format.log`), final global ESLint (`digital-form-lint-final.log`), all 11 TypeScript workspace checks (`digital-form-typecheck.log`, plus final web refresh check `service-live-refresh-typecheck.log`) and complete production build (`digital-form-build.log`). The small remaining package suites passed 104 tests across 15 files (`digital-form-small-packages.log`); live-agent passed 4 tests across 2 files (`digital-form-live-agent.log`). None skipped. Worker/CRM and actual PostgreSQL contract results belong to their separate workstreams and are not added to these counts.
