import { describe, expect, it } from "vitest";
import { selectPrivateByteRange } from "./http-byte-range";
describe("finite single private byte ranges", () => {
  it("returns full only without a Range header", () =>
    expect(selectPrivateByteRange(null, 100)).toEqual({ kind: "full" }));
  it.each([
    ["bytes=0-9", 0, 9],
    ["bytes=95-200", 95, 99],
    ["bytes=30-", 30, 99],
    ["bytes=-10", 90, 99],
    ["bytes=-200", 0, 99],
    ["bytes=0-0", 0, 0],
    ["bytes=99-99", 99, 99],
    [" bytes=1-3 ", 1, 3],
  ])("selects %s without exceeding the stored object", (header, start, end) =>
    expect(selectPrivateByteRange(header, 100)).toEqual({
      kind: "partial",
      start,
      end,
    }),
  );
  it.each([
    "bytes=100-",
    "bytes=5-2",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,4-5",
    "items=0-2",
    "bytes=1e2-",
    "bytes=+1-2",
    "bytes=9007199254740992-",
    "bytes=0-9007199254740992",
    "x".repeat(129),
  ])("refuses invalid or multiple %s", (header) =>
    expect(selectPrivateByteRange(header, 100)).toEqual({
      kind: "unsatisfiable",
    }),
  );
  it.each([0, -1, NaN, Infinity, 1.5])(
    "rejects untrusted object length %s",
    (length) =>
      expect(() => selectPrivateByteRange(null, length)).toThrow(TypeError),
  );
});
