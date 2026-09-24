// @vitest-environment jsdom
import type { TicketDetail, TicketPage, TicketSummary } from "@or-on/crm";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { TicketDetailView, TicketsWorkspace } from "../src/features/tickets";
import { localized } from "./localized";

afterEach(cleanup);

function ticket(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    emergency: null,
    inquiry: null,
    pendingReplyLinks: 0,
    id: "11111111-1111-4111-8111-111111111111",
    reference: "T-2026-ABCD1234",
    contactId: "22222222-2222-4222-8222-222222222222",
    subject: "Router keeps dropping",
    status: "open",
    stage: "callback_pending",
    priority: "high",
    handlingMode: "ai_whatsapp",
    ownerUserId: null,
    sourceChannel: "whatsapp",
    sourceConversationId: null,
    serviceCaseId: null,
    closureReason: null,
    resolutionClassification: "unknown",
    resolutionConfirmedBy: "none",
    nextAction: null,
    nextActionDueAt: null,
    lastActivityAt: "2026-09-18T09:00:00.000Z",
    openedAt: "2026-09-18T08:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

const contactNames = {
  "22222222-2222-4222-8222-222222222222": "Fictional caller",
};

function page(tickets: readonly TicketSummary[], cursor = false): TicketPage {
  return {
    tickets,
    nextCursor: cursor
      ? { activityAt: "2026-09-18T09:00:00.000Z", id: tickets.at(-1)?.id ?? "" }
      : null,
  };
}

function requestedUrls(): readonly string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([input]) =>
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : "",
    );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(page([])) }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the issue register with its reference, stage and handling mode", () => {
  render(
    localized(
      <TicketsWorkspace
        contactNames={contactNames}
        initialPage={page([ticket()])}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  expect(screen.getByText("T-2026-ABCD1234")).toBeTruthy();
  expect(screen.getByText("Router keeps dropping")).toBeTruthy();
  expect(screen.getByText("Fictional caller")).toBeTruthy();
  // Scoped to the row throughout: every one of these labels is also a filter
  // option, so asserting on the document would pass with an empty table.
  const row = screen.getByRole("row", { name: /T-2026-ABCD1234/u });
  expect(row.textContent).toContain("AI · WhatsApp");
  expect(row.textContent).toContain("Callback pending");
  expect(row.textContent).toContain("High");
});

