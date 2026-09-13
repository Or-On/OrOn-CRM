// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { whatsAppFailureReasons } from "@or-on/crm";
import { localized, renderMarkup } from "./localized";
import { DeliveryFailure } from "../src/features/inbox";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";

afterEach(cleanup);
const diagnostic = {
  version: 1 as const,
  httpStatus: 400,
  metaCode: 100,
  metaSubcode: 33,
  reason: "resource_access" as const,
  retryable: false,
};

describe("WhatsApp safe diagnostic display", () => {
  it("shows recorded codes and a keyboard-native disclosure without resend controls", () => {
    render(
      localized(<DeliveryFailure failure={{ code: "meta_100", diagnostic }} />),
    );
    expect(screen.getByText(/unavailable or inaccessible/)).toBeTruthy();
    const summary = screen.getByText(en.deliveryFailure.details);
    fireEvent.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(screen.getByText("meta_100")).toBeTruthy();
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByText("33")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
  it("explains missing historical details without inventing a cause", () => {
    const markup = renderMarkup(
      <DeliveryFailure failure={{ code: "meta_100", diagnostic: null }} />,
    );
    expect(markup).toContain("cannot be reconstructed");
    expect(markup).toContain("meta_100");
    expect(markup).not.toContain("insufficient permission");
  });
  it.each(["en", "he"] as const)(
    "renders every safe reason in %s",
    (locale) => {
      for (const reason of whatsAppFailureReasons) {
        const markup = renderMarkup(
          <DeliveryFailure
            failure={{
              code: "meta_100",
              diagnostic: { ...diagnostic, reason },
            }}
          />,
          locale,
        );
        expect(markup).toContain(
          (locale === "he" ? he : en).deliveryFailure.details,
        );
        expect(markup).not.toContain("MISSING_MESSAGE");
        expect(markup).toContain("<bdi>meta_100</bdi>");
      }
    },
  );
});
