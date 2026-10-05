import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  save: vi.fn(),
  get: vi.fn(),
  channel: vi.fn(),
  mutation: vi.fn(),
  tenant: "tenant-a",
  user: "user-a",
  session: "session-a",
  binding: "channel-a",
  afterCatalog: (): void => undefined,
}));
vi.mock("@or-on/crm", () => ({
  saveWhatsAppAutoGreeting: state.save,
  getWhatsAppAutoGreeting: state.get,
  whatsAppConversationChannel: state.channel,
  parseWhatsAppAutoGreetingInput: (value: unknown) => value,
}));
vi.mock("@or-on/auth", () => ({ hasPermission: () => true }));
vi.mock("../src/features/auth", () => {
  const authorize = async (
    _permission: string,
    operation: (sql: unknown, session: unknown) => Promise<unknown>,
  ) =>
    operation(
      {},
      {
        userId: state.user,
        sessionId: state.session,
        tenant: { tenantId: state.tenant, role: "owner" },
      },
    );
  return {
    withCurrentTenant: authorize,
    withFreshCurrentTenant: authorize,
    jsonObject: (request: Request) => request.json(),
  };
});
vi.mock("../src/features/crm-route", () => ({
  assertCrmMutation: state.mutation,
  crmErrorResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "unavailable" },
      { status: 403 },
    ),
}));
vi.mock("../src/features/inbox-templates-server", () => ({
  templateAccount: () =>
    Promise.resolve({
      tenantId: state.tenant,
      channelId: state.binding,
    }),
  listAllConversationTemplates: async (resolve: () => Promise<unknown>) => {
    await resolve();
    await resolve();
    state.afterCatalog();
    return [
      {
        name: "approved",
        status: "APPROVED",
        language: "he",
        draft: { parameterCount: 0 },
      },
    ];
  },
}));
import {
  GET,
  PUT,
} from "../src/app/api/messaging/conversations/[id]/auto-greeting/route";

const context = { params: Promise.resolve({ id: "conversation-a" }) };
const request = () =>
  new Request(
    "https://example.invalid/api/messaging/conversations/conversation-a/auto-greeting",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        templateName: "approved",
        fallbackLanguage: "he",
      }),
    },
  );
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    tenant: "tenant-a",
    user: "user-a",
    session: "session-a",
    binding: "channel-a",
    afterCatalog: (): void => undefined,
  });
  state.channel.mockResolvedValue("channel-a");
  state.save.mockResolvedValue({ enabled: true });
  state.get.mockResolvedValue(null);
});
describe("automatic greeting catalog-to-save authorization", () => {
  it("saves the approved catalog projection under the same principal and account", async () => {
    expect((await PUT(request(), context)).status).toBe(200);
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.save).toHaveBeenCalledWith({}, "user-a", "channel-a", {
      enabled: true,
      templateName: "approved",
      languages: ["he"],
      fallbackLanguage: "he",
    });
  });
  it.each(["tenant", "user", "session", "binding"] as const)(
    "rejects a changed %s after the provider read before saving",
    async (key) => {
      state.afterCatalog = () => {
        state[key] = "changed";
      };
      expect((await PUT(request(), context)).status).toBe(403);
      expect(state.save).not.toHaveBeenCalled();
    },
  );
  it("does not expose greeting settings when the tenant policy denies the helper", async () => {
    state.get.mockRejectedValue(
      Object.assign(new Error("WhatsApp templates are unavailable"), {
        code: "42501",
      }),
    );
    expect(
      (await GET(new Request("https://example.invalid"), context)).status,
    ).toBe(403);
  });
});
