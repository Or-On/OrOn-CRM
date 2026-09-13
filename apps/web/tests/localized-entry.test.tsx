import { beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({
  session: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: runtime.notFound,
  redirect: runtime.redirect,
}));
vi.mock("../src/features/auth", () => ({
  currentPublicSession: runtime.session,
}));
import LocalizedEntryPage, { generateMetadata } from "../src/app/[locale]/page";

describe("localized application entry", () => {
  beforeEach(() => {
    runtime.session.mockReset().mockResolvedValue(undefined);
    runtime.notFound.mockReset().mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    runtime.redirect.mockReset().mockImplementation((path: string) => {
      throw new Error(`REDIRECT:${path}`);
    });
  });
  it.each(["en", "he"])(
    "sends an unauthenticated %s entry directly to login",
    async (locale) => {
      await expect(
        LocalizedEntryPage({ params: Promise.resolve({ locale }) }),
      ).rejects.toThrow("REDIRECT:/login");
      expect(runtime.session).toHaveBeenCalledOnce();
    },
  );
  it.each(["en", "he"])(
    "sends an authenticated %s entry directly to the dashboard",
    async (locale) => {
      runtime.session.mockResolvedValue({
        user: { email: "member@example.invalid" },
      });
      await expect(
        LocalizedEntryPage({ params: Promise.resolve({ locale }) }),
      ).rejects.toThrow("REDIRECT:/");
    },
  );
  it("rejects unsupported locale entries before resolving a session", async () => {
    await expect(
      LocalizedEntryPage({ params: Promise.resolve({ locale: "fr" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(runtime.session).not.toHaveBeenCalled();
    await expect(
      generateMetadata({ params: Promise.resolve({ locale: "fr" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it.each(["en", "he"])(
    "keeps the %s redirect out of search indexes",
    async (locale) => {
      expect(
        await generateMetadata({ params: Promise.resolve({ locale }) }),
      ).toEqual({ robots: { index: false, follow: false } });
    },
  );
});
