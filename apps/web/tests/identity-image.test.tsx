// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  announceIdentityImageUpdate,
  IdentityImage,
} from "../src/features/identity";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IdentityImage", () => {
  it("resets an already loaded logo and changes the private URL when switching tenants", () => {
    const view = render(
      <IdentityImage
        contextKey="tenant-a"
        fallback="A"
        source="/api/settings/logo"
      />,
    );
    const first = view.container.querySelector("img");
    if (!first) throw new Error("Tenant A logo missing");
    fireEvent.load(first);
    expect(first.getAttribute("src")).toContain("context=tenant-a");

    view.rerender(
      <IdentityImage
        contextKey="tenant-b"
        fallback="B"
        source="/api/settings/logo"
      />,
    );
    const second = view.container.querySelector("img");
    if (!second) throw new Error("Tenant B logo missing");
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toContain("context=tenant-b");
    expect(second.hasAttribute("data-loaded")).toBe(false);
    fireEvent.error(second);
    expect(
      view.container.querySelector(".identity-image__fallback")?.textContent,
    ).toBe("B");

    view.rerender(
      <IdentityImage
        contextKey="tenant-a"
        fallback="A"
        source="/api/settings/logo"
      />,
    );
    const returned = view.container.querySelector("img");
    expect(returned).not.toBe(first);
    expect(returned?.getAttribute("src")).toContain("context=tenant-a");
    expect(
      view.container.querySelector(".identity-image__fallback")?.textContent,
    ).toBe("A");
  });

  it("refreshes all copies of the updated tenant logo without changing another tenant", () => {
    const view = render(
      <>
        <IdentityImage
          contextKey="tenant-a"
          fallback="A"
          source="/api/settings/logo"
        />
        <IdentityImage
          contextKey="tenant-a"
          fallback="A"
          source="/api/settings/logo"
        />
        <IdentityImage
          contextKey="tenant-b"
          fallback="B"
          source="/api/settings/logo"
        />
      </>,
    );
    for (const image of view.container.querySelectorAll("img"))
      fireEvent.load(image);
    const other = view.container.querySelector('img[src*="context=tenant-b"]');
    act(() => announceIdentityImageUpdate("/api/settings/logo", "tenant-a"));
    const updated = view.container.querySelectorAll(
      'img[src*="context=tenant-a"]',
    );
    expect(updated).toHaveLength(2);
    for (const image of updated) {
      expect(image.getAttribute("src")).toContain("?v=1&context=tenant-a");
      expect(image.hasAttribute("data-loaded")).toBe(false);
    }
    expect(view.container.querySelector('img[src*="context=tenant-b"]')).toBe(
      other,
    );
    expect(other?.getAttribute("data-loaded")).toBe("true");
    expect(other?.getAttribute("src")).toContain("?v=0&context=tenant-b");
    act(() => announceIdentityImageUpdate("/api/settings/logo", "tenant-a"));
    expect(
      view.container
        .querySelector('img[src*="context=tenant-a"]')
        ?.getAttribute("src"),
    ).toContain("?v=2&context=tenant-a");
  });

  it("recognizes an avatar that loaded before client hydration", async () => {
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    const naturalWidth = vi
      .spyOn(HTMLImageElement.prototype, "naturalWidth", "get")
      .mockReturnValue(256);
    const naturalHeight = vi
      .spyOn(HTMLImageElement.prototype, "naturalHeight", "get")
      .mockReturnValue(256);

    const view = render(
      <>
        <IdentityImage fallback="OR" source="/api/account/avatar" />
        <IdentityImage fallback="OR" source="/api/account/avatar" />
      </>,
    );

    await waitFor(() =>
      expect(
        Array.from(view.container.querySelectorAll(".identity-image")).map(
          (image) => image.getAttribute("data-image-loaded"),
        ),
      ).toEqual(["true", "true"]),
    );
    expect(
      view.container.querySelectorAll(".identity-image__fallback"),
    ).toHaveLength(0);

    complete.mockRestore();
    naturalWidth.mockRestore();
    naturalHeight.mockRestore();
  });

  it("removes fallback initials once the image has loaded", () => {
    const view = render(
      <IdentityImage fallback="OR" source="/api/settings/logo" />,
    );
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Identity image element missing");

    expect(
      view.container.querySelector(".identity-image__fallback")?.textContent,
    ).toBe("OR");
    expect(image.hasAttribute("data-loaded")).toBe(false);

    fireEvent.load(image);

    expect(
      view.container.querySelector(".identity-image__fallback"),
    ).toBeNull();
    expect(image.getAttribute("data-loaded")).toBe("true");
    expect(
      view.container
        .querySelector(".identity-image")
        ?.getAttribute("data-image-loaded"),
    ).toBe("true");
  });

  it("restores fallback initials if the loaded image fails", () => {
    const view = render(
      <IdentityImage fallback="OR" source="/api/settings/logo" />,
    );
    const image = view.container.querySelector("img");
    if (!image) throw new Error("Identity image element missing");

    fireEvent.load(image);
    fireEvent.error(image);

    expect(
      view.container.querySelector(".identity-image__fallback")?.textContent,
    ).toBe("OR");
  });
});
