import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseAgentGoldenEvaluationStatuses,
  requestAgentGoldenEvaluation,
} from "./agent-quality-gate.js";
import type postgres from "postgres";

const status = () => ({
  id: randomUUID(),
  datasetId: randomUUID(),
  state: "blocked",
  createdAt: "2026-10-03T00:00:00.000Z",
  completedAt: null,
  expiresAt: "2026-10-04T00:00:00.000Z",
  hasAcceptedReceipt: false,
});

describe("trusted golden status and request boundary", () => {
  it("returns status only and strips arbitrary score/model claims", () => {
    const row = status();
    expect(
      parseAgentGoldenEvaluationStatuses([
        {
          ...row,
          score: 100,
          providerSaysPassed: true,
          response: "fake action",
        },
      ]),
    ).toEqual([row]);
  });
  it("rejects malformed, oversized or inconsistent receipt status", () => {
    for (const value of [
      {},
      Array.from({ length: 51 }, status),
      [{ ...status(), hasAcceptedReceipt: true }],
      [{ ...status(), state: "client_approved" }],
      [{ ...status(), id: "foreign/arbitrary" }],
      [{ ...status(), createdAt: "invalid" }],
    ])
      expect(() => parseAgentGoldenEvaluationStatuses(value)).toThrow();
  });
  it("rejects client scores and receipts before touching the database", async () => {
    const sql = (() => {
      throw Error("database must not be touched for rejected input");
    }) as unknown as postgres.TransactionSql;
    await expect(
      requestAgentGoldenEvaluation(sql, randomUUID(), {
        versionId: randomUUID(),
        datasetId: randomUUID(),
        passed: true,
      }),
    ).rejects.toThrow("identifiers only");
  });
});
