# Service-manager experience

The `field_service` module supports an optional presentation setting:

```json
{ "experience": "service_manager" }
```

The default is `standard`. The simple presentation requires active Tickets and
Field Service. It does not disable WhatsApp, Voice, Agents or their workers,
change permissions, rewrite business records, or change technician completion
requirements. It is reusable across tenants, with no tenant-name conditions.

## Activation

1. Apply Alembic revision `8d4a6c2e9b10` using the normal deployment process.
2. In **Business configuration → Service**, select **Simple service-manager
   screens**. Preserve the existing enabled modules, workflow and process bindings.
3. Save the draft, submit it, and have a platform administrator approve it.

The ProTouch configuration example includes this option. The example is not
automatically applied to a tenant. To restore the previous presentation, uncheck
the option and publish the resulting `standard` configuration through the same
review process. Capability switches must not be used to hide navigation.

## Behavior

- Overview shows incoming telephone calls, incoming messages, inquiries opened,
  and inquiries currently closed with a closure date in the selected period.
  Today, the last seven calendar days, and the current month use the tenant's
  timezone. Browser-test and outbound sessions are excluded from incoming calls.
- Inquiries start with all records, newest opening date first, with server-side
  status, search, date filtering and pagination. An inquiry can exist before an
  intake is confirmed or a service case is created. Existing emergency markers
  remain visible, using the tenant's emergency label when enabled.
- A scheduled status requires a scheduled/in-progress appointment. An assignment
  alone does not establish an appointment. Completed appointment details remain
  available after resolution; cancelled/suggested appointments are excluded.
- Telephone and technician resolution are explicit, authenticated manager actions
  that require a summary and customer confirmation or authoritative evidence.
  The method is retained in the existing closure event's audit evidence. Source
  channel and a completed call never determine resolution method.
- Technician resolution closes an already completed service case and its inquiry
  in one transaction. Telephone resolution refuses outstanding field appointments
  or visits; an unscheduled case with no outstanding work is cancelled through
  the existing audited case transition before its inquiry is resolved.
- Historical closures without an explicit method are labelled **Closed · handling
  method not recorded**. No treatment method is fabricated or backfilled.
- Inquiry details show the problem, scheduled visit, customer messages/photos and
  technician attachments. Gallery images use authenticated private download routes
  without the image optimizer. Broken images retain a file link and a visible
  unavailable label. Customer-message attachments are deduplicated by object ID.
- Managers see arrival/departure in attendance. Technicians retain their existing
  preparation, identity, signatures, work events, photo and report requirements.
- Advanced channel/automation screens remain available in **Settings → Advanced
  tools** to authorized tenant managers. Existing direct routes retain their guards.

## Verification and rollout

Run the CRM and web checks and PostgreSQL configuration/inquiry acceptance tests
on a disposable database. Before activating on a live tenant, verify a real
customer photo, a technician before/after upload, rescheduling/cancellation, a
telephone closure, and a technician closure. A gallery presentation cannot recover
an upload that was never stored or was associated with a different case.

Downgrading the migration refuses while any active feature configuration contains
`experience`; first publish compatible configurations without that key. Business
records and historical configuration releases are preserved.
