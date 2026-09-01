import { verifyServiceAssertion, type AssertionIdentity } from "@or-on/auth";

export async function validateLiveAgentGrant(
  token: string,
  serviceSecret: string,
): Promise<AssertionIdentity> {
  const assertion = await verifyServiceAssertion({
    audience: "live-agent",
    secret: serviceSecret,
    token,
  });
  if (assertion.capability !== "live-session") {
    throw new TypeError("live-agent grant does not allow a live session");
  }
  return assertion;
}
