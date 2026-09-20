import { describe, expect, it } from "vitest";
import { tenantBusinessContext } from "./tenant-business-context.js";

describe("tenant business context", () => {
  it("preserves full accepted prose and excludes unrelated settings and caller records", () => {
    const businessDescription = "Description\n" + "א".repeat(11_900);
    const productsAndServices = ["Service\n" + "x".repeat(3_900)];
    expect(
      tenantBusinessContext({
        businessDescription,
        productsAndServices,
        callerPhone: "+12025550000",
        tool_permissions: ["ticket.open"],
        privateNotes: "Never include this",
        authorizedAffiliations: ["Other"],
      }),
    ).toEqual({ businessDescription, productsAndServices });
  });
  it("rejects invalid or oversized facts rather than silently truncating them", () => {
    for (const profile of [
      { businessDescription: "x".repeat(12_001) },
      { productsAndServices: ["x".repeat(4_001)] },
      { productsAndServices: Array<string>(65).fill("x") },
      { productsAndServices: Array<string>(9).fill("א".repeat(4_000)) },
      { productsAndServices: [123] },
    ])
      expect(() => tenantBusinessContext(profile)).toThrow(TypeError);
  });
  it("omits absent legacy business prose", () => {
    for (const profile of [undefined, null, {}, { businessDescription: null }])
      expect(tenantBusinessContext(profile)).toBeUndefined();
  });
});
