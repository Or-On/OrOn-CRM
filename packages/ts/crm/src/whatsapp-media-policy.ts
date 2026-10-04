import type { WhatsAppInboundEnvelope } from "./webhook.js";

export const UNSUPPORTED_WHATSAPP_REPLY =
  "קיבלתי את ההודעה, אבל איני יכול לקרוא את הסוג הזה כרגע. אפשר לשלוח את הבקשה בטקסט?";

export type WhatsAppInboundHandling =
  | { readonly kind: "conversation"; readonly text: string }
  | { readonly kind: "transcription_pending"; readonly mediaId: string }
  | {
      readonly kind: "reaction";
      readonly messageId: string;
      readonly emoji: string;
    }
  | { readonly kind: "unsupported"; readonly replyText: string };

/** Routing advice only. Callers must resolve tenant/authorization from the DB.
 * Interaction titles, captions and transcripts are user input, never tool
 * instructions or proof of an action. A reaction is not a new business request.
 */
export function whatsAppInboundHandling(
  envelope: WhatsAppInboundEnvelope,
): WhatsAppInboundHandling {
  if (envelope.contentType === "audio" && envelope.media !== undefined) {
    return { kind: "transcription_pending", mediaId: envelope.media.id };
  }
  if (
    envelope.providerMessageType === "reaction" &&
    envelope.reaction !== undefined
  ) {
    return { kind: "reaction", ...envelope.reaction };
  }
  if (
    envelope.contentType === "event" ||
    envelope.providerMessageType === "sticker" ||
    (envelope.contentType === "video" && envelope.text.trim() === "")
  ) {
    return { kind: "unsupported", replyText: UNSUPPORTED_WHATSAPP_REPLY };
  }
  return { kind: "conversation", text: envelope.text };
}
