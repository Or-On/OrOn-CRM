import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";
describe("login admission configuration", () => {
  it("defaults to two simultaneous expensive logins per process", () => {
    expect(loadConfig({}).maximumConcurrentLogins).toBe(2);
  });
  it.each(["0", "9", "2.5", "NaN", "2; DROP", " ", ""])(
    "rejects invalid policy %s",
    (value) => {
      expect(() => loadConfig({ AUTH_MAX_CONCURRENT_LOGINS: value })).toThrow();
    },
  );
  it("accepts explicit bounded policy", () => {
    expect(
      loadConfig({ AUTH_MAX_CONCURRENT_LOGINS: "4" }).maximumConcurrentLogins,
    ).toBe(4);
  });
});
