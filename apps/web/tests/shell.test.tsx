import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import FoundationPage from "../src/app/page";
import { directionForLocale } from "../src/i18n/direction";

describe("unified web shell", () => {
  it("renders the foundation content without claiming feature parity", () => {
    const markup = renderToStaticMarkup(createElement(FoundationPage));
    expect(markup).toContain("One platform. Proven engines.");
    expect(markup).toContain("Foundation active");
  });

  it("provides an explicit Hebrew RTL direction strategy", () => {
    expect(directionForLocale("he")).toBe("rtl");
    expect(directionForLocale("en")).toBe("ltr");
  });
});
