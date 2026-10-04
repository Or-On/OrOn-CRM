export interface InboxTemplate {
  readonly name: string;
  readonly language: string;
  readonly status: string;
  readonly body: string;
  readonly parameterCount: number;
  readonly supported: boolean;
}

/** Only text-body templates can be filled by the current message composer. */
export function parseTemplates(value: unknown): readonly InboxTemplate[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !Array.isArray(value.data)
  )
    throw new Error("Template catalog returned invalid data");
  return value.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.name !== "string" ||
      typeof row.language !== "string" ||
      typeof row.status !== "string" ||
      !Array.isArray(row.components)
    )
      return [];
    const components = row.components as Record<string, unknown>[];
    const body = components.find((component) => component.type === "BODY");
    const text = typeof body?.text === "string" ? body.text : "";
    const positions = [...text.matchAll(/\{\{(\d+)\}\}/gu)].map((match) =>
      Number(match[1]),
    );
    const parameterCount = Math.max(0, ...positions);
    const supported =
      parameterCount <= 20 &&
      !/\{\{[^\d}][^}]*\}\}/u.test(text) &&
      Array.from({ length: parameterCount }, (_, index) => index + 1).every(
        (position) => positions.includes(position),
      ) &&
      components.every(
        (component) =>
          component.type === "BODY" ||
          component.type === "FOOTER" ||
          (component.type === "HEADER" &&
            component.format === "TEXT" &&
            !String(component.text).includes("{{")),
      );
    return [
      {
        name: row.name,
        language: row.language,
        status: row.status,
        body: text,
        parameterCount,
        supported,
      },
    ];
  });
}