it("asks the server for a different status instead of filtering in the browser", async () => {
  render(
    localized(
      <TicketsWorkspace
        contactNames={contactNames}
        initialPage={page([ticket()])}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  fireEvent.click(screen.getByRole("tab", { name: "Closed" }));

  await waitFor(() => {
    const calls = requestedUrls();
    expect(calls.some((url) => url.includes("status=closed"))).toBe(true);
  });
});

it("pages with the server cursor rather than loading the whole tenant", async () => {
  render(
    localized(
      <TicketsWorkspace
        contactNames={contactNames}
        initialPage={page([ticket()], true)}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Load more" }));

  await waitFor(() => {
    const calls = requestedUrls();
    expect(calls.some((url) => url.includes("beforeActivityAt="))).toBe(true);
  });
});

it("surfaces a load failure with a retry instead of an empty queue", async () => {
  vi.mocked(fetch).mockResolvedValue({
    ok: false,
    json: () => Promise.resolve({}),
  } as unknown as Response);
  render(
    localized(
      <TicketsWorkspace
        contactNames={contactNames}
        initialPage={page([ticket()])}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  fireEvent.click(screen.getByRole("tab", { name: "All" }));

  await waitFor(() => {
    expect(screen.getByRole("alert").textContent).toContain(
      "Tickets could not be loaded.",
    );
  });
});

it("renders the Hebrew register right-to-left", () => {
  const { container } = render(
    localized(
      <TicketsWorkspace
        contactNames={contactNames}
        initialPage={page([ticket()])}
        tenantTimeZone="Asia/Jerusalem"
      />,
      "he",
    ),
  );

  expect(container.textContent).toContain("פניות");
  expect(container.textContent).toContain("ממתינה לחיוג");
  // Layout is driven by logical properties, so the same markup lays out in
  // both directions; the copy must genuinely be Hebrew rather than fallback.
  expect(container.textContent).not.toContain("Callback pending");
});

function detail(
  attempt: Partial<TicketDetail["attempts"][number]> = {},
  overrides: Partial<TicketSummary> = {},
): TicketDetail {
  return {
    ticket: ticket(overrides),
    timeline: [
      {
        sequence: 1,
        kind: "opened" as const,
        actorKind: "ai" as const,
        actorUserId: null,
        visibility: "internal" as const,
        summarySafe: "Issue opened from whatsapp.",
        evidence: {},
        occurredAt: "2026-09-18T08:00:00.000Z",
      },
    ],
    attempts: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        attemptNumber: 1,
        sessionId: null,
        outcome: "no_answer" as const,
        assuranceLevel: "channel_associated" as const,
        recordingState: "pending" as const,
        recordingObjectId: null,
        transcriptObjectId: null,
        summaryState: "pending" as const,
        queuedAt: "2026-09-18T08:10:00.000Z",
        startedAt: null,
        endedAt: null,
        postCallStage: "not_started" as const,
        postCallErrorSafe: null,
        recordingDetail: null,
        recordingDurationSeconds: null,
        recordingByteSize: null,
        transcriptState: "pending" as const,
        transcriptDetail: null,
        transcriptTurnCount: null,
        analysis: null,
        analysisModel: null,
        followupState: "not_required" as const,
        followupSentAt: null,
        ...attempt,
      },
    ],
  };
}

const session = "55555555-5555-4555-8555-555555555555";

it("puts the manager's next action and assignee in the ticket overview", () => {
  const ownerId = "66666666-6666-4666-8666-666666666666";
  render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail(
          {},
          {
            ownerUserId: ownerId,
            nextAction: "Call the customer back",
            nextActionDueAt: "2026-09-19T09:00:00.000Z",
          },
        )}
        ownerName="Fictional manager"
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  const overview = screen.getByRole("region", { name: "At a glance" });
  expect(overview.textContent).toContain("Call the customer back");
  expect(overview.textContent).toContain("Fictional manager");
  expect(overview.textContent).toContain("Due");
  expect(overview.textContent).not.toContain(ownerId);
});

it("never offers playback for a recording that is not verified ready", () => {
  render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail()}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  expect(screen.queryByRole("link", { name: "Play recording" })).toBeNull();
  expect(screen.getByText("Recording processing")).toBeTruthy();
  expect(screen.getByText("No answer")).toBeTruthy();
});

it("offers playback only through the authenticated boundary once verified", () => {
  render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail({
          sessionId: session,
          recordingState: "ready",
          recordingObjectId: "44444444-4444-4444-8444-444444444444",
        })}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  const link = screen.getByRole("link", { name: "Play recording" });
  expect(link.getAttribute("href")).toBe(
    `/api/voice/sessions/${session}/recording`,
  );
  // A bucket URL would leak the object store; playback stays same-origin.
  expect(link.getAttribute("href")?.startsWith("/api/")).toBe(true);
});

it("withholds playback when a verified object has no session to stream from", () => {
  render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail({
          sessionId: null,
          recordingState: "ready",
          recordingObjectId: "44444444-4444-4444-8444-444444444444",
        })}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  // The playback route is keyed by session: a control without one would 404,
  // which is the "a stored object implies a playable file" claim in a new shape.
  expect(screen.queryByRole("link", { name: "Play recording" })).toBeNull();
});

it("calls a partial recording partial rather than a complete call", () => {
  render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail({
          sessionId: session,
          outcome: "disconnected",
          recordingState: "partial",
          recordingObjectId: "44444444-4444-4444-8444-444444444444",
          recordingDurationSeconds: 0.4,
        })}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  expect(screen.getByText("Partial recording")).toBeTruthy();
  expect(screen.queryByText("Recording ready")).toBeNull();
});

it("separates what was attempted from what a receipt proves was done", () => {
  const { container } = render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail({
          sessionId: session,
          outcome: "answered",
          summaryState: "ready",
          transcriptState: "valid",
          transcriptTurnCount: 12,
          postCallStage: "complete",
          analysis: {
            schemaVersion: "1.0",
            issue: "Internet drops every evening.",
            customerFacts: [
              {
                statement: "The customer said the router was restarted.",
                sources: [{ kind: "transcript_turn", reference: "4" }],
              },
            ],
            priorContext: [],
            actionsAttempted: [
              {
                action: "Agent asked the customer to restart the router.",
                result: "unknown",
                sources: [{ kind: "transcript_turn", reference: "3" }],
              },
            ],
            actionsCompleted: [],
            unresolvedItems: ["Line stability overnight is unconfirmed."],
            commitments: [
              {
                statement: "Agent said a technician would be booked.",
                sources: [{ kind: "transcript_turn", reference: "9" }],
              },
            ],
            nextAction: "Confirm the line overnight.",
            recommendedOwner: "human_support",
            sentiment: null,
            sentimentSources: [],
            resolution: "proposed_fix_awaiting_confirmation",
            resolutionConfirmationSource: "none",
            classificationConfidence: "medium",
            classificationSources: [
              { kind: "transcript_turn", reference: "11" },
            ],
          },
        })}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  expect(container.textContent).toContain(
    "Agent asked the customer to restart the router.",
  );
  expect(container.textContent).toContain(
    "Agent said a technician would be booked.",
  );
  // A promise on a call is a commitment, never a completed action.
  expect(container.textContent).toContain(
    "Only actions with a platform receipt appear here.",
  );
});

