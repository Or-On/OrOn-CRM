import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ phone: "222", feature: vi.fn(), config: vi.fn() }));
vi.mock("@or-on/config", () => ({ loadConfig: fixture.config }));
vi.mock("@or-on/crm", () => ({ requireTenantFeature: fixture.feature }));
vi.mock("../src/features/auth", () => ({
  withCurrentTenant: async (permission: string, operation: (sql: unknown) => Promise<unknown>) => {
    expect(permission).toBe("messaging:operate");
    return operation(async (sql: TemplateStringsArray) => {
      expect(sql.join("")).toContain("conversation.tenant_id = platform.current_tenant_id()");
      return fixture.phone ? [{ provider_account_id: fixture.phone }] : [];
    });
  },
}));
import { readConversationTemplates } from "../src/features/inbox-templates/server";

beforeEach(() => {
  fixture.phone = "222";
  fixture.feature.mockReset();
  fixture.config.mockReturnValue({
    enableRealWhatsApp: true,
    whatsApp: { phoneNumberId: "111", wabaId: "1111", graphApiVersion: "v22.0" },
    secrets: { whatsappAccessToken: "fictional-primary-token" },
    whatsAppAdditionalAccounts: [{ phoneNumberId: "222", wabaId: "2222", graphApiVersion: "v22.0", accessToken: "fictional-second-token" }],
  });
});
afterEach(() => vi.unstubAllGlobals());

it("fetches only the WABA of the authorized conversation and returns no credentials", async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ name: "hello", language: "he", status: "APPROVED", components: [{ type: "BODY", text: "שלום" }] }] }) }));
  vi.stubGlobal("fetch", fetcher);
  const result = await readConversationTemplates("11111111-1111-4111-8111-111111111111");
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/2222/message_templates?"), expect.objectContaining({ headers: { authorization: "Bearer fictional-second-token" }, cache: "no-store" }));
  expect(fixture.feature).toHaveBeenCalledWith(expect.any(Function), "whatsapp");
  expect(JSON.stringify(result)).not.toContain("token");
  expect(result.templates[0]?.name).toBe("hello");
});

it.each(["unknown", ""])("does not fall back to the primary account when binding is %s", async (phone) => {
  fixture.phone = phone;
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(readConversationTemplates("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/unavailable/u);
  expect(fetcher).not.toHaveBeenCalled();
});

it("refuses feature-disabled access before contacting the provider", async () => {
  fixture.feature.mockRejectedValueOnce(new Error("disabled"));
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(readConversationTemplates("11111111-1111-4111-8111-111111111111")).rejects.toThrow("disabled");
  expect(fetcher).not.toHaveBeenCalled();
});
