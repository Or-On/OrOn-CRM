import { describe, expect, it } from "vitest";
import {
  evaluateOpeningMenu,
  menuLanguage,
  type OpeningMenuConfiguration,
  type OpeningMenuInbound,
  type OpeningMenuState,
} from "../src/opening-menu.js";

const config: OpeningMenuConfiguration = {
  enabled: true,
  tenantId: "t1",
  channelId: "c1",
  agentVersionId: "a1",
  flowVersionId: "f1",
  fallbackLanguage: "he",
  verifiedAt: 1000,
  destinationsVerified: true,
  templates: [
    {
      name: "synthetic_he",
      language: "he",
      status: "APPROVED",
      servicesButtonIndex: 0,
      supportButtonIndex: 1,
    },
    {
      name: "synthetic_en",
      language: "en",
      status: "APPROVED",
      servicesButtonIndex: 0,
      supportButtonIndex: 1,
    },
  ],
};
const state: OpeningMenuState = {
  tenantId: "t1",
  conversationId: "conversation1",
  ownershipEpoch: "1",
  lastActivityAt: null,
  lastReceiptSequence: null,
  preferredLanguage: null,
  intent: null,
  offer: null,
};
const inbound: OpeningMenuInbound = {
  tenantId: "t1",
  conversationId: "conversation1",
  channelId: "c1",
  agentVersionId: "a1",
  flowVersionId: "f1",
  ownershipEpoch: "1",
  ownershipMode: "ai",
  messageId: "m1",
  receivedAt: 1000,
  receiptSequence: "1",
  text: "שלום",
  buttonPayload: null,
  replyToProviderMessageId: null,
};
const payloads = {
  services: "opaque-services-123456",
  support: "opaque-support-123456",
};

describe("disabled-until-verified opening menu contract", () => {
  it("uses prior preference/incoming script and safe fallback, never UI locale", () => {
    expect(menuLanguage("hello", "he", "en")).toBe("he");
    expect(menuLanguage("hello", null, "he")).toBe("en");
    expect(menuLanguage("שלום", null, "en")).toBe("he");
    expect(menuLanguage("123?", null, "he")).toBe("he");
  });
  it("is disabled without verified destinations/templates or fresh approval", () => {
    for (const override of [
      { enabled: false },
      { destinationsVerified: false },
      { verifiedAt: -100000 },
      { templates: [] },
    ])
      expect(
        evaluateOpeningMenu(
          { ...config, ...override },
          state,
          inbound,
          payloads,
          1000,
        ).kind,
      ).toBe("continue");
  });
  it("claims one pending offer; duplicate, cross-tenant, epoch and human ownership never recreate it", () => {
    const decision = evaluateOpeningMenu(
      config,
      state,
      inbound,
      payloads,
      1000,
    );
    expect(decision.kind).toBe("offer");
    if (decision.kind !== "offer") throw new Error("missing offer");
    expect(
      evaluateOpeningMenu(config, decision.state, inbound, payloads, 1000).kind,
    ).toBe("ignore");
    expect(
      evaluateOpeningMenu(
        config,
        decision.state,
        { ...inbound, messageId: "m2", receiptSequence: "2" },
        payloads,
        1000,
      ).kind,
    ).toBe("await-choice");
    expect(
      evaluateOpeningMenu(
        config,
        state,
        { ...inbound, tenantId: "t2" },
        payloads,
        1000,
      ).kind,
    ).toBe("ignore");
    expect(
      evaluateOpeningMenu(
        config,
        state,
        { ...inbound, ownershipEpoch: "2" },
        payloads,
        1000,
      ).kind,
    ).toBe("ignore");
    expect(
      evaluateOpeningMenu(
        config,
        state,
        { ...inbound, ownershipMode: "human" },
        payloads,
        1000,
      ).kind,
    ).toBe("continue");
  });
  it("accepts only sent-offer bound reply and exactly one persistent choice", () => {
    const offered = evaluateOpeningMenu(config, state, inbound, payloads, 1000);
    if (offered.kind !== "offer" || !offered.state.offer)
      throw new Error("missing offer");
    const sent = {
      ...offered.state,
      offer: {
        ...offered.state.offer,
        status: "sent" as const,
        providerMessageId: "provider1",
      },
    };
    const reply = {
      ...inbound,
      receiptSequence: "2",
      messageId: "m2",
      buttonPayload: payloads.support,
      replyToProviderMessageId: "provider1",
    };
    const chosen = evaluateOpeningMenu(config, sent, reply, payloads, 1000);
    expect(chosen.kind).toBe("route");
    if (chosen.kind !== "route") throw new Error("missing route");
    expect(chosen.intent).toBe("support");
    expect(
      evaluateOpeningMenu(
        config,
        chosen.state,
        { ...reply, receiptSequence: "3", buttonPayload: payloads.services },
        payloads,
        1000,
      ).kind,
    ).toBe("ignore");
    expect(
      evaluateOpeningMenu(
        config,
        sent,
        { ...reply, replyToProviderMessageId: "other" },
        payloads,
        1000,
      ).kind,
    ).toBe("ignore");
    expect(
      evaluateOpeningMenu(
        config,
        { ...sent, offer: { ...sent.offer, status: "failed" } },
        reply,
        payloads,
        1000,
      ).kind,
    ).toBe("ignore");
  });
  it("reopens exactly at 24h without reusing the old choice", () => {
    const old = {
      ...state,
      lastActivityAt: 0,
      lastReceiptSequence: "1",
      intent: "support" as const,
      preferredLanguage: "en" as const,
    };
    const time = 86400000;
    expect(
      evaluateOpeningMenu(
        { ...config, verifiedAt: time },
        old,
        { ...inbound, receivedAt: time - 1, receiptSequence: "2" },
        payloads,
        time,
      ).kind,
    ).toBe("continue");
    const opened = evaluateOpeningMenu(
      { ...config, verifiedAt: time },
      old,
      { ...inbound, receivedAt: time, receiptSequence: "2", messageId: "m2" },
      payloads,
      time,
    );
    expect(opened.kind).toBe("offer");
    if (opened.kind === "offer") {
      expect(opened.state.intent).toBeNull();
      expect(opened.template.language).toBe("en");
    }
  });
});
