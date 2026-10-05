export interface WhatsAppTemplateButton {
  readonly type: string;
  readonly text: string;
}

/** Why the composer cannot send a template; absent when it can. */
export type TemplateUnsupportedReason =
  | "missing_body"
  | "named_parameters"
  | "parameter_gaps"
  | "too_many_parameters"
  | "media_header"
  | "header_parameters"
  | "button_parameters"
  | "unsupported_component";

export interface WhatsAppTemplate {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly category: string;
  /** Header, body and footer text joined, exactly as defined. */
  readonly preview: string;
  readonly header?: string | null;
  readonly body?: string;
  readonly footer?: string | null;
  readonly buttons: readonly WhatsAppTemplateButton[];
  /** Null for components the current text-template composer cannot fill. */
  readonly draft?: { readonly parameterCount: number } | null;
  readonly unsupported?: TemplateUnsupportedReason | null;
}

export interface WhatsAppTemplatePage {
  readonly templates: readonly WhatsAppTemplate[];
  readonly after: string | null;
  readonly fetchedAt: string;
}

/** Buttons Meta sends as defined, without a per-message parameter. */
const staticButtonTypes = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER"]);

function componentText(part: Record<string, unknown>): string | null {
  return typeof part.text === "string" ? part.text.slice(0, 4096) : null;
}

/**
 * Classify one template's components. Only body parameters can be filled by
 * the composer; static buttons are sent as approved, while media headers and
 * per-message button values would need data the composer does not collect.
 */
function classify(components: readonly unknown[]): {
  readonly header: string | null;
  readonly body: string;
  readonly footer: string | null;
  readonly buttons: readonly WhatsAppTemplateButton[];
  readonly unsupported: TemplateUnsupportedReason | null;
  readonly parameterCount: number;
} {
  let header: string | null = null;
  let body = "";
  let footer: string | null = null;
  const buttons: WhatsAppTemplateButton[] = [];
  const reasons: TemplateUnsupportedReason[] = [];
  for (const component of components) {
    if (typeof component !== "object" || component === null) {
      reasons.push("unsupported_component");
      continue;
    }
    const part = component as Record<string, unknown>;
    if (part.type === "BODY") {
      body = componentText(part) ?? "";
    } else if (part.type === "FOOTER") {
      footer = componentText(part);
    } else if (part.type === "HEADER") {
      if (part.format === "TEXT") {
        header = componentText(part);
        if (header?.includes("{{")) reasons.push("header_parameters");
      } else reasons.push("media_header");
    } else if (part.type === "BUTTONS" && Array.isArray(part.buttons)) {
      for (const value of (part.buttons as unknown[]).slice(0, 10)) {
        const button =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
        if (typeof button.text !== "string" || typeof button.type !== "string")
          continue;
        buttons.push({
          type: button.type.slice(0, 40),
          text: button.text.slice(0, 512),
        });
        if (!staticButtonTypes.has(button.type))
          reasons.push("unsupported_component");
        else if (
          button.type === "URL" &&
          typeof button.url === "string" &&
          button.url.includes("{{")
        )
          reasons.push("button_parameters");
      }
    } else reasons.push("unsupported_component");
  }
  const positions = [...body.matchAll(/\{\{(\d+)\}\}/gu)].map((match) =>
    Number(match[1]),
  );
  const parameterCount = Math.max(0, ...positions);
  if (body.length === 0) reasons.push("missing_body");
  else if (/\{\{[^\d}][^}]*\}\}/u.test(body)) reasons.push("named_parameters");
  else if (parameterCount > 20) reasons.push("too_many_parameters");
  else if (
    positions.some((position) => position < 1) ||
    !Array.from({ length: parameterCount }, (_, index) => index + 1).every(
      (position) => positions.includes(position),
    )
  )
    reasons.push("parameter_gaps");
  return {
    header,
    body,
    footer,
    buttons,
    unsupported: reasons[0] ?? null,
    parameterCount,
  };
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
    const parts = classify(Array.isArray(row.components) ? row.components : []);
    return {
      id: String(row.id),
      name: String(row.name),
      language: String(row.language),
      status: String(row.status),
      category: String(row.category),
      preview: [parts.header, parts.body, parts.footer]
        .filter((text): text is string => text !== null && text !== "")
        .join("\n"),
      header: parts.header,
      body: parts.body,
      footer: parts.footer,
      buttons: parts.buttons,
      draft:
        parts.unsupported === null
          ? { parameterCount: parts.parameterCount }
          : null,
      unsupported: parts.unsupported,
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

/** Body text with positional values substituted; unfilled ones stay visible. */
export function renderTemplateText(
  text: string,
  values: readonly string[],
): string {
  return text.replace(/\{\{(\d+)\}\}/gu, (placeholder, position: string) => {
    const value = values[Number(position) - 1]?.trim();
    return value === undefined || value === "" ? placeholder : value;
  });
}
