/** Supplied text stays untrusted; a media marker never claims inspection. */
export function messageContextText(
  contentType: string,
  contentText: string | null,
): string {
  const caption = contentText?.trim() ?? "";
  const marker =
    contentType === "image"
      ? "[Customer sent an image. Image contents have not been inspected.]"
      : contentType === "document"
        ? "[Customer sent a document. Document contents have not been inspected.]"
        : contentType === "location"
          ? "[Customer shared a location. Any supplied description is unverified.]"
          : undefined;
  return marker === undefined
    ? caption
    : marker + (caption ? ` Customer-supplied text: ${caption}` : "");
}
