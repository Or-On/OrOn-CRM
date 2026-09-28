import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createTwilioSmsSender,
  SmsUnavailableError,
  smsCodeDigest,
} from "./sms.js";

const id = "10000000-0000-4000-8000-000000000001";
const pepper = "fictional-sms-pepper-with-thirty-two-characters";

describe("SMS verification provider port", () => {
  it("binds a code to its challenge using an independent HMAC secret", () => {
    const expected = createHmac("sha256", pepper)
      .update(`sms-otp-v1:${id}:012345`)
      .digest("hex");
    expect(smsCodeDigest(id, "012345", pepper)).toBe(expected);
    expect(smsCodeDigest(id, "012346", pepper)).not.toBe(expected);
    expect(() => smsCodeDigest(id, "12345", pepper)).toThrow(TypeError);
    expect(() => smsCodeDigest(id, "012345", "short")).toThrow(TypeError);
  });
  it("uses the fixed SMS endpoint, form encoding and no automatic retry", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ sid: `SM${"a".repeat(32)}`, status: "queued" }),
      );
    const sender = createTwilioSmsSender(
      {
        accountSid: `AC${"a".repeat(32)}`,
        authToken: "fictional-token",
        fromNumber: "+12025550101",
      },
      transport,
    );
    await sender.send({
      phone: "+12025550102",
      code: "012345",
      purpose: "sign-in",
    });
    expect(transport).toHaveBeenCalledOnce();
    const call = transport.mock.calls[0];
    if (call === undefined) throw new Error("SMS transport was not called");
    const [url, options] = call;
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/AC${"a".repeat(32)}/Messages.json`,
    );
    expect(options?.redirect).toBe("error");
    if (!(options?.body instanceof URLSearchParams))
      throw new Error("SMS body must be form encoded");
    expect(options.body.get("To")).toBe("+12025550102");
    expect(options.body.get("Body")).toContain("012345");
  });
  it("redacts carrier errors and does not claim a code was sent", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ message: "sensitive provider body" }, { status: 429 }),
      );
    const sender = createTwilioSmsSender(
      {
        accountSid: `AC${"a".repeat(32)}`,
        authToken: "fictional-token",
        fromNumber: "+12025550101",
      },
      transport,
    );
    await expect(
      sender.send({
        phone: "+12025550102",
        code: "012345",
        purpose: "enrollment",
      }),
    ).rejects.toThrow(new SmsUnavailableError());
    expect(transport).toHaveBeenCalledOnce();
  });
});
