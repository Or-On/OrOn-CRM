import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "../src/i18n/messages/en.json";
import { renderMarkup } from "./localized";

const runtime = vi.hoisted(() => ({
  inspectInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/invite",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: vi.fn(), theme: "dark" }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "invitation" | "status") =>
    Promise.resolve(
      createTranslator({ locale: "en", messages: en, namespace }),
    ),
}));
vi.mock("../src/features/auth", () => ({
  withAuthService: (
    operation: (service: {
      inspectInvitation: typeof runtime.inspectInvitation;
    }) => Promise<unknown>,
  ) => operation({ inspectInvitation: runtime.inspectInvitation }),
}));

import InvitationPage from "../src/app/invite/page";

describe("invitation access entry", () => {
  beforeEach(() => {
    runtime.inspectInvitation.mockReset();
  });

  it("keeps an unavailable invitation inside the shared access composition", async () => {
    runtime.inspectInvitation.mockResolvedValue(undefined);
    const markup = renderMarkup(
      await InvitationPage({ searchParams: Promise.resolve({ token: "bad" }) }),
      "en",
    );
    expect(markup).toContain("invite-header");
    expect(markup).toContain("invite-body");
    expect(markup).toContain("or-surface--raised");
    expect(markup).toContain(en.invitation.unavailable);
    expect(markup).toContain('href="/login"');
  });

  it("renders a valid invitation with account fields and preference controls", async () => {
    runtime.inspectInvitation.mockResolvedValue({
      email: "member@example.test",
      existingAccount: false,
      role: "agent",
      tenantName: "Northwind",
    });
    const markup = renderMarkup(
      await InvitationPage({
        searchParams: Promise.resolve({ token: "valid" }),
      }),
      "en",
    );
    expect(markup).toContain("Northwind");
    expect(markup).toContain("member@example.test");
    expect(markup).toContain('id="invitation-display-name"');
    expect(markup).toContain('id="invitation-password"');
    expect(markup).toContain('value="en"');
    expect(markup).toContain('value="dark"');
  });
});
