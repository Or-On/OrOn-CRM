import postgres from "postgres";
import { describe, expect, it } from "vitest";

import {
  createSimulatorBroadcast,
  enqueueSimulatorBroadcast,
} from "@or-on/crm";

import { createMessagingStore } from "../src/database.js";

const databaseUrl = process.env.MESSAGING_WORKER_TEST_DATABASE_URL;
const tenantId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000001";

describe.skipIf(databaseUrl === undefined)("durable messaging worker", () => {
  it("claims and completes simulator broadcast recipients idempotently", async () => {
    if (databaseUrl === undefined)
      throw new Error("MESSAGING_WORKER_TEST_DATABASE_URL is required");
    const admin = postgres(databaseUrl, { max: 1, prepare: false });
    let broadcastId: string | undefined;
    try {
      broadcastId = (await admin.begin(async (transaction) => {
        await transaction`
          SELECT set_config('app.current_tenant', ${tenantId}, true),
                 set_config('app.current_user', ${userId}, true),
                 set_config('app.current_role', 'owner', true)
        `;
        const id = await createSimulatorBroadcast(
          transaction,
          userId,
          "Fictional durable worker test",
          "Simulator-only durable delivery",
        );
        expect(
          await enqueueSimulatorBroadcast(transaction, id),
        ).toBeGreaterThan(0);
        return id;
      })) as string;

      const store = createMessagingStore(databaseUrl, "phase4-live-worker");
      try {
        expect(await store.processAvailable()).toBeGreaterThan(0);
        expect(await store.processAvailable()).toBe(0);
      } finally {
        await store.close();
      }
      const rows = await admin<
        { status: string; delivered_count: number; total_recipients: number }[]
      >`
        SELECT status, delivered_count, total_recipients
        FROM messaging.broadcasts WHERE id = ${broadcastId}::uuid
      `;
      expect(rows[0]?.status).toBe("sent");
      expect(rows[0]?.delivered_count).toBeGreaterThan(0);
    } finally {
      if (broadcastId !== undefined) {
        await admin`
          DELETE FROM ops.jobs WHERE payload ->> 'broadcastId' = ${broadcastId}
        `;
        await admin`
          DELETE FROM platform.campaigns WHERE id = ${broadcastId}::uuid
             OR id = (SELECT campaign_id FROM messaging.broadcasts WHERE id = ${broadcastId}::uuid)
        `;
      }
      await admin.end({ timeout: 2 });
    }
  });
});
