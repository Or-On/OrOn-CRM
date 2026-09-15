import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { whatsappMediaFieldServiceProjectionEnabled } from "./database.js";

describe("WhatsApp media optional projection policy", () => {
  it("rechecks both the live Field Service entitlement and intake switch", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          available: true,
          enabled: true,
          whatsapp_intake_enabled: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          available: true,
          enabled: true,
          whatsapp_intake_enabled: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          available: false,
          enabled: true,
          whatsapp_intake_enabled: true,
        },
      ]);
    const sql = query as unknown as postgres.TransactionSql;

    await expect(whatsappMediaFieldServiceProjectionEnabled(sql)).resolves.toBe(
      true,
    );
    await expect(whatsappMediaFieldServiceProjectionEnabled(sql)).resolves.toBe(
      false,
    );
    await expect(whatsappMediaFieldServiceProjectionEnabled(sql)).resolves.toBe(
      false,
    );
    expect(query).toHaveBeenCalledTimes(3);
  });
});
