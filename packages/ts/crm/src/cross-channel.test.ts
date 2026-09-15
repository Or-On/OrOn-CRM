import { describe, expect, it } from "vitest";

import {
  compileCanonicalFlow,
  explicitWhatsAppCallbackIntent,
  parseCanonicalFlow,
  validateCanonicalFlow,
  type CanonicalFlow,
} from "./cross-channel.js";

const crossChannelFlow: CanonicalFlow = {
  schemaVersion: "1.0",
  channels: ["whatsapp", "voice"],
  nodes: [
    { id: "start", type: "start" },
    { id: "update", type: "crm.update" },
    { id: "call", type: "voice.call" },
    { id: "message", type: "message.send" },
    { id: "handoff", type: "handoff" },
    { id: "end", type: "end" },
  ],
  edges: [
    { id: "a", source: "start", target: "update" },
    { id: "b", source: "update", target: "call" },
    { id: "c", source: "update", target: "message" },
    { id: "d", source: "call", target: "handoff" },
    { id: "e", source: "message", target: "handoff" },
    { id: "f", source: "handoff", target: "end" },
  ],
};

describe("canonical cross-channel flow", () => {
  it("rejects embedded credential fields before draft persistence", () => {
    expect(() =>
      parseCanonicalFlow({
        ...crossChannelFlow,
        nodes: [
          {
            id: "start",
            type: "start",
            configuration: { nested: { apiKey: "fixture" } },
          },
        ],
      }),
    ).toThrow("credentials");
  });
  it("preserves detached configuration through parsing and compilation", () => {
    const configuration = {
      text: "Fictional {{vars.greeting}}",
      language: "he",
      variables: { "2": "b", "10": "c", "1": "a" },
    };
    const flow = parseCanonicalFlow({
      ...crossChannelFlow,
      nodes: crossChannelFlow.nodes.map((node) =>
        node.type === "message.send" ? { ...node, configuration } : node,
      ),
    });
    configuration.text = "changed";
    expect(
      compileCanonicalFlow(flow).whatsapp?.nodes.find(
        (node) => node.id === "message",
      )?.configuration,
    ).toEqual({ ...configuration, text: "Fictional {{vars.greeting}}" });
    expect(() =>
      parseCanonicalFlow({
        ...crossChannelFlow,
        nodes: [{ id: "bad", type: "start", configuration: [] }],
      }),
    ).toThrow("configuration");
  });
  it("normalizes and preserves accessible node labels", () => {
    const flow = parseCanonicalFlow({
      ...crossChannelFlow,
      nodes: crossChannelFlow.nodes.map((node) =>
        node.id === "message"
          ? { ...node, label: "  Send a customer follow-up  " }
          : node,
      ),
    });
    expect(flow.nodes.find((node) => node.id === "message")?.label).toBe(
      "Send a customer follow-up",
    );
    expect(
      compileCanonicalFlow(flow).whatsapp?.nodes.find(
        (node) => node.id === "message",
      )?.label,
    ).toBe("Send a customer follow-up");
    expect(() =>
      parseCanonicalFlow({
        ...crossChannelFlow,
        nodes: [{ id: "start", type: "start", label: " " }],
      }),
    ).toThrow("label");
  });
  it("compiles deterministically into retained voice and messaging adapters", () => {
    const first = compileCanonicalFlow(crossChannelFlow);
    const second = compileCanonicalFlow({
      ...crossChannelFlow,
      channels: ["voice", "whatsapp"],
      nodes: [...crossChannelFlow.nodes].reverse(),
      edges: [...crossChannelFlow.edges].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.voice?.schemaVersion).toBe("oron-flow.v1");
    expect(first.whatsapp?.schemaVersion).toBe("wacrm-automation.v1");
    expect(
      first.voice?.nodes.some((node) => node.type === "message.send"),
    ).toBe(false);
    expect(
      first.whatsapp?.nodes.some((node) => node.type === "voice.call"),
    ).toBe(false);
  });

  it("rejects broken graphs and unsupported channel-node combinations", () => {
    const result = validateCanonicalFlow({
      schemaVersion: "1.0",
      channels: ["voice"],
      nodes: [
        { id: "start", type: "start" },
        { id: "message", type: "message.send" },
      ],
      edges: [{ id: "broken", source: "start", target: "missing" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "node message is unsupported by the selected channels",
    );
    expect(result.errors).toContain("flow must contain at least one end node");
    expect(result.errors).toContain("edge broken references a missing node");
  });

  it("rejects duplicate channel and connection identifiers", () => {
    const result = validateCanonicalFlow({
      ...crossChannelFlow,
      channels: ["whatsapp", "whatsapp"],
      edges: [
        { id: "duplicate", source: "start", target: "update" },
        { id: "duplicate", source: "update", target: "message" },
      ],
    });
    expect(result.errors).toContain("flow channels must not be duplicated");
    expect(result.errors).toContain("duplicate edge ID: duplicate");
    expect(() =>
      parseCanonicalFlow({
        ...crossChannelFlow,
        edges: [{ id: "not valid", source: "start", target: "end" }],
      }),
    ).toThrow("edge id/source/target");
  });

  it("rejects untrusted payloads before compilation", () => {
    expect(() =>
      parseCanonicalFlow({
        schemaVersion: "1.0",
        channels: ["openlive"],
        nodes: [],
        edges: [],
      }),
    ).toThrow("unsupported channel");
  });
});

describe("explicit WhatsApp callback intent", () => {
  it.each([
    "אני רוצה שנציג יתקשר אליי",
    "אשמח שנציגה תחזור אליי בבקשה",
    "אפשר שמישהו יתקשר אלי עכשיו?",
    "כן, בבקשה תתקשרו אליי עכשיו",
    "בסדר, אפשר לקבל שיחה טלפונית עכשיו?",
    "I want a representative to call me",
    "I'd like an agent to call me now, please",
    "Please have someone call me",
    "Yes, please call me now",
    "Okay, can you call me?",
  ])("accepts a direct request for a representative callback: %s", (text) => {
    expect(explicitWhatsAppCallbackIntent(text)).toBe(true);
  });

  it.each([
    "The refrigerator is still leaking, so please call me now.",
    "The reset did not help and I want an agent to call me now",
    `The reset did not help and ${"the unresolved fault remains ".repeat(10)}, so please call me now`,
    "The device fails when it gets warm, so please call me now",
    "I do not know if it is under warranty. Please call me now",
    `The device fails when it gets warm and ${"the unresolved fault remains ".repeat(10)}, so please call me now`,
    "Should the reset fail, please call me",
    "The representative says to call me now",
    "On Friday, please call me",
    "Actually I do not want a call. Please call me",
    "יש תקלה, בבקשה תתקשרו אליי",
    "המקרר עדיין דולף, בבקשה תתקשרו אליי עכשיו",
    "ניסיתי לאפס ואני רוצה שנציג יתקשר אליי עכשיו",
    `האיפוס לא עזר ו${"התקלה עדיין לא נפתרה ".repeat(10)}, בבקשה תתקשרו אליי עכשיו`,
    "המכשיר נכבה כשהוא מתחמם, בבקשה תתקשרו אליי עכשיו",
    "אני לא יודע אם יש אחריות. בבקשה תתקשרו אליי עכשיו",
    `המכשיר נכבה כשהוא מתחמם ו${"התקלה עדיין לא נפתרה ".repeat(10)}, בבקשה תתקשרו אליי עכשיו`,
    "במידה שהאיפוס ייכשל, תתקשרו אליי",
    "הנציג אומר להתקשר אליי עכשיו",
    "ביום שישי, בבקשה תתקשרו אליי",
    "כנראה אי אפשר כרגע. בבקשה תתקשרו אליי",
  ])(
    "requires standalone confirmation for compound callback text: %s",
    (text) => {
      expect(explicitWhatsAppCallbackIntent(text)).toBe(false);
    },
  );

  it.each([
    "הנציג אמר שהוא יתקשר אליי",
    "אני רוצה שנציג יתקשר אליי מחר",
    "I want a representative to call my wife",
    "Can an agent call me tomorrow?",
    "The representative said, please call me",
    "The representative said; please call me",
    "The representative said. Please call me",
    "The representative said? Please call me",
    "The representative said! Please call me",
    "The representative said... Please call me",
    "The representative said… Please call me",
    `The representative said ${"the reported request remains unverified ".repeat(10)}. Please call me`,
    "Tomorrow, please call me",
    "Tomorrow; please call me",
    "Tomorrow. Please call me",
    "Tomorrow? Please call me",
    "Tomorrow! Please call me",
    "Tomorrow... Please call me",
    "Tomorrow… Please call me",
    `Tomorrow ${"the planned window remains unchanged ".repeat(10)}. Please call me`,
    "The device works now, so do not call me",
    "הנציג אמר, בבקשה תתקשרו אליי",
    "הנציג אמר; בבקשה תתקשרו אליי",
    "הנציג אמר. בבקשה תתקשרו אליי",
    "הנציג אמר? בבקשה תתקשרו אליי",
    "הנציג אמר! בבקשה תתקשרו אליי",
    "הנציג אמר... בבקשה תתקשרו אליי",
    "הנציג אמר… בבקשה תתקשרו אליי",
    `הנציג אמר ${"שהבקשה המדווחת עדיין לא אומתה ".repeat(10)}. בבקשה תתקשרו אליי`,
    "מחר, בבקשה תתקשרו אליי",
    "מחר; בבקשה תתקשרו אליי",
    "מחר. בבקשה תתקשרו אליי",
    "מחר? בבקשה תתקשרו אליי",
    "מחר! בבקשה תתקשרו אליי",
    "מחר... בבקשה תתקשרו אליי",
    "מחר… בבקשה תתקשרו אליי",
    `מחר ${"חלון הזמן המתוכנן נשאר ללא שינוי ".repeat(10)}. בבקשה תתקשרו אליי`,
    "התקלה נפתרה, אל תתקשרו אליי",
  ])(
    "rejects reported, third-party, or future callback wording: %s",
    (text) => {
      expect(explicitWhatsAppCallbackIntent(text)).toBe(false);
    },
  );

  it.each([
    "Do not. Please call me",
    "Do not? Please call me",
    "Do not! Please call me",
    "Do not... Please call me",
    "Do not… Please call me",
    `Do not ${"treat this padding as fresh consent ".repeat(10)}. Please call me`,
    "Please don't. Call me",
    "No need to! Please call me",
    "אל. תתקשרו אליי",
    "אל? תתקשרו אליי",
    "אל! תתקשרו אליי",
    "אל... תתקשרו אליי",
    "אל… תתקשרו אליי",
    `אל ${"תתייחסו למילוי הזה כהסכמה חדשה ".repeat(10)}. תתקשרו אליי`,
    "בבקשה אל. תתקשרו אליי",
    "אין צורך! בבקשה תתקשרו אליי",
    "אי אפשר להתקשר אליי",
    "אי  אפשר להתקשר אליי",
    "אי-אפשר להתקשר אליי",
    "אי־אפשר להתקשר אליי",
    "אי... אפשר להתקשר אליי",
    "אי אפשר. בבקשה תתקשרו אליי",
    "אי אפשר? בבקשה תתקשרו אליי",
    "אי אפשר! בבקשה תתקשרו אליי",
    "אי אפשר… בבקשה תתקשרו אליי",
  ])("rejects governing negation before callback wording: %s", (text) => {
    expect(explicitWhatsAppCallbackIntent(text)).toBe(false);
  });

  it.each([
    "When you finish checking, call me",
    "When you finish checking; please call me",
    "When you finish checking. Please call me",
    "When you finish checking? Please call me",
    "Once you confirm the warranty, please call me now",
    "Once you confirm the warranty; please call me now",
    "After you review the photos, please call me",
    "If the reset does not work, call me",
    "If the reset does not work; call me",
    "If the reset does not work! Call me",
    "If possible, please call me now",
    "Until you know more, please call me",
    "Before you close the ticket, please have an agent call me",
    "As soon as the part arrives, please give me a call",
    "I will wait and when you know more, please call me",
    "כשתסיימו לבדוק, תתקשרו אליי",
    "כשתסיימו לבדוק; תתקשרו אליי",
    "כשתסיימו לבדוק. תתקשרו אליי",
    "כשתסיימו לבדוק? תתקשרו אליי",
    "כאשר הטכנאי יתפנה, תחזרו אליי",
    "אחרי שתבדקו את התמונות, בבקשה תתקשרו אליי",
    "אם האיפוס לא יעבוד, תתקשרו אליי",
    "אם האיפוס לא יעבוד; תתקשרו אליי",
    "אם האיפוס לא יעבוד! תתקשרו אליי",
    "אם אפשר, בבקשה תתקשרו אליי עכשיו",
    "עד שיגיע החלק, תחזרו אליי",
    "לפני שאתם סוגרים את הקריאה, תתקשרו אליי",
    "ברגע שהחלק יגיע, תתקשרו אליי",
    "אני אחכה, וכשתדעו יותר תתקשרו אליי",
    "אשמח אם שתתקשרו אליי",
    "אני אשמח אם שתתקשרי אליי עכשיו",
    `When ${"the unresolved condition remains ".repeat(10)}, please call me`,
    `If ${"the unresolved condition remains ".repeat(10)}, please call me now`,
    `כאשר ${"התנאי עדיין לא התקיים ".repeat(10)}, בבקשה תתקשרו אליי`,
    `אם ${"התנאי עדיין לא התקיים ".repeat(10)}, תתקשרו אליי עכשיו`,
  ])("rejects conditional or deferred callback wording: %s", (text) => {
    expect(explicitWhatsAppCallbackIntent(text)).toBe(false);
  });

  it.each([
    "purple triangles argue with seven",
    "the router repeats the last question",
    "משולשים סגולים מתווכחים עם שבע",
    "הנתב חוזר על השאלה האחרונה",
  ])(
    "does not turn unrelated or nonsensical text into call consent: %s",
    (text) => {
      expect(explicitWhatsAppCallbackIntent(text)).toBe(false);
    },
  );
});
