// @vitest-environment jsdom
import "./dialog-test-support";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfileSummary } from "@or-on/crm";

import {
  AgentRegister,
  businessSoftwarePreset,
  emptyLeadConfiguration,
  leadRequestFields,
} from "../src/features/orchestration";
import { localized } from "./localized";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.cookie = "or_on_csrf=; Max-Age=0";
});

const v2 = "22222222-2222-4222-8222-222222222222";

function coordinator(
  overrides: Partial<AgentProfileSummary> = {},
): AgentProfileSummary {
  return {
    id: "coordinator",
    name: "Fictional lead coordinator",
    description: null,
    version: 2,
    versionId: v2,
    channels: ["voice", "whatsapp"],
    published: true,
    validationStatus: "valid",
    systemPrompt: "Save confirmed information using enabled lead actions.",
    locale: "he-IL",
    capabilities: ["lead.follow_up", "lead.read", "lead.write"],
    roleTitle: "the lead coordinator",
    leadFieldSchemaId: "schema-1",
    publishedVersion: 2,
    publishedVersionId: v2,
    publishedChannels: ["voice", "whatsapp"],
    leadFieldSchema: {
      id: "schema-1",
      name: "Business software enquiry",
      version: 1,
    },
    implicitTicketing: false,
    review: {
      enabledActions: [
        {
          name: "lead_read_state",
          capability: "lead.read",
          description: "Read what has already been collected.",
          mutating: false,
        },
        {
          name: "lead_save_fields",
          capability: "lead.write",
          description: "Save information the customer actually gave.",
          mutating: true,
        },
      ],
      leadFields: [
        {
          key: "preferred_name",
          label: "Preferred name",
          type: "text",
          required: true,
        },
        { key: "budget", label: "Budget", type: "currency", required: false },
      ],
      blocking: [],
      promptWarnings: ["booking"],
    },
    lifecycle: {
      draftVersion: null,
      assignedConversations: 3,
      staleConversations: 2,
      assignedFlows: 1,
      runningCalls: 1,
    },
    ...overrides,
  };
}

const survey: AgentProfileSummary = coordinator({
  id: "survey",
  name: "Fictional product survey",
  capabilities: [],
  roleTitle: null,
  leadFieldSchemaId: null,
  leadFieldSchema: null,
  review: {
    enabledActions: [],
    leadFields: [],
    blocking: [],
    promptWarnings: [],
  },
  lifecycle: {
    draftVersion: 3,
    assignedConversations: 0,
    staleConversations: 0,
    assignedFlows: 0,
    runningCalls: 0,
  },
});

describe("agent capabilities on the publish screen", () => {
  it("separates draft, published, assigned and running, and rebinds only when asked", () => {
    const rebind = vi.fn().mockResolvedValue(true);
    render(
      localized(
        <AgentRegister
          agents={[coordinator()]}
          canEdit
          pending={false}
          publish={vi.fn()}
          rebind={rebind}
        />,
      ),
    );
    const lifecycle = screen.getByRole("region", { name: "Lifecycle" });
    expect(within(lifecycle).getByText("Published v2")).toBeTruthy();
    expect(
      within(lifecycle).getByText("Assigned: 3 AI conversations · 1 flows"),
    ).toBeTruthy();
    expect(within(lifecycle).getByText("Running now: 1 calls")).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
    fireEvent.click(
      within(lifecycle).getByRole("button", { name: "Rebind to v2" }),
    );
    expect(rebind).toHaveBeenCalledWith("coordinator", v2);
  });

  it("lists the granted actions and pinned fields, and labels prompt warnings as hints", () => {
    render(
      localized(
        <AgentRegister
          agents={[coordinator()]}
          canEdit
          pending={false}
          publish={vi.fn()}
        />,
      ),
    );
    const review = screen.getByRole("region", {
      name: "What this version can do",
    });
    expect(within(review).getByText("lead_save_fields")).toBeTruthy();
    expect(within(review).getByText("budget")).toBeTruthy();
    expect(
      within(review).getByText(/No enabled action can book anything/u),
    ).toBeTruthy();
    expect(
      within(review).getByText(/hints from reading the prompt, not a proof/u),
    ).toBeTruthy();
  });

  it("says plainly when an agent has no business actions at all", () => {
    render(
      localized(
        <AgentRegister
          agents={[survey]}
          canEdit
          pending={false}
          publish={vi.fn()}
        />,
      ),
    );
    expect(
      screen.getByText(/converses only; it cannot save, book or send/u),
    ).toBeTruthy();
    expect(screen.getByText("Draft v3 (not running)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Rebind/u })).toBeNull();
  });

  it("renders the Hebrew review with the same facts", () => {
    render(
      localized(
        <AgentRegister
          agents={[coordinator()]}
          canEdit
          pending={false}
          publish={vi.fn()}
        />,
        "he",
      ),
    );
    expect(
      screen.getByRole("region", { name: "מה הגרסה הזו יכולה לעשות" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "שיוך מחדש ל-v2" })).toBeTruthy();
  });

  it("revises into a new draft carrying the version the operator reviewed", async () => {
    const revise = vi.fn().mockResolvedValue(true);
    render(
      localized(
        <AgentRegister
          agents={[coordinator()]}
          canEdit
          pending={false}
          publish={vi.fn()}
          revise={revise}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit as new draft" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Edit as a new draft",
    });
    fireEvent.change(within(dialog).getByLabelText("Agent instructions"), {
      target: { value: "Revised fictional coordinator instructions." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(revise).toHaveBeenCalled();
    });
    expect(revise.mock.calls[0]?.[0]).toBe("coordinator");
    expect(revise.mock.calls[0]?.[1]).toMatchObject({
      systemPrompt: "Revised fictional coordinator instructions.",
      baseVersionId: v2,
      // Reading is implied by the others; the operator's grants are resent as-is.
      capabilities: ["lead.follow_up", "lead.write"],
      leadFieldSchemaId: "schema-1",
      roleTitle: "the lead coordinator",
    });
  });
});

describe("granting lead capabilities", () => {
  it("grants nothing and publishes no field list when no box is ticked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await leadRequestFields(emptyLeadConfiguration())).toEqual({
      capabilities: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes a newly defined field list before pinning the agent to it", async () => {
    document.cookie = "or_on_csrf=fixture";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "new-schema" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const fields = await leadRequestFields(
      emptyLeadConfiguration({
        capabilities: ["lead.write"],
        schemaName: "Business software enquiry",
        fields: businessSoftwarePreset,
      }),
    );
    expect(fields).toEqual({
      capabilities: ["lead.write"],
      leadFieldSchemaId: "new-schema",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/leads/schemas");
    const body = JSON.parse(init.body) as {
      fields: { key: string; choices?: string[] }[];
    };
    expect(body.fields.map((field) => field.key)).toContain(
      "follow_up_channel",
    );
    expect(
      body.fields.find((field) => field.key === "follow_up_channel")?.choices,
    ).toEqual(["Phone call", "WhatsApp", "Email"]);
    // A lead coordinator uses the interaction's own contact details.
    expect(body.fields.map((field) => field.key)).not.toContain("phone");
  });
});
