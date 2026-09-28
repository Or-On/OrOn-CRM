import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  AuthService,
  createAuthRepository,
  hashPassword,
  InvalidCredentialsError,
  SmsChallengeRequiredError,
  SmsUnavailableError,
  StaffSmsService,
  type SmsChallenge,
} from "./index.js";

const target = process.env.AUTH_TEST_DATABASE_URL;
describe.skipIf(target === undefined)(
  "staff SMS journey against disposable PostgreSQL",
  () => {
    it("requires password then code, preserves technician scope and prevents replay", async () => {
      if (target === undefined)
        throw new Error("AUTH_TEST_DATABASE_URL required");
      const parsed = new URL(target);
      if (
        !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
        !/^\/oron_ui_preview_[0-9a-f]{32}$/u.test(parsed.pathname)
      )
        throw new Error("SMS tests require an owned local fixture database");
      const sql = postgres(target, { max: 1, prepare: false });
      const repository = createAuthRepository(target);
      const tenant = randomUUID(),
        user = randomUUID(),
        email = `${user}@example.invalid`;
      const password = "fictional SMS account password";
      // The workspace also discovers compiled tests; each parallel fixture needs its own destination.
      const phone = `+1555${BigInt(`0x${user.slice(0, 8)}`)
        .toString()
        .padStart(10, "0")}`;
      const pepper = "fictional-sms-test-pepper-with-thirty-two-characters";
      let sent: { phone: string; code: string } | undefined;
      const sms = new StaffSmsService(
        target,
        {
          send: (input) => {
            sent = input;
            return Promise.resolve();
          },
        },
        pepper,
      );
      const service = new AuthService(repository, {
        tokenPepper: pepper,
        dummyPasswordHash: await hashPassword("fictional dummy"),
        sms,
      });
      try {
        await sql`INSERT INTO public.tenants(id,name,slug,status) VALUES(${tenant}::uuid,'Fictional SMS',${`sms-${tenant}`},'active')`;
        await sql`INSERT INTO public.users(id,email,status) VALUES(${user}::uuid,${email},'active')`;
        await sql`INSERT INTO platform.auth_credentials(user_id,password_hash) VALUES(${user}::uuid,${await hashPassword(password)})`;
        await sql`INSERT INTO public.memberships(tenant_id,user_id,role) VALUES(${tenant}::uuid,${user}::uuid,'technician')`;
        const initial = await service.login({
          email,
          password,
          requestId: "sms-initial",
        });
        const enrollment = await sms.start(
          "staff_enrollment",
          user,
          initial.session.sessionId,
          phone,
        );
        expect(enrollment.phoneHint).toBe(`••••${phone.slice(-4)}`);
        expect(JSON.stringify(enrollment)).not.toContain(sent?.code);
        expect(
          await sms.complete(
            "staff_enrollment",
            enrollment.id,
            sent?.code ?? "",
            "sms-enroll",
            user,
            initial.session.sessionId,
          ),
        ).toBe(email);
        await sql`UPDATE platform.sms_otp_challenges SET created_at=created_at-interval '61 seconds',expires_at=expires_at-interval '61 seconds' WHERE id=${enrollment.id}::uuid`;
        await expect(
          service.login({
            email,
            password: "wrong",
            requestId: "sms-wrong-password",
          }),
        ).rejects.toThrow(InvalidCredentialsError);
        let challenge: SmsChallenge | undefined;
        try {
          await service.login({ email, password, requestId: "sms-login" });
        } catch (error) {
          if (!(error instanceof SmsChallengeRequiredError)) throw error;
          challenge = error.challenge;
        }
        if (challenge === undefined || sent === undefined)
          throw new Error("SMS challenge required before session creation");
        const code = sent.code;
        await expect(
          service.finishSmsLogin({
            id: challenge.id,
            code: code === "000000" ? "000001" : "000000",
            requestId: "sms-wrong",
          }),
        ).rejects.toThrow(InvalidCredentialsError);
        const issued = await service.finishSmsLogin({
          id: challenge.id,
          code,
          requestId: "sms-verified",
        });
        expect(service.toPublicSession(issued.session).applicationScope).toBe(
          "field-service",
        );
        expect(issued.session.tenant.role).toBe("technician");
        expect((await service.resolve(issued.sessionToken))?.sessionId).toBe(
          issued.session.sessionId,
        );
        await expect(
          service.finishSmsLogin({
            id: challenge.id,
            code,
            requestId: "sms-replay",
          }),
        ).rejects.toThrow(InvalidCredentialsError);
        const disabled = new AuthService(repository, {
          tokenPepper: pepper,
          dummyPasswordHash: await hashPassword("fictional dummy"),
        });
        await expect(
          disabled.login({ email, password, requestId: "sms-disabled" }),
        ).rejects.toThrow(SmsUnavailableError);
      } finally {
        await sms.close();
        await repository.close();
        await sql`DELETE FROM public.tenants WHERE id=${tenant}::uuid`;
        await sql`DELETE FROM public.users WHERE id=${user}::uuid`;
        await sql.end({ timeout: 2 });
      }
    });
  },
);
