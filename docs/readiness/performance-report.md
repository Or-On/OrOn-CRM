# Performance evidence — 2026-09-12

Status: verified-local for the measurements below; no staging/SLA claim.

The candidate benchmark runs the actual `listContacts` repository projection in
transactions as `platform_web` with tenant/user context and RLS. It creates and
removes its own database on the separately containerized PostgreSQL18.6 cluster,
not the developer database. Script: candidate `scripts/benchmark_readiness.mjs`;
raw plan/evidence: `.artifacts/readiness/candidate/.artifacts/readiness-benchmark.json`.

| Workload | Samples / concurrency | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| Contacts list, page50 | 80 /4 | 8.77ms | 14.14ms | 21.02ms |
| Broad name search, page50 | 80 /4 | 11.68ms | 27.77ms | 38.46ms |

Dataset: two tenants,10,000 contacts each, no channel identities/tags. First
observed list12.59ms; not a cold-host/cache benchmark. Safe EXPLAIN ANALYZE BUFFERS
recorded6.552ms execution. Docker Desktop cluster limited to2CPUs/1GiB; Windows
host also running the user's application and candidate builds/preview. The
numbers include local network/transaction setup but exclude HTTP authentication,
rendering, media and realistic association density. They are not production capacity.

No speculative index, cache, query-engine change or fabricated percentage gain
was introduced. Candidate contact detail now tolerates unavailable optional voice
controls without losing the core contact read; regression tests cover the failure.
This is a reliability fix, not a measured latency reduction claim.

Provisional *test budgets*, not SLAs: contact repository p95<100ms at this exact
fixture; authenticated read API p95<500ms on a quiet production-mode local stack;
no horizontal overflow at360/390/768/1440px. Full HTTP/load/CPU/RAM/pool-exhaustion,
large message history, populated tags/identities and mixed write workloads remain
required before choosing VM capacity or claiming application-wide speed.

Browser measurements/screenshots and known tablet/Settings repairs are in the
application verification report. Do not conflate Next development compilation
with production request latency. No load or fault test ran against the user's stack.

## Final production-image public-entry sample

After the final image build and migration to `bfb741c767fd`, 60 sequential
PowerShell `Invoke-WebRequest` requests to the disposable Caddy `/login` route
all returned HTTP 200. Three warm-up requests were excluded; concurrency was 1.
Observed nearest-rank p50 **12.12 ms**, p95 **16.16 ms**, p99 **29.11 ms**.
This includes local client/proxy/server round trip, not browser rendering, TLS,
authenticated database workflows, cold startup or a deployed GCP latency claim.
Image scanning and other local activity shared the host; this is not a controlled
before/after optimization claim.

The final production web build contains **71 static files / 2,203,983 bytes**
under `.next/static`. This is the sum of all uncompressed emitted assets, not
per-route downloaded JavaScript or a Lighthouse score. Route-specific browser
transfer/CPU/Core Web Vitals budgets still require representative authenticated
navigation profiling before release.
