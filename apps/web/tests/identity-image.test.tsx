// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentityImage } from "../src/features/identity";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("IdentityImage", () => {
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
