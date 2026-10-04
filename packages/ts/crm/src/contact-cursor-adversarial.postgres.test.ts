import { openOrAttachTicket, listTickets } from "./tickets.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { createContact, listContactPage } from "./contacts.js";
const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing fixture");
  return value;
}
describe.skipIf(!url)(
  "contact cursor PostgreSQL precision and tenant isolation",
  () => {
    it("does not lose same-millisecond contacts across pages or newer interleaved inserts", async () => {
      const target = new URL(required(url));
      if (
        target.hostname !== "127.0.0.1" ||
        target.port !== "55480" ||
        !/^\/oron_(?:ui_preview|crm)_[a-f0-9]+$/u.test(target.pathname)
      )
        throw new Error("owned fictional database required");
      const db = postgres(required(url), { max: 1, prepare: false });
      try {
        await db
          .begin(async (tx) => {
            const actor = randomUUID(),
              tenant = randomUUID(),
              foreign = randomUUID();
            await tx`INSERT INTO public.users(id,email,display_name,status) VALUES(${actor}::uuid,${`${actor}@example.invalid`},'Pagination actor','active')`;
            for (const id of [tenant, foreign]) {
              await tx`INSERT INTO public.tenants(id,name,slug,status) VALUES(${id}::uuid,'Pagination fixture',${`pagination-${id}`},'active')`;
              await tx`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${id}::uuid,${actor}::uuid,'owner')`;
            }
            await tx`SELECT set_config('app.current_tenant',${foreign},true),set_config('app.current_user',${actor},true),set_config('app.current_role','owner',true)`;
            const hidden = await createContact(
              tx,
              actor,
              { name: "Foreign pagination sentinel" },
              { grantChannelConsent: false },
            );
            await tx`SELECT set_config('app.current_tenant',${tenant},true)`;
            const expected: string[] = [];
            for (const [index, micros] of ["900", "800", "700"].entries()) {
              const contact = await createContact(
                tx,
                actor,
                { name: `Pagination ${String(index)}` },
                { grantChannelConsent: false },
              );
              expected.push(contact.id);
              await tx`UPDATE crm.contacts SET created_at=${`2026-09-03T10:00:00.123${micros}Z`}::text::timestamptz,last_activity_at=NULL WHERE id=${contact.id}::uuid`;
            }
            const ticketIds: string[] = [];
            for (const [index, micros] of ["900", "800", "700"].entries()) {
              const result = await openOrAttachTicket(tx, actor, {
                contactId: required(expected[index]),
                subject: "Pagination ticket",
                attachmentKey: `pagination-${randomUUID()}`,
              });
              ticketIds.push(result.ticket.id);
              await tx`UPDATE support.tickets SET last_activity_at=${`2026-09-03T10:00:00.123${micros}Z`}::text::timestamptz WHERE id=${result.ticket.id}::uuid`;
            }
            await tx`SET LOCAL ROLE platform_web`;
            const first = await listContactPage(tx, { limit: 1 });
            expect(first.contacts.map((c) => c.id)).toEqual([expected[0]]);
            const next = required(first.nextCursor ?? undefined);
            // Replay the former Date-truncated cursor against actual microsecond rows.
            expect(
              (
                await listContactPage(tx, {
                  limit: 1,
                  cursor: {
                    ...next,
                    sortAt: new Date(next.sortAt).toISOString(),
                  },
                })
              ).contacts,
            ).toEqual([]);
            const inserted = await createContact(
              tx,
              actor,
              { name: "Newer interleaved insert" },
              { grantChannelConsent: false },
            );
            const second = await listContactPage(tx, {
              limit: 1,
              cursor: next,
            });
            expect(second.contacts.map((c) => c.id)).toEqual([expected[1]]);
            const third = await listContactPage(tx, {
              limit: 1,
              cursor: required(second.nextCursor ?? undefined),
            });
            expect(third.contacts.map((c) => c.id)).toEqual([expected[2]]);
            expect(third.nextCursor).toBeNull();
            expect(
              [...first.contacts, ...second.contacts, ...third.contacts].map(
                (c) => c.id,
              ),
            ).not.toContain(hidden.id);
            expect(
              (await listContactPage(tx, { limit: 1 })).contacts[0]?.id,
            ).toBe(inserted.id);
            const ticketFirst = await listTickets(tx, { limit: 1 });
            expect(ticketFirst.tickets.map((t) => t.id)).toEqual([
              ticketIds[0],
            ]);
            const ticketCursor = required(ticketFirst.nextCursor ?? undefined);
            expect(
              (
                await listTickets(tx, {
                  limit: 1,
                  beforeActivityAt: new Date(
                    ticketCursor.activityAt,
                  ).toISOString(),
                  beforeId: ticketCursor.id,
                })
              ).tickets,
            ).toEqual([]);
            const ticketSecond = await listTickets(tx, {
              limit: 1,
              beforeActivityAt: ticketCursor.activityAt,
              beforeId: ticketCursor.id,
            });
            expect(ticketSecond.tickets.map((t) => t.id)).toEqual([
              ticketIds[1],
            ]);
            const ticketNext = required(ticketSecond.nextCursor ?? undefined);
            const ticketThird = await listTickets(tx, {
              limit: 1,
              beforeActivityAt: ticketNext.activityAt,
              beforeId: ticketNext.id,
            });
            expect(ticketThird.tickets.map((t) => t.id)).toEqual([
              ticketIds[2],
            ]);
            expect(ticketThird.nextCursor).toBeNull();
            throw new RollbackFixture();
          })
          .catch((error: unknown) => {
            if (!(error instanceof RollbackFixture)) throw error;
          });
      } finally {
        await db.end();
      }
    });
  },
);
