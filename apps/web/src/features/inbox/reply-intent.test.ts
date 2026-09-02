import { describe, expect, it } from "vitest";
import {
  emptyReply,
  ReplyIntentKeys,
  templateParameters,
} from "./reply-intent";
import { responsePayload } from "../crm";

describe("reply intent and recovery", () => {
  it("binds keys to recipient, provider configuration and content", () => {
    const keys = new ReplyIntentKeys();
    const first = keys.get("a", "sender", emptyReply);
    expect(keys.get("a", "sender", { ...emptyReply })).toBe(first);
    expect(keys.get("b", "sender", emptyReply)).not.toBe(first);
    expect(keys.get("a", "other-sender", emptyReply)).not.toBe(first);
    expect(
      keys.get("a", "sender", { ...emptyReply, text: "Changed" }),
    ).not.toBe(first);
    keys.complete("a", "sender", emptyReply);
    expect(keys.get("a", "sender", emptyReply)).not.toBe(first);
  });
  it("never silently collapses template parameter positions", () => {
    expect(templateParameters(" hello | world ")).toEqual(["hello", "world"]);
    expect(templateParameters("")).toEqual([]);
    expect(() => templateParameters("hello || world")).toThrow(
      "empty positions",
    );
  });
  it("turns HTML and malformed JSON into safe recovery messages", async () => {
    await expect(
      responsePayload(
        new Response("<html>private proxy output</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).rejects.toThrow("unexpected response");
    await expect(
      responsePayload(
        new Response("broken", {
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("could not be read");
  });
});
