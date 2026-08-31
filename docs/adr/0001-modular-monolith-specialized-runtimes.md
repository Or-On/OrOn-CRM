# ADR 0001: Modular monolith plus specialized runtimes

- Status: Accepted
- Date: 2026-08-31
- Owners: Architecture

## Context

The sources combine ordinary CRM/business modules with telephony media, browser
local AI, WebSocket/ACP child processes, and background provider work. Copying each
source repository into its own network service would preserve organizational
boundaries rather than technical lifecycle boundaries.

## Decision

Use one unified Next.js product/BFF and one Python control boundary for ordinary
platform behavior, plus bounded dispatcher, voice-agent, live-agent, and
messaging-worker processes where runtime/lifecycle isolation is real. Do not split
further without a new ADR.

Preserve Or-on Python/FastAPI/LiveKit/Pipecat and OpenLive TypeScript/Hono/ACP
engines. Integration uses thin adapters and versioned contracts.

## Consequences

Deployment remains understandable on localhost and one VM. Cross-process calls
must justify their latency/failure modes. Modules need enforceable public APIs to
prevent the monolith from becoming tightly coupled.

## Verification

Repository layout checks, dependency-boundary tests, and runtime-topology review.
