import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy";

describe("server-rendered locale selection", () => {
  it("overwrites untrusted locale metadata and persists the Hebrew application entry language", () => {
    const response = proxy(
      new NextRequest("https://preview.example.invalid/he", {
        headers: { "x-or-on-locale": "unsupported" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-or-on-locale")).toBe(
      "he",
    );
    expect(
      response.headers.get("x-middleware-request-x-or-on-public-route"),
    ).toBeNull();
    expect(response.cookies.get("or_on_locale")).toMatchObject({
      value: "he",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
  it("uses the selected language on stable application URLs", () => {
    const response = proxy(
      new NextRequest("http://localhost/inbox?conversation=fixture", {
        headers: { cookie: "or_on_locale=he", "x-or-on-locale": "en" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-or-on-locale")).toBe(
      "he",
    );
    expect(
      response.headers.get("x-middleware-request-x-or-on-public-route"),
    ).toBeNull();
    expect(response.headers.get("location")).toBeNull();
  });
  it("removes the obsolete public marker from every application request", () => {
    for (const path of ["/inbox", "/login", "/en/product", "/he/"]) {
      const response = proxy(
        new NextRequest(`http://localhost${path}`, {
          headers: { "x-or-on-public-route": "localized-root" },
        }),
      );
      expect(
        response.headers.get("x-middleware-request-x-or-on-public-route"),
      ).toBeNull();
    }
  });
  it("overwrites caller-supplied page paths with the requested path", () => {
    const response = proxy(
      new NextRequest("http://localhost/profile?tab=security", {
        headers: { "x-or-on-pathname": "/field-service" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-or-on-pathname")).toBe(
      "/profile",
    );
  });
  it("falls back to English for unsupported cookie values", () => {
    const response = proxy(
      new NextRequest("http://localhost/login", {
        headers: { cookie: "or_on_locale=unsupported" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-or-on-locale")).toBe(
      "en",
    );
  });
});
