import { describe, expect, it } from "vitest";

import { createPostgresProbe } from "../src/index.js";

describe("createPostgresProbe", () => {
  it("rejects non-PostgreSQL runtime databases", () => {
    expect(() => createPostgresProbe("sqlite:///unsafe.db")).toThrow(
      "databaseUrl must use PostgreSQL",
    );
  });
});
