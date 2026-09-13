// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return (
    (channels[0] ?? 0) * 0.2126 +
    (channels[1] ?? 0) * 0.7152 +
    (channels[2] ?? 0) * 0.0722
  );
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("semantic text contrast", () => {
  for (const selector of [":root", '[data-theme="light"]']) {
    it(`keeps enabled text and primary buttons at AA contrast in ${selector}`, () => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThanOrEqual(0);
      const block = css.slice(start, css.indexOf("}", start));
      const token = (name: string) => {
        const match = new RegExp(`--or-${name}: (#[0-9a-f]{6});`, "i").exec(
          block,
        );
        if (!match?.[1])
          throw new Error(`Missing literal semantic color: ${name}`);
        return match[1];
      };
      for (const text of [
        "text",
        "text-secondary",
        "text-muted",
        "accent",
        "info",
        "positive",
        "warning",
        "critical",
      ]) {
        for (const surface of [
          "bg",
          "surface",
          "surface-raised",
          "surface-floating",
          "surface-hover",
        ]) {
          expect(
            contrast(token(text), token(surface)),
            `${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const action of ["action", "action-hover"]) {
        expect(
          contrast(token("on-accent"), token(action)),
          action,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
