import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type * as CrmModule from "@or-on/crm";
import type * as AuthModule from "@or-on/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  submit: vi.fn(),
  context: vi.fn(),
  failCommit: false,
  commitFailureCount: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@or-on/crm", async (importOriginal) => ({
  ...(await importOriginal<typeof CrmModule>()),
  readDigitalServiceForm: state.read,
  submitDigitalServiceForm: state.submit,
}));
vi.mock("@or-on/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthModule>()),
  withProcessDatabase: async (
    _url: string,
    operation: (sql: {
      begin: (
        work: (sql: typeof state.context) => Promise<unknown>,
      ) => Promise<unknown>;
    }) => Promise<unknown>,
  ) =>
    operation({
      begin: async (work) => {
        const result = await work(state.context);
        if (
          (state.failCommit || state.commitFailureCount > 0) &&
          state.submit.mock.calls.length
        ) {
          state.commitFailureCount = Math.max(0, state.commitFailureCount - 1);
          throw new Error("Fictional database commit failure");
        }
        return result;
      },
    }),
}));
vi.mock("../src/features/auth", () => ({
  ForbiddenError: class ForbiddenError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  assertAuthenticatedMutation: () => {
    throw new Error("Public route must not use ambient session");
  },
}));
import { GET, POST } from "../src/app/api/service-request/route";

const tenant = "11111111-1111-4111-8111-111111111111",
  token = "a".repeat(64);
const origin = "https://service.example.invalid";
const details = {
  intakeId: "22222222-2222-4222-8222-222222222222",
  businessName: "Fictional ProTouch",
  customerName: "Fictional name",
  faultDescription: "Fictional fault",
  photoRequired: false,
  submitted: false,
  reference: null,
};
const tempPrefix = join(tmpdir(), "oron-service-route-");
let directory = "";
const headers = () => ({
  Authorization: `Bearer ${token}`,
  "X-Service-Tenant": tenant,
  Origin: origin,
});
// Structural 16×16 PNG accepted by the shared image validator. No customer photo.
function png() {
  const bytes = Buffer.alloc(45);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(16, 16);
  bytes.writeUInt32BE(16, 20);
  bytes.write("IEND", 37);
  return bytes;
}
function form() {
  const data = new FormData();
  data.set("customerName", "Fictional customer");
  data.set("faultDescription", "Free-text fictional fault");
  data.set("serviceLocation", "Fictional location");
  data.set("confirmed", "true");
  return data;
}
function request(
  body: FormData = form(),
  override: Record<string, string> = {},
) {
  return new Request(`${origin}/api/service-request`, {
    method: "POST",
    headers: { ...headers(), ...override },
    body,
  });
}
async function files() {
  return (
    await readdir(directory, { recursive: true, withFileTypes: true })
  ).filter((entry) => entry.isFile());
}
beforeEach(async () => {
  directory = await mkdtemp(tempPrefix);
  vi.stubEnv("PUBLIC_SITE_URL", origin);
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://fictional:fictional@127.0.0.1/fixture",
  );
  vi.stubEnv("ARTIFACTS_LOCAL_ROOT", directory);
  vi.stubEnv("ARTIFACTS_BACKEND", "local");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Provider access forbidden");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  state.read.mockReset().mockResolvedValue(details);
  state.submit
    .mockReset()
    .mockResolvedValue({ reference: "SVC-FICTIONAL", created: true });
  state.context.mockReset().mockResolvedValue([]);
  state.failCommit = false;
  state.commitFailureCount = 0;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const absolute = resolve(directory);
  if (!absolute.startsWith(resolve(tempPrefix)))
    throw new Error("Unexpected fixture cleanup target");
  await rm(absolute, { recursive: true, force: true });
});

