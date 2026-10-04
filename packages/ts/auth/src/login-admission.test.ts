import { describe, expect, it } from "vitest";
import {
  AuthenticationBusyError,
  withLoginAdmission,
} from "./login-admission.js";
describe("global login resource admission", () => {
  it("rejects excess work without executing or queueing it, then recovers", async () => {
    let release: () => void = () => {
      throw Error("not ready");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let admitted = 0;
    const first = withLoginAdmission(2, async () => {
      admitted++;
      await gate;
    });
    const second = withLoginAdmission(2, async () => {
      admitted++;
      await gate;
    });
    await expect(
      withLoginAdmission(2, () => {
        admitted++;
        return Promise.resolve();
      }),
    ).rejects.toBeInstanceOf(AuthenticationBusyError);
    expect(admitted).toBe(2);
    release();
    await Promise.all([first, second]);
    expect(await withLoginAdmission(2, () => Promise.resolve("allowed"))).toBe(
      "allowed",
    );
  });
  it("releases capacity after failure", async () => {
    await expect(
      withLoginAdmission(1, () => Promise.reject(new Error("lookup failed"))),
    ).rejects.toThrow("lookup failed");
    expect(
      await withLoginAdmission(1, () => Promise.resolve("recovered")),
    ).toBe("recovered");
  });
  it.each([0, -1, 9, 1.5, Number.NaN])(
    "rejects invalid policy %s",
    async (value) => {
      await expect(
        withLoginAdmission(value, () => Promise.resolve()),
      ).rejects.toThrow("integer");
    },
  );
});
