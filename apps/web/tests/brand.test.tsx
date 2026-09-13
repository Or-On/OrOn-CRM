import { describe, expect, it } from "vitest";
import { BrandLockup, BrandMark, EntryStory } from "../src/features/brand";
import en from "../src/i18n/messages/en.json";
import { renderMarkup } from "./localized";

describe("Or-On product brand", () => {
  it("renders the canonical local logo asset", () => {
    const mark = renderMarkup(<BrandMark />);
    expect(mark).toContain("product-logo");
    expect(mark).toContain("/brand/logo.webp");
    expect(mark).toContain('aria-hidden="true"');
    expect(mark).toContain("<img");
    expect(mark).not.toContain("http");
  });
  it("keeps the canonical product name and accepts a localized descriptor", () => {
    const markup = renderMarkup(
      <BrandLockup descriptor="Customer operations" />,
    );
    expect(markup).toContain("Or-On Platform");
    expect(markup).toContain("Customer operations");
  });
  it("fills the entry panel with the product story and connected channels", () => {
    const markup = renderMarkup(<EntryStory />);
    expect(markup).toContain("entry-story__showcase");
    expect(markup).toContain(en.premiumEntry.statement);
    expect(markup).toContain(en.premiumEntry.messaging);
    expect(markup).toContain(en.premiumEntry.voice);
    expect(markup).toContain(en.premiumEntry.automation);
  });
});
