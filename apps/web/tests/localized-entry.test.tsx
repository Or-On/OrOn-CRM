import { beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({
  session: vi.fn(),
  redirect: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  redirect: runtime.redirect,
}));
vi.mock("../src/features/auth", () => ({
  currentPublicSession: runtime.session,
}));
import EnglishEntryPage, {
  metadata as englishMetadata,
} from "../src/app/en/page";
import HebrewEntryPage, {
  metadata as hebrewMetadata,
} from "../src/app/he/page";

describe("localized application entry", () => {
  beforeEach(() => {
    runtime.session.mockReset().mockResolvedValue(undefined);
    runtime.redirect.mockReset().mockImplementation((path: string) => {
      throw new Error(`REDIRECT:${path}`);
    });
  });

  it("defines only explicit English and Hebrew compatibility routes", () => {
    expect(EnglishEntryPage).toBe(HebrewEntryPage);
    expect(englishMetadata).toEqual({
      robots: { index: false, follow: false },
    });
    expect(hebrewMetadata).toBe(englishMetadata);
  });

  it.each([
    ["en", EnglishEntryPage],
    ["he", HebrewEntryPage],
  ])("sends an unauthenticated %s entry directly to login", async (_, page) => {
    await expect(page()).rejects.toThrow("REDIRECT:/login");
    expect(runtime.session).toHaveBeenCalledOnce();
  });

  it.each([
    ["en", EnglishEntryPage],
    ["he", HebrewEntryPage],
  ])(
    "sends an authenticated %s entry directly to the dashboard",
    async (_, page) => {
      runtime.session.mockResolvedValue({
        user: { email: "member@example.invalid" },
      });
      await expect(page()).rejects.toThrow("REDIRECT:/");
    },
  );
});
