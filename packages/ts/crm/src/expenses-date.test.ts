import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { createExpense } from "./expenses.js";

const input = {
  title: "Synthetic",
  category: "test",
  amount: "1",
  currency: "USD",
};

describe("expense date representation", () => {
  it.each([
    "0000-01-01T00:00:00Z",
    "+010000-01-01T00:00:00Z",
    "-000001-01-01T00:00:00Z",
  ])(
    "rejects unsupported PostgreSQL ISO year %s before writing",
    async (incurredAt) => {
      const sql = vi.fn();
      await expect(
        createExpense(sql as unknown as postgres.TransactionSql, null, {
          ...input,
          incurredAt,
        }),
      ).rejects.toThrow("year from 0001 to 9999");
      expect(sql).not.toHaveBeenCalled();
    },
  );
  it.each([
    "0006-10-04T12:00:00.001Z",
    "2026-10-04T12:00:00.999Z",
    "1969-12-31T23:59:59.999Z",
  ])(
    "maps numeric UTC milliseconds without the driver's historical offset parser: %s",
    async (incurredAt) => {
      const now = new Date("2026-10-04T00:00:00Z");
      const sql = vi.fn().mockResolvedValue([
        {
          id: "expense",
          created_by_user_id: null,
          ...input,
          vendor: null,
          status: "recorded",
          source_kind: "manual",
          source_reference: null,
          notes: null,
          incurred_at_ms: String(new Date(incurredAt).getTime()),
          created_at: now,
          updated_at: now,
        },
      ]);
      const expense = await createExpense(
        sql as unknown as postgres.TransactionSql,
        null,
        { ...input, incurredAt },
      );
      expect(expense.incurredAt).toBe(incurredAt);
    },
  );
});