describe("public digital service HTTP boundary", () => {
  it("authorizes the fragment-derived headers, narrows tenant context, and never exposes intake ID", async () => {
    const response = await GET(
      new Request(`${origin}/api/service-request`, { headers: headers() }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...details, intakeId: undefined });
    expect(state.read).toHaveBeenCalledWith(expect.anything(), token);
    expect(state.context.mock.calls[0]?.slice(1)).toEqual([tenant]);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it.each([
    {},
    { Authorization: `Bearer ${token}` },
    { "X-Service-Tenant": tenant },
    { Authorization: "Bearer not-valid", "X-Service-Tenant": tenant },
  ])("refuses invalid capabilities before DB (%j)", async (supplied) => {
    const response = await GET(
      new Request(
        `${origin}/api/service-request?token=${token}&tenant=${tenant}`,
        { headers: supplied },
      ),
    );
    expect(response.status).toBe(404);
    expect(state.read).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(token);
  });
  it("refuses a forged origin before reading capability or buffering an upload", async () => {
    const response = await POST(
      request(form(), { Origin: "https://foreign.example.invalid" }),
    );
    expect(response.status).toBe(403);
    expect(state.read).not.toHaveBeenCalled();
    expect(await files()).toEqual([]);
  });
  it("refuses an expired capability before buffering the body", async () => {
    state.read.mockResolvedValue(null);
    const body = form();
    body.set("photos", new File([png()], "fault.png", { type: "image/png" }));
    expect((await POST(request(body))).status).toBe(404);
    expect(await files()).toEqual([]);
    expect(state.submit).not.toHaveBeenCalled();
  });
  it.each(["missing", "duplicate"])(
    "requires a single explicit confirmation (%s)",
    async (kind) => {
      const data = form();
      if (kind === "missing") data.delete("confirmed");
      else data.append("confirmed", "true");
      expect((await POST(request(data))).status).toBe(400);
      expect(state.submit).not.toHaveBeenCalled();
    },
  );
  it("rejects declared-image content with a mismatched signature and clears earlier staging", async () => {
    const data = form();
    data.append(
      "photos",
      new File([png()], "valid.png", { type: "image/png" }),
    );
    data.append(
      "photos",
      new File(["<script>not a photo</script>"], "fake.png", {
        type: "image/png",
      }),
    );
    expect((await POST(request(data))).status).toBe(400);
    expect(state.submit).not.toHaveBeenCalled();
    expect(await files()).toEqual([]);
  });
  it.each(["count", "type", "empty", "size"])(
    "rejects invalid photo limits before submission (%s)",
    async (kind) => {
      const data = form();
      for (let index = 0; index < (kind === "count" ? 6 : 1); index++)
        data.append(
          "photos",
          new File(
            [
              kind === "empty"
                ? new Uint8Array()
                : kind === "size"
                  ? new Uint8Array(20 * 1024 * 1024 + 1)
                  : png(),
            ],
            "upload",
            { type: kind === "type" ? "image/svg+xml" : "image/png" },
          ),
        );
      expect((await POST(request(data))).status).toBe(400);
      expect(state.submit).not.toHaveBeenCalled();
      expect(await files()).toEqual([]);
    },
  );
  it("commits valid private photos only with the created receipt", async () => {
    const data = form();
    data.append(
      "photos",
      new File([png()], "fault.png", { type: "image/png" }),
    );
    const response = await POST(request(data));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      reference: "SVC-FICTIONAL",
      created: true,
    });
    const stored = await files();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name.endsWith(".png")).toBe(true);
    expect(state.submit).toHaveBeenCalledWith(
      expect.anything(),
      token,
      expect.objectContaining({
        faultDescription: "Free-text fictional fault",
        confirmed: true,
        photos: [
          expect.objectContaining({ contentType: "image/png", byteSize: 45 }),
        ],
      }),
    );
  });
  it("preserves promoted photos if COMMIT acknowledgement and reconciliation are unavailable", async () => {
    state.failCommit = true;
    const data = form();
    data.append(
      "photos",
      new File([png()], "fault.png", { type: "image/png" }),
    );
    expect((await POST(request(data))).status).toBe(503);
    expect(await files()).toHaveLength(1);
  });
  it("returns the committed reference after lost COMMIT acknowledgement without deleting photos", async () => {
    state.commitFailureCount = 1;
    state.read.mockResolvedValueOnce(details).mockResolvedValue({
      ...details,
      submitted: true,
      reference: "SVC-COMMITTED",
    });
    const data = form();
    data.append(
      "photos",
      new File([png()], "fault.png", { type: "image/png" }),
    );
    const response = await POST(request(data));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reference: "SVC-COMMITTED",
      created: false,
    });
    expect(await files()).toHaveLength(1);
  });
  it("preserves promoted photos even when a fresh read does not yet observe the submission", async () => {
    state.commitFailureCount = 1;
    const data = form();
    data.append(
      "photos",
      new File([png()], "fault.png", { type: "image/png" }),
    );
    expect((await POST(request(data))).status).toBe(503);
    expect(await files()).toHaveLength(1);
  });
  it("discards staged photos when submission fails before the callback completes", async () => {
    state.submit.mockRejectedValue(
      new Error("Fictional transaction callback failure"),
    );
    const data = form();
    data.append(
      "photos",
      new File([png()], "fault.png", { type: "image/png" }),
    );
    expect((await POST(request(data))).status).toBe(503);
    expect(await files()).toEqual([]);
  });
  it("cleans unused photos for a duplicate concurrent submission and returns the same reference", async () => {
    let calls = 0;
    state.submit.mockImplementation(() =>
      Promise.resolve({ reference: "SVC-SAME", created: ++calls === 1 }),
    );
    const make = () => {
      const data = form();
      data.append(
        "photos",
        new File([png()], "fault.png", { type: "image/png" }),
      );
      return request(data);
    };
    const responses = await Promise.all([POST(make()), POST(make())]);
    expect(responses.map((value) => value.status).sort()).toEqual([200, 201]);
    expect(await Promise.all(responses.map((value) => value.json()))).toEqual(
      expect.arrayContaining([
        { reference: "SVC-SAME", created: true },
        { reference: "SVC-SAME", created: false },
      ]),
    );
    expect(await files()).toHaveLength(1);
  });
  it("returns an existing receipt without consuming another photo upload", async () => {
    state.read.mockResolvedValue({
      ...details,
      submitted: true,
      reference: "SVC-EXISTING",
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      reference: "SVC-EXISTING",
      created: false,
    });
    expect(state.submit).not.toHaveBeenCalled();
    expect(await files()).toEqual([]);
  });
});
