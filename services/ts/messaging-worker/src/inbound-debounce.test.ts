import { expect, it, vi } from "vitest";
import { queueDebouncedReply } from "./inbound-debounce.js";
import type postgres from "postgres";

it("does not mutate jobs when debounce is absent or disabled", async () => {
  const query = vi.fn().mockResolvedValue([]);
  expect(
    await queueDebouncedReply(query as unknown as postgres.TransactionSql, {
      conversationId: "10000000-0000-4000-8000-000000000001",
      messageId: "20000000-0000-4000-8000-000000000001",
      eventId: "30000000-0000-4000-8000-000000000001",
    }),
  ).toEqual({ handled: false });
  expect(query).toHaveBeenCalledOnce();
});

it("priority flag alone cannot enable debounce", async () => {
  const query = vi.fn().mockResolvedValue([{ flag_key: "queue_priority" }]);
  expect(
    await queueDebouncedReply(query as unknown as postgres.TransactionSql, {
      conversationId: "10000000-0000-4000-8000-000000000001",
      messageId: "20000000-0000-4000-8000-000000000001",
      eventId: "30000000-0000-4000-8000-000000000001",
    }),
  ).toEqual({ handled: false });
  expect(query).toHaveBeenCalledOnce();
});
