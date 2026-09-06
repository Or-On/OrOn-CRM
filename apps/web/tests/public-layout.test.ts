import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentPublicSession, requestHeaders } = vi.hoisted(() => ({
  currentPublicSession: vi.fn(),
  requestHeaders: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: requestHeaders }));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn().mockResolvedValue("en"),
  getTranslations: vi.fn(),
}));
vi.mock("../src/features/auth", () => ({ currentPublicSession }));

import RootLayout from "../src/app/layout";

describe("root layout public-route session isolation", () => {
  beforeEach(() => {
    currentPublicSession.mockReset();
    requestHeaders.mockReset();
  });

  it("does not resolve a database-backed session for a trusted public marker", async () => {
    requestHeaders.mockResolvedValue(
      new Headers({ "x-or-on-public-route": "localized-root" }),
    );

    await RootLayout({ children: null });

    expect(currentPublicSession).not.toHaveBeenCalled();
  });

  it.each([undefined, "application", "true"])(
    "resolves the session for a non-public marker value %s",
    async (marker) => {
      requestHeaders.mockResolvedValue(
        new Headers(
          marker === undefined ? undefined : { "x-or-on-public-route": marker },
        ),
      );
      currentPublicSession.mockResolvedValue(undefined);

      await RootLayout({ children: null });

      expect(currentPublicSession).toHaveBeenCalledOnce();
    },
  );
});
