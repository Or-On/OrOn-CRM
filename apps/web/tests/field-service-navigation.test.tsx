// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  FieldServiceNavigation,
  fieldServiceSectionDestinations,
} from "../src/features/field-service";
import { localized } from "./localized";

describe("field-service section navigation", () => {
  afterEach(cleanup);

  it("exposes real overview, report and OCR destinations with one current page", () => {
    render(localized(<FieldServiceNavigation active="reports" />));
    const navigation = screen.getByRole("navigation", {
      name: "Field service sections",
    });
    const overview = screen.getByRole("link", { name: "Overview" });
    const reports = screen.getByRole("link", { name: "Reports" });
    const ocr = screen.getByRole("link", { name: "OCR" });

    expect(navigation.contains(overview)).toBe(true);
    expect(overview.getAttribute("href")).toBe(
      fieldServiceSectionDestinations.overview,
    );
    expect(reports.getAttribute("href")).toBe(
      fieldServiceSectionDestinations.reports,
    );
    expect(ocr.getAttribute("href")).toBe(fieldServiceSectionDestinations.ocr);
    expect(reports.getAttribute("aria-current")).toBe("page");
    expect(overview.hasAttribute("aria-current")).toBe(false);
  });

  it("uses concise Hebrew labels and logical-direction layout", () => {
    render(localized(<FieldServiceNavigation active="ocr" />, "he"));
    expect(
      screen.getByRole("navigation", { name: "ניווט שירות שטח" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "סקירה" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "דוחות" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "OCR" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
