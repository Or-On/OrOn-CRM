# Python packages

`platform-integration` contains new cross-system configuration, observability, and
contract glue only. Later Or-on packages keep their mature distribution/import
names and proven dependency direction; they are not renamed to `platform-*`.

Phase 5 retains these low-level Or-on packages under their original identities:

- `oron-common`: call context, E.164 validation, and usage/cost models.
- `oron-db`: SQLModel bases, engine construction, runtime-role selection, and
  transaction-local tenant RLS helpers.
- `oron-flows`: typed voice graph, component catalog, composition, publishing,
  and storage interfaces.

They are proprietary project code imported from the locked Or-on revision. The
target manifests pin verified Python 3.14-compatible dependency versions; source
behavior and behavioral assertions are preserved.
