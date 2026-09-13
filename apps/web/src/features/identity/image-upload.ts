const MAX_IDENTITY_IMAGE_BYTES = 2 * 1024 * 1024;

export const identityImageAccept = "image/png,image/jpeg,image/webp";

function detectedContentType(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | "image/webp" | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export async function readIdentityImage(request: Request): Promise<{
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
  readonly data: Uint8Array;
}> {
  const form = await request.formData();
  const image = form.get("image");
  if (!(image instanceof File) || image.size === 0)
    throw new TypeError("Choose a PNG, JPEG or WebP image");
  if (image.size > MAX_IDENTITY_IMAGE_BYTES)
    throw new TypeError("Image must be 2 MB or smaller");
  const data = new Uint8Array(await image.arrayBuffer());
  const contentType = detectedContentType(data);
  if (contentType === undefined)
    throw new TypeError("Choose a valid PNG, JPEG or WebP image");
  return { contentType, data };
}
