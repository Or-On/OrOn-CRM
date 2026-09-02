# Dispatcher runtime

This process hosts the retained `oron-dispatcher` package. Its public provider
boundary is the signed `POST /livekit/webhook`; its platform command boundary
uses short-lived assertions with audience `dispatcher` and capability
`voice:dial`.

The runtime is intentionally **not ready** at the P5-009 checkpoint because the
retained Pipecat launcher is integrated separately in P5-010. Liveness remains
available for process diagnostics. No route falls back to a fake agent or real
provider.

Real SIP can be reached only when all of these are true:

1. trusted configuration has `ENABLE_REAL_TELEPHONY=true`;
2. the authenticated command carries explicit per-action approval;
3. an outbound trunk is configured;
4. canonical lifecycle persistence succeeds before launch/dial;
5. the SIP adapter repeats the safety check at the provider edge.

Ordinary development and all P5-009 tests keep real telephony disabled and use
signed fictional fixtures plus injected fakes only.
