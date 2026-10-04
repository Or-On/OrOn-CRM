export interface WhatsAppTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string;
  readonly preview: string;
  readonly buttons: readonly { readonly type: string; readonly text: string }[];
}

export interface WhatsAppTemplatePage {
  readonly templates: readonly WhatsAppTemplate[];
  readonly after: string | null;
  readonly fetchedAt: string;
}

export function parseTemplatePage(
  value: unknown,
): Omit<WhatsAppTemplatePage, "fetchedAt"> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    !Array.isArray(value.data)
  )
    throw new TypeError("Template catalog is unavailable");
  const templates: WhatsAppTemplate[] = value.data.map((item: unknown) => {
    if (typeof item !== "object" || item === null)
      throw new TypeError("Template catalog is unavailable");
    const row = item as Record<string, unknown>;
    for (const field of ["id", "name", "language", "status", "category"])
      if (typeof row[field] !== "string" || row[field].length > 512)
        throw new TypeError("Template catalog is unavailable");
    const components: unknown[] = Array.isArray(row.components)
      ? row.components
      : [];
    const preview: string[] = [];
    const buttons: { type: string; text: string }[] = [];
    for (const component of components) {
      if (typeof component !== "object" || component === null) continue;
      const part = component as Record<string, unknown>;
      if (
        ["HEADER", "BODY", "FOOTER"].includes(String(part.type)) &&
        typeof part.text === "string"
      )
        preview.push(part.text.slice(0, 4096));
      if (part.type === "BUTTONS" && Array.isArray(part.buttons))
        for (const value of (part.buttons as unknown[]).slice(0, 10)) {
          const button =
            typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)
              : {};
          if (
            typeof button.text === "string" &&
            typeof button.type === "string"
          )
            buttons.push({
              type: button.type.slice(0, 40),
              text: button.text.slice(0, 512),
            });
        }
    }
    return {
      id: String(row.id),
      name: String(row.name),
      language: String(row.language),
      status: String(row.status),
      category: String(row.category),
      preview: preview.join("\n"),
      buttons,
    };
  });
  const paging =
    "paging" in value &&
    typeof value.paging === "object" &&
    value.paging !== null
      ? (value.paging as Record<string, unknown>)
      : {};
  const cursors =
    typeof paging.cursors === "object" && paging.cursors !== null
      ? (paging.cursors as Record<string, unknown>)
      : {};
  const after =
    paging.next && typeof cursors.after === "string" ? cursors.after : null;
  if (after !== null && (after.length > 2048 || /[\r\n]/u.test(after)))
    throw new TypeError("Template catalog is unavailable");
  return { templates, after };
}
