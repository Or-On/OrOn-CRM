import { describe, expect, it } from "vitest";
import { activeDestination, findDestinations, navigation } from "./navigation";

describe("operator navigation", () => {
  it("keeps the correct parent active on detail routes", () => {
    expect(activeDestination("/contacts/123")).toBe("/contacts");
    expect(activeDestination("/voice/calls/123")).toBe("/voice");
    expect(activeDestination("/calendar/event/123")).toBe("/calendar");
    expect(activeDestination("/tasks/123")).toBe("/tasks");
    expect(activeDestination("/users/123")).toBe("/users");
    expect(activeDestination("/voice/campaigns")).toBe("/voice");
    expect(activeDestination("/field-service/cases/123")).toBe(
      "/field-service",
    );
    expect(activeDestination("/flows")).toBe("/voice");
    expect(activeDestination("/flows/retained-adapter")).toBe("/voice");
    expect(activeDestination("/contactsmith")).toBeUndefined();
    expect(activeDestination("/")).toBe("/");
  });
  it("searches available destinations and excludes deferred Live Lab", () => {
    expect(findDestinations("  INBOX ")).toHaveLength(1);
    expect(findDestinations("no such screen")).toHaveLength(0);
    expect(navigation.some((item) => item.href.includes("live"))).toBe(false);
    expect(navigation.map((item) => item.href)).toEqual([
      "/",
      "/inbox",
      "/email",
      "/calendar",
      "/tasks",
      "/contacts",
      "/pipelines",
      "/field-service",
      "/operations",
      "/voice",
      "/orchestration",
      "/finance",
      "/profile",
      "/users",
      "/roles",
      "/tenants",
      "/system/health",
      "/settings",
    ]);
  });
});
