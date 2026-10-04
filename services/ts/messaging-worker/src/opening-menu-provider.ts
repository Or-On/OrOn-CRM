import type { ChannelCredentialEnvelope } from "./channel-credentials.js";
import type { OpeningMenuStore } from "./opening-menu-database.js";
import {
  OpeningMenuKnownRejection,
  type OpeningMenuProvider,
} from "./opening-menu-job.js";
import { WhatsAppProviderError, type WhatsAppProvider } from "./providers.js";

/** Only a canonical owned-job store can project authority and sealed credentials. */
export function createOpeningMenuProvider(
  store: OpeningMenuStore,
  provider: WhatsAppProvider,
  resolveCredential?: (envelope: ChannelCredentialEnvelope) => string,
): OpeningMenuProvider {
  const accessTokenForAttempt = async () => {
    const envelope = await store.credential();
    if ("legacy" in envelope) return undefined;
    if (resolveCredential === undefined)
      throw new WhatsAppProviderError("channel_credential_unavailable", false);
    try {
      return resolveCredential(envelope);
    } catch {
      throw new WhatsAppProviderError("channel_credential_unavailable", false);
    }
  };
  return {
    verifyTemplate: async (offer) => {
      if (provider.name !== "meta" || provider.verifyTemplate === undefined)
        return false;
      return provider.verifyTemplate({
        senderPhoneNumberId: offer.phoneNumberId,
        wabaId: offer.wabaId,
        graphApiVersion: offer.graphApiVersion,
        templateName: offer.template.name,
        language: offer.language,
        buttonIndices: [
          offer.template.servicesButtonIndex,
          offer.template.supportButtonIndex,
        ],
        buttonTexts: [
          offer.template.servicesButtonText,
          offer.template.supportButtonText,
        ],
        beforeAttempt: () => store.authorize("read"),
        accessTokenForAttempt,
      });
    },
    sendTemplate: async (offer, beforeAttempt, onAttemptStarted) => {
      try {
        return await provider.send({
          senderPhoneNumberId: offer.phoneNumberId,
          recipient: offer.recipient,
          idempotencyKey: offer.operationKey,
          delivery: {
            kind: "template",
            templateName: offer.template.name,
            language: offer.language,
            parameters: [],
            quickReplies: [
              {
                index: offer.template.servicesButtonIndex,
                payload: offer.servicesPayload,
              },
              {
                index: offer.template.supportButtonIndex,
                payload: offer.supportPayload,
              },
            ],
          },
          beforeAttempt,
          accessTokenForAttempt,
          maximumAttempts: 1,
          onAttemptStarted,
        });
      } catch (error) {
        // A timeout, disconnect or server error has an unknown physical outcome.
        if (
          error instanceof WhatsAppProviderError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        )
          throw new OpeningMenuKnownRejection(
            "Opening menu was explicitly rejected",
            { cause: error },
          );
        throw error;
      }
    },
  };
}
