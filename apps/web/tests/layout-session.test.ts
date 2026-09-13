import { beforeEach, describe, expect, it, vi } from "vitest";
const { currentPublicSession } = vi.hoisted(() => ({
  currentPublicSession: vi.fn(),
}));
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-latin" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
  Heebo: () => ({ variable: "font-hebrew" }),
}));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
  getTranslations: vi.fn(),
}));
vi.mock("../src/features/auth", () => ({ currentPublicSession }));
import RootLayout from "../src/app/layout";

describe("application layout session resolution", () => {
  beforeEach(() => {
    currentPublicSession.mockReset();
  });
  it("resolves session state for the application entry", async () => {
    currentPublicSession.mockResolvedValue(undefined);
    await RootLayout({ children: null });
    expect(currentPublicSession).toHaveBeenCalledOnce();
  });
});
