import { createTranslator } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { renderMarkup } from "./localized";
import en from "../src/i18n/messages/en.json";
import he from "../src/i18n/messages/he.json";
import { errorMessage } from "../src/i18n/error-message";
import { sumAmounts, formatAmount } from "../src/features/pipelines";
import { ContactManager } from "../src/features/contacts";
import { OperationsPanel } from "../src/features/operations";
import { VoiceCampaignPanel } from "../src/features/voice";
import { PipelineBoard } from "../src/features/pipelines";
import { ProductHeading } from "../src/i18n/product-heading";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function flattenMessages(
  value: Record<string, unknown>,
  prefix = "",
): readonly (readonly [string, string])[] {
  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (typeof item === "string") return [[path, item] as const];
    if (typeof item === "object" && item !== null)
      return flattenMessages(item as Record<string, unknown>, path);
    throw new Error(`Unsupported message value at ${path}`);
  });
}

describe("English and Hebrew interface contracts", () => {
  it("has identical semantic keys and compatible ICU arguments", () => {
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    const english = new Map(flattenMessages(en));
    const hebrew = new Map(flattenMessages(he));
    expect([...hebrew.keys()].sort()).toEqual([...english.keys()].sort());
    const args = (text: string) =>
      [
        ...new Set(
          [...text.matchAll(/\{([A-Za-z]\w*)\s*[,}]/gu)].map(
            (match) => match[1],
          ),
        ),
      ].sort();
    for (const [key, value] of english) {
      expect(args(hebrew.get(key) ?? ""), key).toEqual(args(value));
    }
  });
  it.each(["en", "he"] as const)(
    "renders every message and ICU pattern in %s",
    (locale) => {
      const messages = locale === "he" ? he : en;
      const t = createTranslator({
        locale,
        messages,
        onError: (error) => {
          throw error;
        },
      });
      for (const [key, value] of flattenMessages(messages)) {
        const args: Record<string, string | number> = {};
        for (const match of value.matchAll(/\{([A-Za-z]\w*)\s*([,}])/gu)) {
          const name = match[1] ?? "";
          args[name] = new RegExp("\\{" + name + ",\\s*(number|plural)").test(
            value,
          )
            ? 2
            : "fixture";
        }
        expect(t(key as Parameters<typeof t>[0], args)).not.toContain(
          "MISSING_MESSAGE",
        );
      }
    },
  );
  it("renders meaningful Hebrew empty states across product modules", () => {
    expect(renderMarkup(<ContactManager contacts={[]} />, "he")).toContain(
      "אין עדיין אנשי קשר",
    );
    expect(renderMarkup(<PipelineBoard boards={[]} />, "he")).toContain(
      "לא הוגדר משפך מכירות",
    );
    expect(
      renderMarkup(
        <OperationsPanel
          automations={[]}
          broadcasts={[]}
          runs={[]}
          simulationAvailable
        />,
        "he",
      ),
    ).toContain(he.operations.emptyCampaignsTitle);
    expect(
      renderMarkup(<VoiceCampaignPanel flows={[]} campaigns={[]} />, "he"),
    ).toContain("אין עדיין קמפיינים קוליים");
    for (const page of [
      "contacts",
      "contact",
      "inbox",
      "flows",
      "operations",
      "orchestration",
      "pipelines",
      "settings",
      "voice",
      "call",
      "voiceCampaigns",
      "health",
    ]) {
      const heading = renderMarkup(<ProductHeading page={page} />, "he");
      expect(heading).toContain("<h1>");
      expect(heading).toContain('class="or-page-header page-heading"');
    }
  });
  it("localizes contact eligibility/window errors without exposing consent or backend details", () => {
    const translate = createTranslator({ locale: "he", messages: he });
    const t = (key: string) =>
      translate(key as Parameters<typeof translate>[0]);
    expect(
      errorMessage(
        new Error("WhatsApp consent is required"),
        t,
        "common.changeFailed",
      ),
    ).toBe(he.tenantPrimary.notEligible);
    expect(
      errorMessage(
        new Error("24-hour window closed"),
        t,
        "common.changeFailed",
      ),
    ).toContain("חלון השירות סגור");
    const output = errorMessage(
      new Error("secret=fictional-only private body"),
      t,
      "common.changeFailed",
    );
    expect(output).toBe(he.common.changeFailed);
    expect(output).not.toContain("secret");
  });
});

describe("currency-safe pipeline presentation", () => {
  it("sums decimal strings exactly, including values beyond safe integer precision", () => {
    expect(sumAmounts(["9007199254740993.01", "0.02"])).toBe(
      "9007199254740993.03",
    );
    expect(sumAmounts(["0.1", "0.20", "-0.03"])).toBe("0.27");
    expect(sumAmounts([])).toBe("0");
    expect(() => sumAmounts(["NaN"])).toThrow();
    expect(formatAmount("9007199254740993.03", "USD", "en")).toContain(
      "9,007,199,254,740,993.03",
    );
    expect(formatAmount("12.50", "ILS", "he")).toContain("12.50");
  });
});
