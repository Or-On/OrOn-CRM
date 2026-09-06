// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BrandLockup, BrandMark, SignalBackdrop } from "../src/features/brand";
import { MarketingPage } from "../src/features/marketing";
import { localized, renderMarkup } from "./localized";

vi.mock("next/navigation", () => ({
  usePathname: () => "/en",
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next-themes", () => ({
  useTheme: () => ({ setTheme: vi.fn(), theme: "dark" }),
}));

describe("Or-On code-native brand", () => {
  it("renders an intrinsic SVG mark and decorative signal path without remote assets", () => {
    const mark = renderMarkup(<BrandMark />);
    const backdrop = renderMarkup(<SignalBackdrop />);

    expect(mark).toContain("signal-mark__trace");
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).not.toContain("<img");
    expect(mark).not.toContain("http");
    expect(backdrop).toContain("signal-backdrop__waypoints");
    expect(backdrop).toContain('aria-hidden="true"');
  });

  it("keeps the canonical product name and accepts a localized descriptor", () => {
    const markup = renderMarkup(
      <BrandLockup descriptor="Customer operations" />,
    );

    expect(markup).toContain("Or-On Platform");
    expect(markup).toContain("Customer operations");
  });
});

describe("public marketing experience", () => {
  it.each([
    ["en", "Every customer conversation.", "One controlled next step.", "Menu"],
    ["he", "כל שיחה עם לקוח.", "הצעד הבא, תחת שליטה.", "תפריט"],
  ] as const)(
    "renders the split message, implemented proof and mobile navigation in %s",
    (locale, lead, emphasis, menu) => {
      const markup = renderMarkup(<MarketingPage />, locale);

      expect(markup).toContain(lead);
      expect(markup).toContain(emphasis);
      expect(markup).toContain(menu);
      expect(markup).toContain("public-menu__links");
      expect(markup).toContain("PostgreSQL");
      expect(markup).toContain("signal-backdrop");
    },
  );

  it("uses truthful capability proof instead of copied performance claims", () => {
    const markup = renderMarkup(<MarketingPage />);

    expect(markup).toContain("Signed webhook ingestion");
    expect(markup).toContain("Queued work and duplicate protection");
    expect(markup).not.toContain("490ms");
    expect(markup).not.toContain("99.5%");
    expect(markup).not.toContain("32+");
  });

  it("closes the mobile menu after selection and with Escape", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { container } = render(localized(<MarketingPage />));
    const trigger = screen.getByRole("button", { name: "Menu" });
    const navigation = container.querySelector<HTMLElement>(
      "#public-mobile-navigation",
    );
    if (!navigation)
      throw new Error("Mobile product navigation was not rendered");

    expect(navigation.getAttribute("aria-label")).toBe(
      "Mobile product navigation",
    );
    expect(navigation.hasAttribute("hidden")).toBe(true);
    fireEvent.click(trigger);
    expect(navigation.hasAttribute("hidden")).toBe(false);
    fireEvent.click(
      within(navigation).getByRole("link", { name: "How it works" }),
    );
    expect(navigation.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("workflow"));

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(navigation.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(trigger);
    vi.unstubAllGlobals();
  });
});
