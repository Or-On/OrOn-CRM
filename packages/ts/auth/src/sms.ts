import { Buffer } from "node:buffer";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import postgres from "postgres";

export type StaffSmsPurpose =
  "staff_login" | "staff_enrollment" | "staff_disable";
export interface SmsSender {
  send(input: {
    readonly phone: string;
    readonly code: string;
    readonly purpose: "sign-in" | "enrollment" | "disable";
  }): Promise<void>;
}
export interface SmsChallenge {
  readonly id: string;
  readonly phoneHint: string;
  readonly expiresInSeconds: 300;
}
export class SmsUnavailableError extends Error {
  public constructor() {
    super("SMS verification is unavailable");
    this.name = "SmsUnavailableError";
  }
}
export class SmsChallengeRequiredError extends Error {
  public constructor(public readonly challenge: SmsChallenge) {
    super("SMS verification required");
    this.name = "SmsChallengeRequiredError";
  }
}
export interface StaffSmsAuthentication {
  startLogin(userId: string): Promise<SmsChallenge>;
  finishLogin(
    id: string,
    code: string,
    requestId: string,
  ): Promise<string | undefined>;
}
export function smsCodeDigest(
  id: string,
  code: string,
  pepper: string,
): string {
  if (pepper.length < 32)
    throw new TypeError("SMS OTP pepper must contain at least 32 characters");
  if (!/^[0-9a-f-]{36}$/u.test(id) || !/^\d{6}$/u.test(code))
    throw new TypeError("Invalid verification code");
  return createHmac("sha256", pepper)
    .update(`sms-otp-v1:${id}:${code}`)
    .digest("hex");
}

/** Provider port; tests inject a sender and never call a carrier. */
export function createTwilioSmsSender(
  config: {
    readonly accountSid: string;
    readonly authToken: string;
    readonly fromNumber: string;
  },
  transport: typeof fetch = fetch,
): SmsSender {
  if (
    !/^AC[0-9a-fA-F]{32}$/u.test(config.accountSid) ||
    !config.authToken ||
    !/^\+[1-9]\d{7,14}$/u.test(config.fromNumber)
  )
    throw new SmsUnavailableError();
  return {
    async send({ phone, code, purpose }) {
      if (!/^\+[1-9]\d{7,14}$/u.test(phone) || !/^\d{6}$/u.test(code))
        throw new TypeError("Invalid SMS destination or code");
      try {
        const response = await transport(
          `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: {
              authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              To: phone,
              From: config.fromNumber,
              Body: `Or-On ${purpose} code: ${code}. Expires in 5 minutes. Do not share this code.`,
            }),
          },
        );
        if (!response.ok) throw new SmsUnavailableError();
        const result = (await response.json()) as {
          sid?: unknown;
          status?: unknown;
        };
        if (
          typeof result.sid !== "string" ||
          !/^SM[0-9a-fA-F]{32}$/u.test(result.sid) ||
          !["accepted", "queued", "sending", "sent", "delivered"].includes(
            String(result.status),
          )
        )
          throw new SmsUnavailableError();
      } catch {
        throw new SmsUnavailableError();
      }
    },
  };
}

export class StaffSmsService implements StaffSmsAuthentication {
  readonly #sql;
  public constructor(
    databaseUrl: string,
    private readonly sender: SmsSender | undefined,
    private readonly pepper: string | undefined,
  ) {
    this.#sql = postgres(databaseUrl, {
      max: 2,
      prepare: false,
      connect_timeout: 3,
      idle_timeout: 10,
    });
  }
  public get available(): boolean {
    return this.sender !== undefined && this.pepper !== undefined;
  }
  public async phoneHint(userId: string): Promise<string | undefined> {
    const rows = await this.#sql<
      { phone: string | null }[]
    >`SELECT platform.auth_sms_phone(${userId}::uuid) AS phone`;
    const phone = rows[0]?.phone;
    return phone == null ? undefined : `••••${phone.slice(-4)}`;
  }
  public async startLogin(userId: string): Promise<SmsChallenge> {
    return this.start("staff_login", userId);
  }
  public async start(
    purpose: StaffSmsPurpose,
    userId: string,
    sessionId?: string,
    phone?: string,
  ): Promise<SmsChallenge> {
    if (this.sender === undefined || this.pepper === undefined)
      throw new SmsUnavailableError();
    const id = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const digest = smsCodeDigest(id, code, this.pepper);
    let destination: string;
    try {
      const rows = await this.#sql<
        { phone: string }[]
      >`SELECT platform.auth_start_sms(${id}::uuid,${purpose},${userId}::uuid,${sessionId ?? null}::uuid,${phone ?? null},${digest}) AS phone`;
      if (rows[0] === undefined) throw new SmsUnavailableError();
      destination = rows[0].phone;
    } catch {
      throw new SmsUnavailableError();
    }
    try {
      await this.sender.send({
        phone: destination,
        code,
        purpose:
          purpose === "staff_login"
            ? "sign-in"
            : purpose === "staff_enrollment"
              ? "enrollment"
              : "disable",
      });
    } catch {
      await this.#sql`SELECT platform.auth_sms_delivery(${id}::uuid,false)`;
      throw new SmsUnavailableError();
    }
    await this.#sql`SELECT platform.auth_sms_delivery(${id}::uuid,true)`;
    return {
      id,
      phoneHint: `••••${destination.slice(-4)}`,
      expiresInSeconds: 300,
    };
  }
  public async finishLogin(
    id: string,
    code: string,
    requestId: string,
  ): Promise<string | undefined> {
    return this.complete("staff_login", id, code, requestId);
  }
  public async complete(
    purpose: StaffSmsPurpose,
    id: string,
    code: string,
    requestId: string,
    userId?: string,
    sessionId?: string,
  ): Promise<string | undefined> {
    if (this.pepper === undefined) throw new SmsUnavailableError();
    const digest = smsCodeDigest(id, code, this.pepper);
    const rows = await this.#sql<
      { email: string | null }[]
    >`SELECT platform.auth_complete_sms(${id}::uuid,${purpose},${digest},${userId ?? null}::uuid,${sessionId ?? null}::uuid,${requestId}) AS email`;
    return rows[0]?.email ?? undefined;
  }
  public async close(): Promise<void> {
    await this.#sql.end({ timeout: 2 });
  }
}
