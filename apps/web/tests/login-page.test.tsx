import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";
import { renderMarkup } from "./localized";

const runtime = vi.hoisted(() => ({
  locale: "en",
  session: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: runtime.redirect,
  usePathname: () => "/login",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark", setTheme: vi.fn() }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: "auth" | "meta") =>
    Promise.resolve(
      createTranslator({
        locale: runtime.locale,
        messages: runtime.locale === "he" ? he : en,
        namespace,
      }),
    ),
}));
vi.mock("../src/features/auth", () => ({
  currentPublicSession: runtime.session,
}));

import LoginPage from "../src/app/login/page";

describe("application sign-in entry", () => {
  beforeEach(() => {
    runtime.locale = "en";
    runtime.session.mockReset().mockResolvedValue(undefined);
    runtime.redirect.mockReset().mockImplementation((path: string) => {
      throw new Error(`REDIRECT:${path}`);
    });
  });
  it.each(["en", "he"] as const)(
    "renders labeled credentials and account help in %s",
    async (locale) => {
      runtime.locale = locale;
      const messages = locale === "he" ? he : en;
      const markup = renderMarkup(await LoginPage(), locale);
      expect(markup).toContain(messages.auth.title);
      expect(markup).toContain(messages.auth.email);
      expect(markup).toContain(messages.auth.password);
      expect(markup).toContain(messages.auth.helpText);
      expect(markup).toContain('autoComplete="current-password"');
      expect(markup).toContain("or-surface--raised");
      expect(markup).not.toContain("login-capabilities");
      expect(markup).not.toContain("login-identity");
      expect(markup).not.toContain("login-signal");
      expect(markup).not.toContain('href="/en"');
      expect(markup).not.toContain('href="/he"');
      expect(markup).not.toContain('href="/register"');
    },
  );
  it("sends an existing session directly to the dashboard", async () => {
    runtime.session.mockResolvedValue({
      user: { email: "member@example.invalid" },
    });
    await expect(LoginPage()).rejects.toThrow("REDIRECT:/");
  });
  it("sends a technician session to the Field Service application", async () => {
    runtime.session.mockResolvedValue({
      applicationScope: "field-service",
      user: { email: "technicians@example.invalid" },
    });
    await expect(LoginPage()).rejects.toThrow("REDIRECT:/field-service");
  });
});