it("labels a phone association as channel control, not verified identity", () => {
  const { container } = render(
    localized(
      <TicketDetailView
        contactName="Fictional caller"
        detail={detail()}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );

  expect(screen.getByText("Phone associated with this contact")).toBeTruthy();
  expect(container.textContent).toContain("not verified identity");
  expect(screen.queryByText("Identity verified")).toBeNull();
});

it("labels a red call with the tenant's own words and separates waiting on the customer from a failed delivery", () => {
  render(
    localized(
      <TicketsWorkspace
        contactNames={contactNames}
        emergencyLabel="קריאה אדומה"
        initialPage={page([
          ticket({
            id: "44444444-4444-4444-8444-444444444444",
            reference: "T-RED",
            priority: "urgent",
            emergency: {
              at: "2026-09-18T08:30:00.000Z",
              reason: "Flooding",
              source: "manual",
            },
            inquiry: {
              intakeStatus: "collecting",
              followupStatus: "admitted",
              followupMessageStatus: "delivered",
              followupRequestedAt: null,
              customerRepliedAt: null,
              customerMediaReceivedAt: null,
              followupError: null,
              attention: "awaiting_customer",
            },
          }),
          ticket({
            id: "55555555-5555-4555-8555-555555555555",
            reference: "T-FAILED",
            inquiry: {
              intakeStatus: "collecting",
              followupStatus: "admitted",
              followupMessageStatus: "failed",
              followupRequestedAt: null,
              customerRepliedAt: null,
              customerMediaReceivedAt: null,
              followupError: null,
              attention: "delivery_failed",
            },
            pendingReplyLinks: 1,
          }),
        ])}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );
  expect(screen.getAllByText("קריאה אדומה").length).toBeGreaterThan(0);
  expect(screen.getByText("Awaiting customer details/photo")).toBeTruthy();
  expect(screen.getByText("WhatsApp delivery failed")).toBeTruthy();
  expect(screen.getByText("1 reply awaits linking")).toBeTruthy();
});

it("shows the phone inquiry, its follow-up state and replies awaiting linking", () => {
  const view = detail(
    {},
    {
      inquiry: {
        intakeStatus: "collecting",
        followupStatus: "blocked_window",
        followupMessageStatus: null,
        followupRequestedAt: null,
        customerRepliedAt: null,
        customerMediaReceivedAt: null,
        followupError: null,
        attention: "blocked",
      },
    },
  );
  render(
    localized(
      <TicketDetailView
        canMarkEmergency
        contactName="Fictional caller"
        detail={view}
        emergencyLabel="Red call"
        inquiry={{
          intakeId: "66666666-6666-4666-8666-666666666666",
          status: "collecting",
          source: "voice",
          fields: { faultDescription: "Freezer is warm", urgency: "high" },
          missingFields: ["customerName"],
          followupStatus: "blocked_window",
          followupError: null,
          customerRepliedAt: null,
          customerMediaReceivedAt: null,
          messages: [],
          repliesToLink: [
            {
              messageId: "77777777-7777-4777-8777-777777777777",
              contentType: "text",
              text: "Here is the photo",
              at: "2026-09-18T10:00:00.000Z",
              candidates: [
                {
                  intakeId: "66666666-6666-4666-8666-666666666666",
                  reference: "T-A",
                },
                {
                  intakeId: "88888888-8888-4888-8888-888888888888",
                  reference: "T-B",
                },
              ],
            },
          ],
        }}
        tenantTimeZone="Asia/Jerusalem"
      />,
    ),
  );
  expect(screen.getByText("Freezer is warm")).toBeTruthy();
  expect(screen.getByText("Phone call")).toBeTruthy();
  expect(screen.getByText("WhatsApp follow-up not sent")).toBeTruthy();
  expect(screen.getByText("Link to T-A")).toBeTruthy();
  expect(screen.getByText("Link to T-B")).toBeTruthy();
  expect(screen.getByText("Mark as Red call")).toBeTruthy();
});
