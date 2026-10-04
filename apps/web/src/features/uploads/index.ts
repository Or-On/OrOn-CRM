// Call only after the route has authenticated the request and checked CSRF.
// The bound is selected by server code, independently of declared file MIME.
export async function boundedMultipart(
  request: Request,
  maximumBytes: number,
): Promise<FormData> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 21 * 1024 * 1024
  )
    throw new TypeError("Upload body limit is invalid");
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)
  )
    throw new TypeError("Upload body is too large");
  const reader = request.body?.getReader();
  if (reader === undefined) throw new TypeError("Select a file to upload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new TypeError("Upload body is too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Response(Buffer.concat(chunks, size), {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  }).formData();
}
