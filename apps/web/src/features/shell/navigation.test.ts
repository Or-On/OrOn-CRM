import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  activeDestination,
  contextualDestinations,
  findDestinations,
  navigation,
} from "./navigation";
import {
  applicationPageManifest,
  isApplicationPageHref,
} from "./route-manifest";

const appDirectory = fileURLToPath(new URL("../../app", import.meta.url));

function discoveredPageRoutes(directory = appDirectory): readonly string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) routes.push(...discoveredPageRoutes(path));
    else if (entry.name === "page.tsx") {
      const folder = relative(appDirectory, dirname(path)).split(sep).join("/");
      routes.push(folder === "" ? "/" : `/${folder}`);
    }
  }
  return routes;
}

describe("operator navigation", () => {
  it("keeps the correct parent active only on real detail routes", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    expect(activeDestination(`/contacts/${id}`)).toBe("/contacts");
    expect(activeDestination(`/voice/calls/${id}`)).toBe("/voice");
    expect(activeDestination("/voice/campaigns")).toBe("/voice");
    expect(activeDestination(`/field-service/cases/${id}`)).toBe(
      "/field-service",
    );
    expect(activeDestination(`/field-service/reports/${id}`)).toBe(
      "/field-service",
    );
    expect(activeDestination("/flows")).toBe("/voice");
    expect(activeDestination("/calendar/event/123")).toBeUndefined();
    expect(activeDestination("/tasks/123")).toBeUndefined();
    expect(activeDestination("/users/123")).toBeUndefined();
    expect(activeDestination("/flows/retained-adapter")).toBeUndefined();
    expect(activeDestination("/contactsmith")).toBeUndefined();
    expect(activeDestination("/")).toBe("/");
  });
  it("matches the checked-in route manifest to every real app page", () => {
    expect([...discoveredPageRoutes()].sort()).toEqual(
      applicationPageManifest.map(({ template }) => template).sort(),
    );
  });
  it("recognizes actual generated links and rejects hypothetical screens", () => {
    const id = "10000000-0000-4000-8000-000000000001";
    const generated = [
      ...navigation.map(({ href }) => href),
      `/contacts/${id}`,
      `/voice/calls/${id}`,
      `/field-service/cases/${id}`,
      `/field-service/reports/${id}`,
      "/field-service/reports",
      "/field-service/ocr",
    ];
    expect(generated.every(isApplicationPageHref)).toBe(true);
    expect(isApplicationPageHref("/tasks/123")).toBe(false);
    expect(isApplicationPageHref("/users/123")).toBe(false);
    expect(isApplicationPageHref("/field-service/unknown")).toBe(false);
    expect(isApplicationPageHref("https://example.invalid/contacts/1")).toBe(
      false,
    );
  });
  it("promotes Tickets without stranding legacy Tasks links", () => {
    // Tickets is the customer-facing issue register and owns the primary slot;
    // crm.tasks keeps its route, rows, permissions and deep links and becomes
    // an internal work list beneath it.
    expect(navigation.map((item) => item.href)).toContain("/tickets");
    expect(navigation.map((item) => item.href)).not.toContain("/tasks");
    expect(activeDestination("/tasks")).toBe("/tickets");
    expect(activeDestination("/tickets")).toBe("/tickets");
    expect(
      activeDestination("/tickets/11111111-1111-4111-8111-111111111111"),
    ).toBe("/tickets");
    expect(isApplicationPageHref("/tasks")).toBe(true);
  });

  it("gives Leads its own primary destination and detail route", () => {
    // A lead is not a contact property and not a ticket: it needs a register of
    // its own, and a deep link to one lead has to highlight that register.
    const id = "22222222-2222-4222-8222-222222222222";
    expect(navigation.map((item) => item.href)).toContain("/leads");
    expect(activeDestination("/leads")).toBe("/leads");
    expect(activeDestination(`/leads/${id}`)).toBe("/leads");
    expect(isApplicationPageHref(`/leads/${id}`)).toBe(true);
    expect(isApplicationPageHref("/leads/unknown/deeper")).toBe(false);
    // Promoting Leads must not demote anything that was already primary.
    for (const href of [
      "/tickets",
      "/contacts",
      "/pipelines",
      "/orchestration",
    ])
      expect(navigation.map((item) => item.href)).toContain(href);
  });

  it("scopes each contextual destination to the module that owns it", () => {
    // parentHref used to be ignored, which put every subroute under Voice.
    const parents = new Set(
      contextualDestinations.map((item) => item.parentHref),
    );

    expect(parents).toEqual(new Set(["/tickets", "/voice"]));
    for (const item of contextualDestinations)
      expect(navigation.map(({ href }) => href)).toContain(item.parentHref);
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
      "/tickets",
      "/leads",
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
