export interface WhatsAppTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string;
  readonly preview: string;
  readonly buttons: readonly { readonly type: string; readonly text: string }[];
  /** Null for components the current text-template composer cannot fill. */
  readonly draft?: { readonly parameterCount: number } | null;
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
    let body = "";
    let supported = true;
    for (const component of components) {
      if (typeof component !== "object" || component === null) {
        supported = false;
        continue;
      }
      const part = component as Record<string, unknown>;
      if (part.type === "BODY" && typeof part.text === "string")
        body = part.text;
      if (!(
        part.type === "BODY" ||
        part.type === "FOOTER" ||
        (part.type === "HEADER" &&
          part.format === "TEXT" &&
          !String(part.text).includes("{{"))
      ))
        supported = false;
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
    const positions = [...body.matchAll(/\{\{(\d+)\}\}/gu)].map((match) =>
      Number(match[1]),
    );
    const parameterCount = Math.max(0, ...positions);
    supported =
      supported &&
      body.length > 0 &&
      parameterCount <= 20 &&
      positions.every((position) => position >= 1) &&
      !/\{\{[^\d}][^}]*\}\}/u.test(body) &&
      Array.from({ length: parameterCount }, (_, index) => index + 1).every(
        (position) => positions.includes(position),
      );
    return {
      id: String(row.id),
      name: String(row.name),
      language: String(row.language),
      status: String(row.status),
      category: String(row.category),
      preview: preview.join("\n"),
      buttons,
      draft: supported ? { parameterCount } : null,
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
