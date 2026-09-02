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
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Voice operation failed");
  return payload;
}
