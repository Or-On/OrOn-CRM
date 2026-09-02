import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { deliverSimulatedCallFollowup } from "./messaging.js";

describe("simulated call follow-up payload boundary", () => {
  it.each([
    null,
    {},
    { mode: "meta" },
    { mode: "simulator", template: "other" },
  ])(
    "rejects malformed or real-provider work before querying PostgreSQL",
    async (payload) => {
      const query = vi.fn();
      await expect(
        deliverSimulatedCallFollowup(
          query as unknown as postgres.TransactionSql,
          "job",
          "contact",
          payload,
        ),
      ).rejects.toThrow("invalid simulated follow-up payload");
      expect(query).not.toHaveBeenCalled();
    },
  );
});
