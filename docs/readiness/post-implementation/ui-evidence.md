# UI, responsive and accessibility evidence

## Locally established

- The final Next.js production build compiled all pages and route handlers.
- The complete web suite passed 535 tests with one explicit skip. It covers
  shell-free auth/invitation routing, navigation permissions, theme transition
  and reduced motion contracts, English/Hebrew direction, tenant/user/role/
  finance/field-service layouts, inbox interaction state, avatar/logo fallback,
  empty/error states and protected actions.
- Field-service component tests verify distinct computer file upload and mobile
  rear-camera capture controls, required evidence fields, progress/retry
  behavior, Hebrew `dir=rtl` rendering and branded report data.
- CSS/source inspection confirms responsive alternatives for contacts, tasks,
  finance, calendar and inbox, logical RTL properties and explicit
  `prefers-reduced-motion` rules. This is source evidence, not device evidence.
- The production build produced the global not-found route plus all 28 current
  page routes without hydration/build errors.

## Browser attempt and precise limitation

A local production server was started with external providers disabled and a
deliberately unreachable database. The in-app browser opened `/login`; session
resolution failed closed with the generic service-unavailable view and the
server logged a database connection refusal. That process was stopped. This
check proves only the safe failure state—it does not prove authenticated layout
or persistence.

No representative before/after screenshots or animation recordings are
included because there was no database-backed browser runtime with fictional
fixtures. Capturing a generic failure page would be misleading. The
computer-use workflow made this evidence boundary explicit rather than treating
an HTTP 200 or static source inspection as visual acceptance.

## Unexecuted required matrix

The following remain **BLOCKED**, not passed:

- 320/360/390/430 px phones, 768/1024 px tablets, 1440/1920 px desktops and
  landscape on the exact candidate;
- 200% zoom and operating-system text scaling;
- actual light/dark transition and option contrast in a signed-in session;
- keyboard-only traversal, screen-reader names/live announcements, dialog focus
  trap/return and measured WCAG 2.2 AA contrast;
- iOS Safari and Android Chrome camera/file capture, keyboard avoidance,
  orientation, weak network, cancel/retry and interrupted report submission;
- authenticated browser console, hydration and failed-network inspection for
  every page/role in both English/LTR and Hebrew/RTL;
- tenant switch while list/search/upload/form requests are in flight.

## Acceptance procedure

1. Start an owned PostgreSQL-backed production build with deterministic,
   tenant-separated fictional fixtures and providers disabled.
2. Test anonymous routes first, then owner/admin/agent/technician/viewer and
   platform administrator separately.
3. At each listed viewport, record DOM scroll width versus viewport width,
   clipped/fixed elements, reachable primary/destructive actions and dialog
   geometry; do not rely on screenshots alone.
4. Run English and Hebrew in both themes and with reduced motion, keyboard and a
   screen reader. Record console/network failures alongside visuals.
5. Repeat critical inbox and technician-phone journeys on physical iOS/Android.
6. Store fictional-data screenshots with release/source identity and mark
   emulation separately from physical-device evidence.
