import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serviceAgentPolicy } from "./agent-scope-policy.generated.js";
import {
  approvedAgentResponse,
  approvedAgentResponses,
  classifyCustomerTurn,
  normalizeScopeText,
  validateAgentOutput,
} from "./agent-scope-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("service agent scope policy", () => {
  it("mirrors the canonical contract exactly", () => {
    const canonical: unknown = JSON.parse(
      readFileSync(
        resolve(root, "db/contracts/service-agent-policy.v1.json"),
        "utf8",
      ),
    );
    expect(serviceAgentPolicy).toEqual(canonical);
  });

  it.each(serviceAgentPolicy.vectors.turns)(
    "routes the customer turn $text",
    (vector) => {
      const decision = classifyCustomerTurn(vector.text);
      expect(decision.route ?? "none").toBe(vector.route);
      expect(decision.mixed).toEqual("mixed" in vector ? vector.mixed : []);
    },
  );

  it.each(serviceAgentPolicy.vectors.outputs)(
    "validates the agent output $text",
    (vector) => {
      expect(validateAgentOutput(vector.text).category).toBe(vector.blocked);
    },
  );

  it("normalizes exactly like the Python runtime", () => {
    expect(normalizeScopeText("אִיזֶה\u200b מוֹדֶל, ג׳מיני?")).toBe(
      " איזה מודל גמיני ",
    );
    expect(normalizeScopeText("  GPT-4o  ")).toBe(" gpt 4o ");
  });

  it("replaces the observed failure with the tenant's approved identity", () => {
    expect(
      validateAgentOutput("אני מודל שפה גדול שאומן על ידי גוגל").allowed,
    ).toBe(false);
    const response = approvedAgentResponse("identity", "he", "טכנו שירות");
    expect(response).toBe(
      "אני העוזר הווירטואלי של טכנו שירות, ואני כאן כדי לעזור בפניות שירות. איך אפשר לעזור בנושא התקלה?",
    );
    expect(validateAgentOutput(response).allowed).toBe(true);
  });

  it("always allows an exact approved response", () => {
    const name = "Gemini Air Conditioning";
    const response = approvedAgentResponse("identity", "en", name);
    expect(validateAgentOutput(response).allowed).toBe(false);
    expect(
      validateAgentOutput(response, approvedAgentResponses(name)).allowed,
    ).toBe(true);
  });
});
