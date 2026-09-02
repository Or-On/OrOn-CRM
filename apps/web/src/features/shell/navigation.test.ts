import { describe, expect, it } from "vitest";
import { activeDestination, findDestinations, navigation } from "./navigation";

describe("operator navigation", () => {
  it("keeps the correct parent active on detail routes", () => {
    expect(activeDestination("/contacts/123")).toBe("/contacts");
    expect(activeDestination("/voice/calls/123")).toBe("/voice");
    expect(activeDestination("/voice/campaigns")).toBe("/voice/campaigns");
    expect(activeDestination("/contactsmith")).toBeUndefined();
    expect(activeDestination("/")).toBe("/");
  });
  it("searches available destinations and excludes deferred Live Lab", () => {
    expect(findDestinations("  INBOX ")).toHaveLength(1);
    expect(findDestinations("no such screen")).toHaveLength(0);
    expect(navigation.some((item) => item.href.includes("live"))).toBe(false);
  });
});
