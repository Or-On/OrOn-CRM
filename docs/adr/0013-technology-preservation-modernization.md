# ADR 0013: Technology preservation and modernization

- Status: Accepted
- Date: 2026-08-31
- Owners: Architecture

## Context

The sources are working systems, but their pinned dependency versions are not all
current or supported. Treating technology selection and version selection as the
same decision would either preserve avoidable vulnerabilities or cause wholesale
framework rewrites.

## Decision

Classify significant choices as Preserved, Adapted, Replaced — Required, or
Replaced — Optional. Preserve proven engines and protocols where compatible;
integrate them through thin adapters to canonical contracts. Required replacements
remove target conflicts such as Supabase runtime coupling, Firebase runtime
identity, and OpenLive SQLite/JSON persistence. Optional replacements require
explicit user approval.

Select the latest stable, actively supported, security-patched version that passes
runtime and behavior compatibility gates. Prefer LTS runtime foundations. Do not
select alpha, beta, RC, canary, nightly, or preview releases merely for freshness.
Modernize incrementally by coherent dependency group with recorded source version,
breaking changes, tests, and build results.

## Consequences

Framework uniformity is not an objective. A modern version may be held back when
critical tooling or native dependencies cannot support it; that fallback is
documented in the technology baseline rather than hidden.

## Verification

Registry/documentation evidence, compatibility probes, lockfile review, security
scans, and source behavior tests during later ports.
