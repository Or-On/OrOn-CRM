import { responsePayload } from "../crm";

export function csrfToken(): string {
  const entry = document.cookie
    .split("; ")
    .find((value) => value.startsWith("or_on_csrf="));
  return entry === undefined ? "" : decodeURIComponent(entry.slice(11));
}

export async function voiceMutation(
  path: string,
  body: object,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  const payload = await responsePayload(response);
  if (!response.ok)
    throw new Error(
      payload !== null &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
        ? payload.error
        : "Voice operation failed",
    );
  return payload;
}
