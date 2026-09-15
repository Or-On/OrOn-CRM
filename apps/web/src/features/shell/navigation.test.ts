import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { activeDestination, findDestinations, navigation } from "./navigation";
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
