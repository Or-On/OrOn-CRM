import { localized } from "./localized";
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  LeadCounts,
  LeadDetail,
  LeadListEntry,
  LeadPage,
} from "@or-on/crm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: navigation.replace,
    refresh: navigation.refresh,
  }),
  usePathname: () => "/leads",
  useSearchParams: () => navigation.search,
}));

import { LeadDetailView, LeadsWorkspace } from "../src/features/leads";

const leadId = "55555555-5555-4555-8555-555555555555";
const contactId = "66666666-6666-4666-8666-666666666666";

const lead: LeadListEntry = {
  id: leadId,
  reference: "LD-ABCD1234",
  status: "collecting",
  contactId,
  contactName: "רוני בדיוני",
  ownerUserId: null,
  ownerName: null,
  sourceChannel: "whatsapp",
  businessObjective: "Business software evaluation",
  interestKey: "business-software",
  summary: null,
  nextAction: null,
  nextActionDueAt: null,
  agentProfileVersionId: "77777777-7777-4777-8777-777777777777",
  agentName: "Fictional lead coordinator",
  agentVersion: 2,
  fieldSchemaName: "Business software interest",
  fieldSchemaVersion: 1,
  completeness: {
    required: ["preferred_name", "company", "service"],
    satisfied: ["preferred_name"],
    missing: ["company", "service"],
    declined: [],
    complete: false,
  },
  revision: 3,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-02T09:30:00.000Z",
  archivedAt: null,
  convertedDealId: null,
};

const page: LeadPage = { leads: [lead], nextCursor: null };
const counts: LeadCounts = {
  total: 1,
  byStatus: {
    new: 0,
    collecting: 1,
    ready_for_review: 0,
    qualified: 0,
    disqualified: 0,
    converted: 0,
    archived: 0,
  },
};

const detail: LeadDetail = {
  lead,
  contact: {
    id: contactId,
    name: "רוני בדיוני",
    primaryPhone: "+972500000111",
    email: null,
  },
  qualification: {},
  schema: null,
  fields: [
    {
      key: "preferred_name",
      label: "Preferred name",
      type: "text",
      required: true,
      description: null,
      choices: null,
      state: "known",
      rawValue: "רוני",
      normalizedValue: "רוני",
      currency: null,
      confirmation: "customer_confirmed",
      observedAt: "2026-09-02T09:00:00.000Z",
      sourceChannel: "whatsapp",
      sourceReferenceId: "message-1",
      recordedBy: "agent",
    },
    {
      key: "company",
      label: "Company",
      type: "text",
      required: true,
      description: null,
      choices: null,
      state: null,
      rawValue: null,
      normalizedValue: null,
      currency: null,
      confirmation: null,
      observedAt: null,
      sourceChannel: null,
      sourceReferenceId: null,
      recordedBy: null,
    },
  ],
  history: [],
  interaction: {
    conversationId: "88888888-8888-4888-8888-888888888888",
    conversationChannel: "whatsapp",
    sessionId: null,
    handoffId: null,
    sourceMessageId: "message-1",
  },
  calls: [
    {
      sessionId: "99999999-9999-4999-8999-999999999999",
      direction: "outbound",
      status: "completed",
      startedAt: "2026-09-02T09:15:00.000Z",
      endedAt: "2026-09-02T09:20:00.000Z",
      recording: "missing",
      transcript: "available",
    },
  ],
  audit: [],
};

function respond(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function inputValue(label: string): string {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`${label} is not a text field`);
  }
  return field.value;
}

function saveButton(index: number): HTMLElement {
  const button = screen.getAllByRole("button", { name: "Save changes" })[index];
  if (button === undefined) throw new Error("Save changes was not rendered");
  return button;
}

