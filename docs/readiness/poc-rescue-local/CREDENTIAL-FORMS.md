# USER-077 — credential form preservation

## Surface inventory

The persistent provider-secret entry form in this web source is Email OAuth setup (Google/Microsoft). It renders a **blank, required password input**, never an existing secret or masked placeholder. The configuration GET returns only provider-configured booleans. Connected-account cards render persisted channel metadata; the earlier browser pass showed explicit unconfigured states. WhatsApp, model and voice provider secrets are server/operator configuration rather than editable masked fields in the current UI. Personal password/security forms and create/revoke API keys are separate workflows; no existing provider-secret mask is submitted by them.

Thus a masked-placeholder edit round trip does not exist for the inventoried provider form. The relevant preservation paths were tested against the real API handlers, real encrypted storage and PostgreSQL RLS instead of declaring the requirement complete from source alone.

## Reproduced and fixed

- **Stale tenant form:** a credential form rendered for tenant A could overwrite tenant B after the active authenticated tenant changed. The real handler/DB regression returned200 before the fix. POST now requires the rendered `expectedTenantId` and compares it with a freshly authorized tenant before writing. A mismatch returns400 and preserves the stored envelope. The OAuth continuation carries and checks the same expected tenant before creating provider state.
- **Provider draft reuse:** entering a Google client secret and switching to Outlook retained that secret in the Outlook form. A component regression reproduced this. Switching provider now clears the client ID, secret and directory fields. Reopening the same provider retains its recoverable draft.
- The Email page keys the workspace by tenant ID, so a tenant change remounts its private drafts. Stale-workspace failures are explained in English/Hebrew and retain the failed draft without navigating to a provider.

## Executed evidence

`oauth-configuration-preservation.postgres.test.ts` creates two fictional tenants and an owner in the owned local `oron_ui_preview_*` database. HTTP authentication is supplied by a controlled fixture that uses the actual `withTenantTransaction` and `platform_web` role; requests call the actual route handlers. This is an API/DB integration test, not a full authenticated browser session.

The passing cases establish:

- New/unconfigured provider GET is false; saved provider GET is true and contains no secret.
- Empty, whitespace or omitted secrets are rejected; credential ID, ciphertext, nonce, key version and rotation timestamp remain unchanged.
- Saving unrelated business settings, including unexpected credential-like payload fields, leaves the credential unchanged.
- Fresh reads after save and switching A→B→A preserve independent encrypted state.
- Explicit nonempty replacement updates the same credential record with new ciphertext and the requested fictional secret.
- A stale A form submitted while authenticated scope is B is rejected, B's encrypted record remains unchanged, and stale OAuth continuation is rejected before creating state.
- No provider fetch is made; fixture fetch throws if attempted. Tests remove their tenants/users and the harness removes its owned database.

Six focused web files passed **46 tests** (`credential-preservation-fixed.log`), including the two actual-DB tests, provider draft reset, required empty password input, expected-tenant payload and clear failure behavior. Before logs are `credential-preservation-before.log` and `credential-provider-draft-before.log`. Web typecheck passed (`credential-web-typecheck.log`); focused lint passed after test typing cleanup.

## Limits

No real secret was read into the browser or replaced. No OAuth consent, external provider authentication or real-tenant credential rotation was attempted. Physical browser reload/multi-tab credential entry is not claimed by the component plus API/DB fixture; the existing full browser pass covered business settings save/reload and tenant isolation separately. Provider credentials managed outside these web forms require their own channel/runtime acceptance.
