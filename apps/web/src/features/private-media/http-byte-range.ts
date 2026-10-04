export type PrivateByteRange =
  | { readonly kind: "full" }
  | { readonly kind: "unsatisfiable" }
  | { readonly kind: "partial"; readonly start: number; readonly end: number };

/** One finite range only; call after authorizing and verifying private bytes. */
export function selectPrivateByteRange(
  header: string | null,
  length: number,
): PrivateByteRange {
  if (!Number.isSafeInteger(length) || length < 1)
    throw new TypeError("Private media length is invalid");
  if (header === null) return { kind: "full" };
  if (header.length > 128) return { kind: "unsatisfiable" };
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return { kind: "unsatisfiable" };
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return { kind: "unsatisfiable" };
  if (first === undefined) {
    if (last === undefined || last < 1) return { kind: "unsatisfiable" };
    return {
      kind: "partial",
      start: Math.max(0, length - last),
      end: length - 1,
    };
  }
  if (first >= length || (last !== undefined && last < first))
    return { kind: "unsatisfiable" };
  return {
    kind: "partial",
    start: first,
    end: Math.min(last ?? length - 1, length - 1),
  };
}
