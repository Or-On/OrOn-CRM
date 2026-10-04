import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("keeps later request leases available while the HTTP server owns signal drain", async () => {
  const moduleUrl = new URL("./process-database.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import {withProcessDatabase, closeProcessDatabasePools} from ${JSON.stringify(moduleUrl)};
      let serverSignals = 0;
      process.on('SIGTERM', () => { serverSignals += 1; });
      const dsn = 'postgresql://fictional.invalid/shutdown-fixture';
      // Leases are lazy: no PostgreSQL connection or external request is made.
      await withProcessDatabase(dsn, () => Promise.resolve());
      process.emit('SIGTERM', 'SIGTERM');
      const result = await withProcessDatabase(dsn, () => Promise.resolve('completed'));
      await closeProcessDatabasePools();
      console.log(JSON.stringify({serverSignals, result}));
    `,
    ],
    { timeout: 10_000 },
  );
  expect(JSON.parse(stdout.trim())).toEqual({
    serverSignals: 1,
    result: "completed",
  });
});
