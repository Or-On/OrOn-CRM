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

describe("English and Hebrew interface contracts", () => {
  it("has identical semantic keys and compatible ICU arguments", () => {
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    const english = Object.entries(en);
    for (const [namespace, entries] of english) {
      const hebrewEntries = Object.entries(he).find(
        ([key]) => key === namespace,
      )?.[1];
      expect(Object.keys(hebrewEntries ?? {}).sort()).toEqual(
        Object.keys(entries).sort(),
      );
      for (const [key, value] of Object.entries(entries)) {
        const hebrewValue =
          Object.entries(hebrewEntries ?? {}).find(
            ([name]) => name === key,
          )?.[1] ?? "";
        const args = (text: string) =>
          [
            ...new Set(
              [...text.matchAll(/\{([A-Za-z]\w*)\s*[,}]/gu)].map(
                (match) => match[1],
              ),
            ),
          ].sort();
        expect(args(hebrewValue), `${namespace}.${key}`).toEqual(args(value));
      }
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
      for (const [namespace, entries] of Object.entries(messages)) {
        for (const [key, value] of Object.entries(entries)) {
          const args: Record<string, string | number> = {};
          for (const match of value.matchAll(/\{([A-Za-z]\w*)\s*([,}])/gu)) {
            const name = match[1] ?? "";
            args[name] = new RegExp("\\{" + name + ",\\s*(number|plural)").test(
              value,
            )
              ? 2
              : "fixture";
          }
          expect(
            t(`${namespace}.${key}` as Parameters<typeof t>[0], args),
          ).not.toContain("MISSING_MESSAGE");
        }
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
        <OperationsPanel automations={[]} broadcasts={[]} runs={[]} />,
        "he",
      ),
    ).toContain("טיוטות אוטומציה");
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
      expect(renderMarkup(<ProductHeading page={page} />, "he")).toContain(
        "<h1>",
      );
    }
  });
  it("localizes consent/window errors without exposing arbitrary backend details", () => {
    const translate = createTranslator({ locale: "he", messages: he });
    const t = (key: string) =>
      translate(key as Parameters<typeof translate>[0]);
    expect(
      errorMessage(
        new Error("WhatsApp consent is required"),
        t,
        "common.changeFailed",
      ),
    ).toContain("נדרשת הסכמה");
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
