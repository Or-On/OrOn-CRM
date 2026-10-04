/** Textual evidence only: media labels never imply that bytes were understood. */
export function messageContextText(message: {
  readonly content_type: string;
  readonly content_text: string | null;
  readonly structured_content: unknown;
}): string {
  const value = message.structured_content;
  const data =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  const bounded = (value: unknown, maximum = 4096): string =>
    typeof value === "string" ? value.trim().slice(0, maximum) : "";
  const text = bounded(message.content_text);
  if (message.content_type === "text") return text;
  if (message.content_type === "template") {
    const name = bounded(data.templateName, 512);
    const language = bounded(data.language, 20);
    const parameters = Array.isArray(data.parameters)
      ? data.parameters
          .map((value) => bounded(value, 1024))
          .filter(Boolean)
          .join(" | ")
      : "";
    return [
      "[Sent template; body unavailable unless included below]",
      name,
      language,
      text,
      parameters,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (message.content_type === "location") {
    const coordinates =
      typeof data.latitude === "number" &&
      Number.isFinite(data.latitude) &&
      Math.abs(data.latitude) <= 90 &&
      typeof data.longitude === "number" &&
      Number.isFinite(data.longitude) &&
      Math.abs(data.longitude) <= 180
        ? `${data.latitude}, ${data.longitude}`
        : "";
    return [
      "[Customer shared location]",
      text,
      bounded(data.name, 500),
      bounded(data.address, 1000),
      coordinates,
    ]
      .filter(Boolean)
      .join(" ");
  }
  const caption = text || bounded(data.caption);
  const transcript = bounded(data.transcript);
  return [
    `[Customer shared ${bounded(message.content_type, 40)}; attachment content is not available to this text model]`,
    bounded(data.fileName, 500),
    caption,
    ...(transcript ? [`Transcript: ${transcript}`] : []),
  ]
    .filter(Boolean)
    .join(" ");
}
