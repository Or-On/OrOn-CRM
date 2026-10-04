# Observed WhatsApp baseline and retained evidence

This is a read-only live database aggregation, not a certified reply-rate SLI. Deployed source was `42eebac2d423bb70a0c69690e8d2899beab12249`, migration head `fc6e851f3ba0`.

## Window and query semantics

The corrected baseline window is **2026-09-04 20:49:57.560374 UTC through 2026-10-04 20:49:57.560374 UTC**. The first retained receipt is September 13 at 20:30:04 UTC; the requested 30-day interval does not imply 30 days of observed activity. Subsequent cause queries ran at 20:52:47 UTC and shortly afterward, using a rolling 30-day lookback. Their historical cohorts had no intervening provider/queue mutations by this investigation.

Commit `34cbbc7` corrects two query defects: actual send jobs are named `whatsapp.outbound.send`, and delivery/status callbacks do not belong in the inbound-customer denominator. The actual-PostgreSQL regression fixture now uses the worker's real job name and explicitly injects a status callback. Five tests passed, zero skipped, in `sli-status-current.log` (one harmless pytest cache warning).

The query deduplicates receipts by provider/account/provider-message ID, including duplicates first received before the window. It retains unmatched mature receipts and excludes only still-young two-minute observations from the mature denominator. Provider acceptance requires an exact inbound trigger/reply link, outbound request, successful send job and `meta_accepted_*` event. Its acceptance clock is successful send-job completion after provider acceptance; this includes local completion overhead and is not the provider's exact HTTP response timestamp. Delivery uses the provider-reported delivered/read timestamp and remains a separate result.

The denominator is deduplicated inbound **messages**, not fully reconstructed customer conversational turns. No pre-ingestion provider inventory is available, so messages never reaching the webhook cannot enter it. Historical deletions prevent complete outcome attribution. Ambiguous human follow-ups remain candidates, not successful replies. Percentiles include only exactly linked nonnegative accepted samples and require at least 30; they exclude unaccepted/unmatched messages and therefore cannot certify overall customer latency.

## Corrected live counts

Only Or-On had retained receipts; ProTouch's user-sent controlled message had not reached ingestion.

| Observation | Count/value |
|---|---:|
| All retained Meta receipts, including status callbacks | 278 |
| Unique inbound customer-message receipts | 88 |
| Duplicates / pending two-minute window / nontext | 0 / 0 / 0 |
| Exact acceptance within 120 seconds | 37 |
| Exact acceptance later than 120 seconds | 0 |
| No exact retained acceptance link | 51 |
| Receipt has no retained inbound message row | 35 |
| Exact attributed human replies | 0 |
| Ambiguous unlinked human/system candidates | 2 |
| Accepted messages with provider-reported delivery/read | 37 |
| Invalid negative acceptance/delivery clocks | 0 / 0 |
| Acceptance p50 / p95, **accepted subset only**, n=37 | 3.128044 s / 4.5295542 s |

Do not describe the 51 as confirmed silent turns, the 35 as proven ingestion losses, or 37/88 as a certified production response rate. The p50 exceeds the proposed three-second target even in the accepted subset; p95 below eight seconds does not establish the overall latency target.

## Cause and retention evidence

All 35 unmatched inbound events have `status=processed`, a processing timestamp, and one attempt. Their dates are September 13 (five), 14 (16), 15 (one), 16 (five), and 19 (eight). Seven `conversation.deleted` audit records exist, plus 17 Inbox-removal records. Twenty-eight AI jobs reference audited-deleted conversations: 24 succeeded and four died. Twenty-three successful outbound requests and all three dead outbound requests are absent. Fourteen of 18 intake trigger messages are absent. This proves significant retained-evidence deletion; the remaining schema cannot link every old provider receipt back to its deleted message, so individual attribution stays unresolved.

| Job failure category | Count | Created |
|---|---:|---|
| `field_service_intake_failed` | 18 | September 15–19 |
| `field_service_summary_failed` | 13 | September 15–16 |
| `call_http_500` | 1 | September 14 |
| `AI reply failed` | 3 | September 14 |
| `AI inbound trigger superseded` | 2 | September 19 and 23 |
| `ai_evidence_changed` on outbound send | 3 | September 13 |

One historical OCR job is cancelled with `opening_menu_route_denied`. No stale running jobs were present in the snapshot. Generic intake/summary error codes do not identify the underlying old model/schema/provider failure and must not be presented as reproduction against current source.

The 53 retained inbound messages split into 37 with exact outbound links, 15 with no retained AI job, and one dead superseded job. No-job messages occurred September 20 (five), September 21 (eight), and September 30 (two). Two have an unlinked human/system follow-up within an hour. Their conversation is currently AI-owned, but current ownership does not reconstruct eligibility at receipt time. All 66 retained AI-job payloads contain a trigger ID; some referenced rows were later deleted.

The one retained superseded job was created September 23 at 19:10 for a 06:44 customer-message timestamp. Its next retained inbound at 14:03 has an accepted reply. A later reply is proven; an on-time response to the earlier turn is not. Current handoffs are two resolved and seven cancelled, with none pending/accepted. Current conversations are one AI-owned active thread and one human-owned thread removed from the Inbox. This single snapshot does not prove the absence of historical unattended periods or notification gaps.

## Evidence and follow-up

Sanitized local artifacts: `.artifacts/poc-rescue-local/remote-baseline-30day-corrected.txt`, `wa-historical-causes.txt`, `wa-retained-cohorts.txt`, `sli-current.log`, and `sli-status-current.log`. Queries printed allowlisted error codes, aggregate counts, timestamps and internal identifiers only; no message bodies or credentials. No dead jobs or messages were retried.

Required next evidence: preserve a complete canary window with provider-to-webhook correlation, historical ownership/eligibility, turn coalescing, all final outcomes and alert receipts, accepted and unaccepted latency populations, and separate handset delivery. Resolve the provider-boundary blocker described in [WHATSAPP.md](WHATSAPP.md) through the reviewed [Coexistence path](COEXISTENCE-GAP.md). Retention repair should retain minimum outcome metadata without restoring deleted customer content or replaying old sends automatically.
