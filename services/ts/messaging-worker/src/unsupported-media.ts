import type { WhatsAppInboundEnvelope } from "@or-on/crm";

/** Declared types only: this makes no claim to have decoded media contents. */
export function unsupportedInboundMedia(
  envelope: Pick<
    WhatsAppInboundEnvelope,
    "contentType" | "providerMessageType" | "media"
  >,
): boolean {
  if (envelope.providerMessageType === "sticker") return true;
  const mime = envelope.media?.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mime) return false;
  if (envelope.contentType === "video") return mime !== "video/mp4";
  if (envelope.contentType === "image")
    return !["image/jpeg", "image/png", "image/webp"].includes(mime);
  if (envelope.contentType === "document") return mime !== "application/pdf";
  if (envelope.contentType === "audio")
    return !["audio/ogg", "audio/wav"].includes(mime);
  return false;
}

/** Fixed informational reply. No model output or business receipt is accepted. */
export function unsupportedMediaReply(locale: string): string {
  if (locale.toLowerCase().startsWith("he"))
    return "קיבלתי את ההודעה, אבל איני יכול לקרוא את סוג המדיה הזה. אפשר לשלוח את הבקשה בהודעת טקסט?";
  if (locale.toLowerCase().startsWith("ar"))
    return "وصلت رسالتك، لكن لا أستطيع قراءة هذا النوع من الوسائط. هل يمكنك إرسال طلبك كنص؟";
  return "I received your message, but I cannot read this media type. Please send your request as text.";
}
