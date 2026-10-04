import { describe, expect, it } from "vitest";
import type {
  OpeningMenuOffer,
  OpeningMenuStore,
} from "../src/opening-menu-database.js";
import {
  OpeningMenuKnownRejection,
  processOpeningMenuJob,
} from "../src/opening-menu-job.js";
const offer: OpeningMenuOffer = {
  kind: "offer",
  tenantId: "tenant",
  conversationId: "conversation",
  channelId: "channel",
  ownershipEpoch: 1,
  agentVersionId: "agent",
  flowVersionId: "flow",
  sourceMessageId: "source",
  generation: "generation",
  operationKey: "opening-menu:generation",
  language: "he",
  phoneNumberId: "12345",
  wabaId: "23456",
  graphApiVersion: "v26.0",
  recipient: "+15551234567",
  template: {
    name: "synthetic_menu",
    language: "he",
    status: "APPROVED",
    servicesButtonIndex: 0,
    servicesButtonText: "מידע על שירותים",
    supportButtonText: "עזרה או תקלה",
    supportButtonIndex: 1,
  },
  servicesPayload: "opaque-services",
  supportPayload: "opaque-support",
};
function fixture() {
  let outcome = "pending";
  let authority = true;
  const outcomes: string[] = [];
  const store: OpeningMenuStore = {
    prepare: () =>
      Promise.resolve(
        ["unknown", "sent", "sending"].includes(outcome)
          ? { kind: "handled", reason: "already-attempted" }
          : offer,
      ),
    begin: () => {
      if (!["pending", "failed"].includes(outcome))
        return Promise.reject(new Error("duplicate"));
      outcome = "sending";
      return Promise.resolve(offer);
    },
    authorize: () =>
      authority ? Promise.resolve() : Promise.reject(new Error("revoked")),
    credential: () => Promise.resolve({ legacy: true }),
    settle: (next) => {
      outcome = next;
      outcomes.push(next);
      return Promise.resolve();
    },
  };
  return {
    store,
    outcomes,
    revoke: () => {
      authority = false;
    },
  };
}
describe("opening menu physical effect fencing", () => {
  it("default unbound provider does not begin or send", async () => {
    const state = fixture();
    await expect(processOpeningMenuJob(state.store)).rejects.toThrow(
      "Exact approved opening menu template",
    );
    expect(state.outcomes).toEqual([]);
  });
  it("approved offer sends once and replay never calls provider", async () => {
    const state = fixture();
    let sends = 0;
    const provider = {
      verifyTemplate: () => Promise.resolve(true),
      sendTemplate: async (
        _offer: OpeningMenuOffer,
        before: () => Promise<void>,
        started: () => void,
      ) => {
        await before();
        started();
        sends++;
        return { messageId: "synthetic-provider" };
      },
    };
    await processOpeningMenuJob(state.store, provider);
    await processOpeningMenuJob(state.store, provider);
    expect(sends).toBe(1);
    expect(state.outcomes).toEqual(["sent"]);
  });
  it("unknown physical timeout is retained and cannot be retried", async () => {
    const state = fixture();
    let sends = 0;
    const provider = {
      verifyTemplate: () => Promise.resolve(true),
      sendTemplate: async (
        _offer: OpeningMenuOffer,
        before: () => Promise<void>,
        started: () => void,
      ) => {
        await before();
        started();
        sends++;
        throw new Error("unknown transport result");
      },
    };
    await expect(processOpeningMenuJob(state.store, provider)).rejects.toThrow(
      "unknown transport result",
    );
    expect((await processOpeningMenuJob(state.store, provider)).handled).toBe(
      true,
    );
    expect(sends).toBe(1);
    expect(state.outcomes).toEqual(["unknown"]);
  });
  it("known rejection retries the same operation without changing payloads", async () => {
    const state = fixture();
    const keys: string[] = [];
    const provider = {
      verifyTemplate: () => Promise.resolve(true),
      sendTemplate: async (
        plan: OpeningMenuOffer,
        before: () => Promise<void>,
        started: () => void,
      ) => {
        await before();
        started();
        keys.push(plan.operationKey);
        if (keys.length === 1)
          throw new OpeningMenuKnownRejection("explicitly rejected");
        return { messageId: "synthetic-provider" };
      },
    };
    await expect(processOpeningMenuJob(state.store, provider)).rejects.toThrow(
      "explicitly rejected",
    );
    await processOpeningMenuJob(state.store, provider);
    expect(keys).toEqual([offer.operationKey, offer.operationKey]);
    expect(state.outcomes).toEqual(["failed", "sent"]);
  });
  it("credential failure after fresh authorization but before POST remains retryable", async () => {
    const state = fixture();
    let attempts = 0;
    const provider = {
      verifyTemplate: () => Promise.resolve(true),
      sendTemplate: async (
        _offer: OpeningMenuOffer,
        before: () => Promise<void>,
        started: () => void,
      ) => {
        await before();
        attempts++;
        if (attempts === 1)
          throw new Error("fresh credential unavailable before POST");
        started();
        return { messageId: "synthetic-after-retry" };
      },
    };
    await expect(processOpeningMenuJob(state.store, provider)).rejects.toThrow(
      "fresh credential unavailable",
    );
    expect(state.outcomes).toEqual(["failed"]);
    await processOpeningMenuJob(state.store, provider);
    expect(state.outcomes).toEqual(["failed", "sent"]);
  });
  it("human takeover immediately before physical transport blocks it", async () => {
    const state = fixture();
    let sends = 0;
    const provider = {
      verifyTemplate: () => Promise.resolve(true),
      sendTemplate: async (
        _offer: OpeningMenuOffer,
        before: () => Promise<void>,
        started: () => void,
      ) => {
        state.revoke();
        await before();
        started();
        sends++;
        return { messageId: "never" };
      },
    };
    await expect(processOpeningMenuJob(state.store, provider)).rejects.toThrow(
      "revoked",
    );
    expect(sends).toBe(0);
    expect(state.outcomes).toEqual(["failed"]);
  });
});
