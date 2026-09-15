import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  normalizeNationalId,
  protectNationalId,
  revealNationalId,
} from "./national-id";

const tenant = "10000000-0000-4000-8000-000000000001";

describe("protected national IDs", () => {
  beforeEach(() => {
    process.env.FIELD_CIPHER_LOCAL_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.BLIND_INDEX_KEY = Buffer.alloc(32, 9).toString("base64");
  });

  afterEach(() => {
    delete process.env.FIELD_CIPHER_LOCAL_KEY;
    delete process.env.BLIND_INDEX_KEY;
  });

  it("preserves leading zeroes and binds ciphertext to one tenant", () => {
    const envelope = protectNationalId(tenant, "001-234-567");
    expect(envelope.ciphertext).not.toContain("001234567");
    expect(envelope.hint).toBe("4567");
    expect(revealNationalId(tenant, envelope.ciphertext)).toBe("001234567");
    expect(() =>
      revealNationalId(
        "20000000-0000-4000-8000-000000000002",
        envelope.ciphertext,
      ),
    ).toThrow();
  });

  it("normalizes separators but rejects non-digits", () => {
    expect(normalizeNationalId("000 123-45")).toBe("00012345");
    expect(() => normalizeNationalId("ID-1234")).toThrow();
  });
});
