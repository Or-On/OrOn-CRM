import type {
  OpeningMenuOffer,
  OpeningMenuStore,
  StoredOpeningMenuDecision,
} from "./opening-menu-database.js";
export interface OpeningMenuProvider {
  /** Fresh exact account/name/language/approval/button match; no guessed template. */
  verifyTemplate(offer: OpeningMenuOffer): Promise<boolean>;
  sendTemplate(
    offer: OpeningMenuOffer,
    beforeAttempt: () => Promise<void>,
    onAttemptStarted: () => void,
  ): Promise<{ readonly messageId: string }>;
}
export class OpeningMenuKnownRejection extends Error {}
/** Returns handled for pending/unknown/menu actions, so normal AI cannot answer before choice.
 * Media jobs are separate and must continue. Unknown physical outcome is never auto-retried.
 */
export async function processOpeningMenuJob(
  store: OpeningMenuStore,
  provider?: OpeningMenuProvider,
): Promise<{
  readonly handled: boolean;
  readonly decision: StoredOpeningMenuDecision;
}> {
  const prepared = await store.prepare();
  if (
    prepared.kind === "disabled" ||
    prepared.kind === "continue" ||
    prepared.kind === "route"
  )
    return { handled: false, decision: prepared };
  if (prepared.kind !== "offer") return { handled: true, decision: prepared };
  if (!provider || !(await provider.verifyTemplate(prepared)))
    throw new OpeningMenuKnownRejection(
      "Exact approved opening menu template is unavailable",
    );
  const offer = await store.begin();
  let messageId: string;
  const transport = { started: false };
  try {
    await store.authorize();
    const result = await provider.sendTemplate(
      offer,
      async () => {
        if (!(await provider.verifyTemplate(offer)))
          throw new Error("Opening menu template approval changed");
        await store.authorize();
      },
      () => {
        transport.started = true;
      },
    );
    if (!transport.started)
      throw new OpeningMenuKnownRejection(
        "Opening menu transport did not start",
      );
    if (!result.messageId || result.messageId.length > 1000)
      throw new Error("Opening menu transport receipt unavailable");
    messageId = result.messageId;
  } catch (error) {
    // A provider rejection proved before acceptance may be retried with the SAME generation.
    // Timeouts/disconnect/crashes are ambiguous; require manual provider reconciliation.
    await store.settle(
      !transport.started || error instanceof OpeningMenuKnownRejection
        ? "failed"
        : "unknown",
      null,
    );
    throw error;
  }
  await store.settle("sent", messageId);
  return { handled: true, decision: prepared };
}
