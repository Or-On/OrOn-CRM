/** Business intent is canonical server state. Model text/UI locale grants no authority. */
export type MenuLanguage = "he" | "en";
export type MenuIntent = "services" | "support";
export interface OpeningMenuTemplate {
  readonly name: string;
  readonly language: MenuLanguage;
  readonly status: "APPROVED";
  readonly servicesButtonIndex: number;
  readonly supportButtonIndex: number;
}
export interface OpeningMenuConfiguration {
  readonly enabled: boolean;
  readonly tenantId: string;
  readonly channelId: string;
  readonly agentVersionId: string;
  readonly flowVersionId: string;
  readonly fallbackLanguage: MenuLanguage;
  readonly templates: readonly OpeningMenuTemplate[];
  readonly verifiedAt: number;
  readonly destinationsVerified: boolean;
}
export interface OpeningMenuState {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly ownershipEpoch: string;
  readonly lastActivityAt: number | null;
  readonly lastReceiptSequence: string | null;
  readonly preferredLanguage: MenuLanguage | null;
  readonly intent: MenuIntent | null;
  readonly offer: null | {
    readonly operationKey: string;
    readonly language: MenuLanguage;
    readonly status: "pending" | "sent" | "failed";
    readonly providerMessageId: string | null;
    readonly servicesPayload: string;
    readonly supportPayload: string;
  };
}
export interface OpeningMenuInbound {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly channelId: string;
  readonly agentVersionId: string;
  readonly flowVersionId: string;
  readonly ownershipEpoch: string;
  readonly ownershipMode: "ai" | "human";
  readonly messageId: string;
  readonly receivedAt: number;
  readonly receiptSequence: string;
  readonly text: string;
  readonly buttonPayload: string | null;
  readonly replyToProviderMessageId: string | null;
}
export type OpeningMenuDecision =
  | { readonly kind: "continue"; readonly reason: string }
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "await-choice" }
  | {
      readonly kind: "route";
      readonly intent: MenuIntent;
      readonly language: MenuLanguage;
      readonly state: OpeningMenuState;
    }
  | {
      readonly kind: "offer";
      readonly template: OpeningMenuTemplate;
      readonly operationKey: string;
      readonly state: OpeningMenuState;
    };

export function menuLanguage(
  text: string,
  preference: MenuLanguage | null,
  fallback: MenuLanguage,
): MenuLanguage {
  if (preference !== null) return preference;
  const hebrew = text.match(/[\u05d0-\u05ea]/gu)?.length ?? 0;
  const latin = text.match(/[a-z]/giu)?.length ?? 0;
  if (hebrew >= 2 && hebrew > latin) return "he";
  if (latin >= 3 && latin > hebrew) return "en";
  return fallback;
}

/** Called only with server-derived DB snapshot, under a conversation lock.
 * The caller must persist the decision and enqueue the offer in the SAME transaction.
 * Stable payloads are opaque per-offer values supplied by that canonical DB claim.
 */
export function evaluateOpeningMenu(
  config: OpeningMenuConfiguration,
  state: OpeningMenuState,
  inbound: OpeningMenuInbound,
  payloads: { readonly services: string; readonly support: string },
  now: number,
): OpeningMenuDecision {
  if (
    !config.enabled ||
    !config.destinationsVerified ||
    now < config.verifiedAt ||
    now - config.verifiedAt > 60_000
  )
    return { kind: "continue", reason: "menu-disabled-or-unverified" };
  if (
    config.tenantId !== state.tenantId ||
    config.tenantId !== inbound.tenantId ||
    state.conversationId !== inbound.conversationId ||
    config.channelId !== inbound.channelId ||
    config.agentVersionId !== inbound.agentVersionId ||
    config.flowVersionId !== inbound.flowVersionId ||
    state.ownershipEpoch !== inbound.ownershipEpoch
  )
    return { kind: "ignore", reason: "canonical-binding-changed" };
  if (inbound.ownershipMode !== "ai")
    return { kind: "continue", reason: "human-owned" };
  if (
    !/^\d+$/u.test(inbound.receiptSequence) ||
    (state.lastReceiptSequence !== null &&
      BigInt(inbound.receiptSequence) <= BigInt(state.lastReceiptSequence))
  )
    return { kind: "ignore", reason: "duplicate-or-delayed-receipt" };
  if (
    !Number.isFinite(inbound.receivedAt) ||
    inbound.receivedAt > now ||
    (state.lastActivityAt !== null && inbound.receivedAt < state.lastActivityAt)
  )
    return { kind: "ignore", reason: "invalid-or-delayed-time" };
  const language = menuLanguage(
    inbound.text,
    state.preferredLanguage,
    config.fallbackLanguage,
  );
  const freshState = {
    ...state,
    lastActivityAt: inbound.receivedAt,
    lastReceiptSequence: inbound.receiptSequence,
  };
  const reopened =
    state.lastActivityAt === null ||
    inbound.receivedAt - state.lastActivityAt >= 24 * 60 * 60 * 1000;
  // Old quick replies never choose a new menu, including the 24h reopen boundary.
  if (inbound.buttonPayload !== null) {
    if (
      reopened ||
      state.offer?.status !== "sent" ||
      state.offer.providerMessageId === null ||
      inbound.replyToProviderMessageId !== state.offer.providerMessageId
    )
      return { kind: "ignore", reason: "stale-or-unbound-button" };
    const intent =
      inbound.buttonPayload === state.offer.servicesPayload
        ? "services"
        : inbound.buttonPayload === state.offer.supportPayload
          ? "support"
          : null;
    if (intent === null) return { kind: "ignore", reason: "unknown-button" };
    if (state.intent !== null)
      return { kind: "ignore", reason: "choice-already-committed" };
    return {
      kind: "route",
      intent,
      language: state.offer.language,
      state: { ...freshState, preferredLanguage: state.offer.language, intent },
    };
  }
  if (!reopened && state.intent !== null)
    return { kind: "continue", reason: "existing-selected-route" };
  if (!reopened && state.offer !== null) return { kind: "await-choice" };
  const template = config.templates.find(
    (entry) => entry.language === language,
  );
  if (
    !template ||
    template.servicesButtonIndex === template.supportButtonIndex ||
    !Number.isInteger(template.servicesButtonIndex) ||
    !Number.isInteger(template.supportButtonIndex) ||
    template.servicesButtonIndex < 0 ||
    template.supportButtonIndex < 0 ||
    template.servicesButtonIndex > 9 ||
    template.supportButtonIndex > 9 ||
    payloads.services.length < 16 ||
    payloads.support.length < 16 ||
    payloads.services === payloads.support
  )
    return {
      kind: "continue",
      reason: "approved-template-or-buttons-unavailable",
    };
  const operationKey = `opening-menu:${inbound.conversationId}:${inbound.ownershipEpoch}:${inbound.messageId}`;
  return {
    kind: "offer",
    template,
    operationKey,
    state: {
      ...freshState,
      intent: null,
      offer: {
        operationKey,
        language,
        status: "pending",
        providerMessageId: null,
        servicesPayload: payloads.services,
        supportPayload: payloads.support,
      },
    },
  };
}
