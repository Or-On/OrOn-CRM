import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const url = process.env.FAIR_TEST_DATABASE_URL;
describe.skipIf(!url)("durable multi-worker AI admission", () => {
  it("enforces4global2tenant1conversation with concurrent role-limited claimers and preserves fencing", async () => {
    if (!url) throw new Error("Explicit owned fixture required");
    const target = new URL(url);
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_fair_[a-f0-9]{32}$/u.test(target.pathname)
    )
      throw new Error("Independent owned fair fixture only");
    const db = postgres(url, { max: 8, prepare: false });
    const tenants = Array.from({ length: 3 }, () => randomUUID());
    const firstConversations: string[] = [];
    const malformedIds = [randomUUID(), randomUUID()];
    try {
      await db.begin(async (tx) => {
        const user = randomUUID();
        await tx`insert into public.users(id,email,status) values(${user}::uuid,${`${user}@example.invalid`},'active')`;
        for (const tenant of tenants) {
          await tx`insert into public.tenants(id,name,slug,status) values(${tenant}::uuid,'Synthetic admission',${`fair-${tenant}`},'active')`;
          await tx`insert into public.memberships(tenant_id,user_id,role) values(${tenant}::uuid,${user}::uuid,'owner')`;
          await tx`select set_config('app.current_tenant',${tenant},true),set_config('app.current_user',${user},true),set_config('app.current_role','owner',true)`;
          await tx`insert into platform.tenant_remediation_flags(tenant_id,flag_key,enabled) values(${tenant}::uuid,'queue_priority',true)`;
          const channel = randomUUID();
          await tx`insert into messaging.channels(id,tenant_id,kind,provider,display_address,status,configuration) values(${channel}::uuid,${tenant}::uuid,'whatsapp','simulator','Synthetic channel','active','{}')`;
          const conversations: string[] = [];
          for (let index = 0; index < 3; index++) {
            const contact = randomUUID(),
              conversation = randomUUID();
            await tx`insert into crm.contacts(id,tenant_id,created_by_user_id,name,whatsapp_consent) values(${contact}::uuid,${tenant}::uuid,${user}::uuid,'Synthetic contact','granted')`;
            await tx`insert into messaging.conversations(id,tenant_id,channel_id,contact_id,status) values(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open')`;
            conversations.push(conversation);
          }
          const firstConversation = conversations[0];
          if (!firstConversation) throw new Error("Missing first conversation");
          firstConversations.push(firstConversation);
          for (let index = 0; index < 4; index++) {
            const conversation = conversations[Math.max(0, index - 1)];
            if (!conversation) throw new Error("Missing fixture conversation");
            await tx`insert into ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority) values(${tenant}::uuid,'messaging','whatsapp.ai.reply','conversation',${conversation}::uuid,${tx.json({ conversationId: conversation })},${randomUUID()},3,100)`;
          }
        }
      });
      const tenantA = tenants[0],
        conversationA = firstConversations[0],
        conversationB = firstConversations[1];
      if (!tenantA || !conversationA || !conversationB)
        throw new Error("Missing invalid-binding fixture");
      for (const [index, id] of malformedIds.entries()) {
        const reference = index === 0 ? conversationA : conversationB;
        await db`insert into ops.jobs(id,tenant_id,queue,job_type,reference_type,reference_id,payload,idempotency_key,max_attempts,priority) values(${id}::uuid,${tenantA}::uuid,'messaging','whatsapp.ai.reply','conversation',${reference}::uuid,${db.json({ conversationId: conversationB })},${randomUUID()},3,100)`;
      }
      const claim = (worker: string) =>
        db.begin(async (tx) => {
          await tx`set local role platform_messaging`;
          return tx<
            {
              id: string;
              tenant_id: string;
              reference_id: string;
              claim_token: string;
              attempts: number;
            }[]
          >`select * from ops.claim_fair_ai_reply(${worker})`;
        });
      const claims = (
        await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            claim(`synthetic-worker-${String(index)}`),
          ),
        )
      ).flat();
      expect(claims).toHaveLength(4);
      const invalidRows = await db<
        { id: string; status: string; last_error_safe: string }[]
      >`select id,status,last_error_safe from ops.jobs where id=any(${malformedIds}::uuid[])`;
      expect(invalidRows).toHaveLength(2);
      for (const row of invalidRows) {
        expect(row.status).toBe("dead");
        expect(row.last_error_safe).toBe("ai_admission_context_invalid");
      }
      await claim("repeat-invalid-check");
      const audits = await db<
        { target_id: string; count: string }[]
      >`select target_id,count(*) from audit.records where action='job.admission_invalid' and target_id=any(${malformedIds}::uuid[]) group by target_id`;
      expect(audits).toHaveLength(2);
      expect(audits.every((row) => Number(row.count) === 1)).toBe(true);
      expect(
        new Set(claims.map((job) => `${job.tenant_id}:${job.reference_id}`))
          .size,
      ).toBe(4);
      for (const tenant of tenants)
        expect(
          claims.filter((job) => job.tenant_id === tenant).length,
        ).toBeLessThanOrEqual(2);
      expect(new Set(claims.map((job) => job.tenant_id)).size).toBe(3);
      const generic = await db.begin(async (tx) => {
        await tx`set local role platform_messaging`;
        return tx`select id from ops.claim_jobs_all_tenants('synthetic-generic','messaging',100,120)`;
      });
      expect(generic).toHaveLength(0);
      const victim = claims[0];
      if (!victim) throw new Error("No claimed victim");
      await db`update ops.jobs set status='succeeded',completed_at=clock_timestamp(),locked_at=null,locked_by=null,lease_expires_at=null where tenant_id=any(${tenants}::uuid[]) and id<>${victim.id}::uuid`;
      await db`update ops.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${victim.id}::uuid`;
      const replacement = (await claim("synthetic-replacement"))[0];
      expect(replacement?.id).toBe(victim.id);
      expect(replacement?.claim_token).not.toBe(victim.claim_token);
      expect(replacement?.attempts).toBe(2);
      const stale = await db.begin(async (tx) => {
        await tx`set local role platform_messaging`;
        await tx`select set_config('app.current_tenant',${victim.tenant_id},true)`;
        return tx<
          { renewed: boolean }[]
        >`select ops.renew_messaging_job_claim(${victim.id}::uuid,'synthetic-worker-0',${victim.claim_token}::uuid) renewed`;
      });
      expect(stale[0]?.renewed).toBe(false);
      await expect(
        db.begin(async (tx) => {
          await tx`set local role platform_readonly`;
          return tx`select * from ops.claim_fair_ai_reply('unauthorized')`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await db`update platform.tenant_remediation_flags set enabled=false where tenant_id=${victim.tenant_id}::uuid and flag_key='queue_priority'`;
      await db`update ops.jobs set status='queued',lease_expires_at=null,locked_at=null,locked_by=null where id=${victim.id}::uuid`;
      expect(await claim("flag-off")).toHaveLength(0);
      const legacy = await db.begin(async (tx) => {
        await tx`set local role platform_messaging`;
        return tx<
          { id: string }[]
        >`select id from ops.claim_jobs_all_tenants('legacy-default-off','messaging',1,120)`;
      });
      expect(legacy[0]?.id).toBe(victim.id);
    } finally {
      await db.end();
    }
  }, 30000);
});
