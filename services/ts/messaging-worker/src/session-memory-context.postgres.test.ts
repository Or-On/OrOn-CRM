import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { loadSessionMemoryContext } from "./session-memory-context.js";

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture value missing");
  return value;
}

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("trusted session context PostgreSQL", () => {
  it("default off, shadow empty, human/contact/tenant mismatch denied, twenty customer turns only", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:ui_preview|crm|knowledge)_[a-f0-9]+$/u.test(target.pathname)
    )
      throw new Error("owned synthetic database required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (sql) => {
          const agents = await sql<{ id: string; tenant_id: string }[]>`
          SELECT id,tenant_id FROM agents.agent_profile_versions
          WHERE published_at IS NOT NULL AND validation_status='valid' LIMIT 1`;
          if (!agents[0]) throw new Error("fictional published agent required");
          const tenant = agents[0].tenant_id,
            agent = agents[0].id;
          const contact = randomUUID(),
            channel = randomUUID(),
            conversation = randomUUID();
          await sql`SELECT set_config('app.current_tenant',${tenant},true)`;
          const owners = await sql<
            { user_id: string }[]
          >`SELECT user_id FROM public.memberships
            WHERE tenant_id=${tenant}::uuid AND role='owner' LIMIT 1`;
          if (!owners[0]) throw new Error("fictional owner required");
          await sql`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional context')`;
          await sql`INSERT INTO messaging.channels(id,tenant_id,kind,provider,display_address,provider_account_id,status)
          VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','simulator','Fictional context',${channel},'active')`;
          await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status,
            ownership_mode,ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at)
          VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open',
            'ai',${agent}::uuid,${owners[0].user_id}::uuid,clock_timestamp())`;
          const messageIds: string[] = [];
          for (let index = 0; index < 25; index++) {
            const id = randomUUID();
            messageIds.push(id);
            await sql`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,content_text,status,created_at)
            VALUES(${id}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','text',${`customer-${String(index)}`},'received',clock_timestamp())`;
          }
          await sql`INSERT INTO messaging.messages(tenant_id,conversation_id,direction,sender_type,content_type,content_text,status)
          VALUES(${tenant}::uuid,${conversation}::uuid,'outbound','agent','text','Invented CRM action completed','sent')`;
          const scope = {
            tenantId: tenant,
            conversationId: conversation,
            contactId: contact,
            agentVersionId: agent,
            latestTriggerMessageId: required(messageIds[24]),
          };
          await sql`SET LOCAL ROLE platform_messaging`;
          expect(
            (await loadSessionMemoryContext(sql, scope)).sessionId,
          ).toBeNull();
          await sql`RESET ROLE`;
          await sql`INSERT INTO platform.tenant_remediation_flags(tenant_id,flag_key,enabled)
          VALUES(${tenant}::uuid,'session_memory',true) ON CONFLICT(tenant_id,flag_key) DO UPDATE SET enabled=true`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const shadow = await loadSessionMemoryContext(sql, scope);
          expect(shadow.context).toBe("");
          expect(shadow.sessionId).toBeTruthy();
          const active = await loadSessionMemoryContext(sql, scope, {
            shadow: false,
          });
          expect(active.turnIds).toHaveLength(20);
          expect(active.shadow).toBe(true);
          expect(active.context).toBe("");
          expect(active.context).not.toContain("Invented");
          expect(
            (
              await loadSessionMemoryContext(
                sql,
                { ...scope, tenantId: randomUUID() },
                { shadow: false },
              )
            ).context,
          ).toBe("");
          expect(
            (
              await loadSessionMemoryContext(
                sql,
                { ...scope, contactId: randomUUID() },
                { shadow: false },
              )
            ).context,
          ).toBe("");
          await sql`RESET ROLE`;
          // Explicitly synthetic trusted-controller input exercises the real gate
          // on this owned rollback fixture; it is not fifty production reviews.
          await sql`SELECT set_config('app.current_user',${owners[0].user_id},true)`;
          for (let index = 0; index < 50; index++) {
            const request = randomUUID();
            await sql`INSERT INTO agents.memory_summary_requests(id,tenant_id,channel,session_id,agent_version_id,conversation_id,actor_id,watermark,source_ids,state,summary_text)
              VALUES(${request}::uuid,${tenant}::uuid,'whatsapp',${active.sessionId}::uuid,${agent}::uuid,${conversation}::uuid,${owners[0].user_id}::uuid,${randomUUID()}::uuid,${[required(messageIds[24])]}::uuid[],'complete','Clearly synthetic controller gate fixture')`;
            await sql`SET LOCAL ROLE platform_memory_review_controller`;
            await sql`SELECT agents.attest_real_memory_source(${request}::uuid,${"a".repeat(64)})`;
            await sql`RESET ROLE`;
            await sql`SET LOCAL ROLE platform_web`;
            await sql`SELECT agents.review_memory_summary(${request}::uuid,true)`;
            await sql`RESET ROLE`;
          }
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT agents.activate_reviewed_memory()`;
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const productionDefault = await loadSessionMemoryContext(sql, scope);
          expect(productionDefault.shadow).toBe(false);
          expect(productionDefault.context).toContain("customer-24");
          expect(
            (await loadSessionMemoryContext(sql, scope, { shadow: true }))
              .context,
          ).toBe("");
          const factRows = await sql<
            { id: string }[]
          >`SELECT agents.write_customer_memory_fact(${active.sessionId}::uuid,${required(messageIds[24])}::uuid,'city','customer-24') id`;
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT agents.correct_customer_memory_fact(${required(factRows[0]).id}::uuid,'CorrectCity','Synthetic operator correction')`;
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const corrected = await loadSessionMemoryContext(sql, scope);
          expect(corrected.context).toContain("CorrectCity");
          expect(corrected.context).not.toContain("customer-24");
          expect(corrected.context).not.toContain("customer-24");
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_web`;
          await sql`SELECT agents.correct_customer_memory_fact(${required(factRows[0]).id}::uuid,NULL,'Synthetic operator deletion')`;
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const deleted = await loadSessionMemoryContext(sql, scope);
          expect(deleted.context).toContain("Operator deleted");
          expect(deleted.context).not.toContain("CorrectCity");
          expect(deleted.context).not.toContain("customer-24");
          await sql`RESET ROLE`;
          await sql`UPDATE platform.tenant_remediation_flags SET enabled=false WHERE tenant_id=${tenant}::uuid AND flag_key='session_memory'`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const disabledCorrected = await loadSessionMemoryContext(sql, scope);
          expect(disabledCorrected.context).toBe("");
          expect(disabledCorrected.correctionsPresent).toBe(true);

          expect(deleted.context).not.toContain("customer-24");
          await sql`RESET ROLE`;
          await sql`UPDATE messaging.conversations SET ownership_mode='human' WHERE id=${conversation}::uuid`;
          await sql`SET LOCAL ROLE platform_messaging`;
          expect(
            (await loadSessionMemoryContext(sql, scope, { shadow: false }))
              .sessionId,
          ).toBeNull();
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end();
    }
  });
});
