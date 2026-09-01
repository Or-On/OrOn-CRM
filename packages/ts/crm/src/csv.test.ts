import { describe, expect, it } from "vitest";

import { parseContactCsv } from "./csv.js";

describe("contact CSV", () => {
  it("maps supported columns and quoted values", () => {
    expect(
      parseContactCsv(
        'name,phone,email,company\n"Ari, Demo",+972501111111,ari@example.invalid,Lumen',
      ),
    ).toEqual([
      {
        name: "Ari, Demo",
        phone: "+972501111111",
        email: "ari@example.invalid",
        company: "Lumen",
      },
    ]);
  });

  it("requires a name header", () => {
    expect(() => parseContactCsv("phone\n+972501111111")).toThrow(
      /name column/u,
    );
  });
});
