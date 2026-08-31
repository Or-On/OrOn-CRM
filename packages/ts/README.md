# TypeScript packages

Packages expose intentional root APIs under the private `@or-on/*` namespace.
Cross-package deep imports are prohibited. `platform-integration` is new composition
code only and must not become a renamed copy of upstream business engines.

Generated contract consumers live in `api-client/src/generated` and are never
hand-edited.