describe("leads register", () => {
  beforeEach(() => {
    navigation.search = new URLSearchParams();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("asks the server for each filter change and never filters in the browser", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => respond({ ...page, counts }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      localized(
        <LeadsWorkspace
          agents={[]}
          initialCounts={counts}
          initialPage={page}
          team={[{ userId: "user-1", name: "Fictional owner" }]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "voice" },
    });
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const url = String(fetchMock.mock.calls.at(-1)?.[0]);
    const query = new URLSearchParams(url.split("?")[1]);
    // The page size travels with every request: no code path asks for the
    // tenant's whole lead history and narrows it on the client.
    expect(query.get("limit")).toBe("25");
    expect(query.get("channel")).toBe("voice");
    expect(query.get("status")).toBe("open");
  });

  it("mirrors the filters into the URL so a reload restores the view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => respond({ ...page, counts })),
    );

    render(
      localized(
        <LeadsWorkspace
          agents={[]}
          initialCounts={counts}
          initialPage={page}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Source"), {
      target: { value: "whatsapp" },
    });
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith(
        "/leads?channel=whatsapp",
        { scroll: false },
      );
    });
  });

  it("restores a deep-linked filter instead of resetting to the default", async () => {
    navigation.search = new URLSearchParams("status=qualified&sort=due&q=roni");
    const fetchMock = vi
      .fn()
      .mockImplementation(() => respond({ ...page, counts }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      localized(
        <LeadsWorkspace
          agents={[]}
          initialCounts={counts}
          initialPage={page}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );
    await vi.advanceTimersByTimeAsync(300);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const query = new URLSearchParams(
      String(fetchMock.mock.calls.at(-1)?.[0]).split("?")[1],
    );
    expect(query.get("status")).toBe("qualified");
    expect(query.get("sort")).toBe("due");
    expect(query.get("q")).toBe("roni");
    expect(inputValue("Search reference, objective, contact or phone…")).toBe(
      "roni",
    );
  });

  it("shows capture completeness and agent provenance, not an invented score", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => respond({ ...page, counts })),
    );

    render(
      localized(
        <LeadsWorkspace
          agents={[]}
          initialCounts={counts}
          initialPage={page}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    expect(screen.getByText("1 of 3 required fields")).toBeTruthy();
    expect(screen.getByText("Fictional lead coordinator v2")).toBeTruthy();
    expect(screen.queryByText(/success/iu)).toBeNull();
    expect(screen.queryByText(/%/u)).toBeNull();
  });

  it("renders the Hebrew register with the same server-backed filters", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => respond({ ...page, counts })),
    );

    render(
      localized(
        <LeadsWorkspace
          agents={[]}
          initialCounts={counts}
          initialPage={page}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
        "he",
      ),
    );

    expect(screen.getByRole("heading", { name: "לידים" })).toBeTruthy();
    expect(screen.getByLabelText("מקור")).toBeTruthy();
    expect(screen.getByText("1 מתוך 3 שדות חובה")).toBeTruthy();
  });
});

describe("lead detail", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    cleanup();
  });

  it("states a missing recording as missing rather than offering playback", () => {
    render(
      localized(
        <LeadDetailView
          detail={detail}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    expect(
      screen.getByText(/Recording: Not available · Transcript: Available/u),
    ).toBeTruthy();
  });

  it("lists an unanswered required field rather than hiding it", () => {
    render(
      localized(
        <LeadDetailView
          detail={detail}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    const row = screen.getByRole("row", { name: /Company/u });
    expect(row.textContent).toContain("Required");
    expect(row.textContent).toContain("—");
  });

  it("sends a typed correction with the revision the operator read", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        respond({ receipt: {}, lead: {}, rejected: [] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      localized(
        <LeadDetailView
          detail={detail}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.change(screen.getByLabelText("Company"), {
      target: { value: "Fictional Systems" },
    });
    fireEvent.click(saveButton(0));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(`/api/leads/${leadId}/fields`);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.expectedRevision).toBe(3);
    expect(body.fields).toEqual([
      { key: "company", state: "known", value: "Fictional Systems" },
    ]);
    // The same correction resubmitted carries the same operation key, so a
    // double submit reconciles instead of writing twice.
    expect(body.operationKey).toBe(`lead-operator-${leadId}-3`);
  });

  it("tells the operator to reload when someone else saved first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => respond({ error: "conflict" }, 409)),
    );

    render(
      localized(
        <LeadDetailView
          detail={detail}
          team={[]}
          tenantTimeZone="Asia/Jerusalem"
        />,
      ),
    );

    fireEvent.click(saveButton(1));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "changed this lead while you were editing it",
      );
    });
  });
});
