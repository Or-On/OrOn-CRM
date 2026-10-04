import postgres from "postgres";

/** Notifications are hints only; the caller always reclaims durable DB rows. */
export function createJobWakeup(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    prepare: false,
    connection: { application_name: "oron-messaging-wakeup" },
  });
  let closed = false;
  let pending = false;
  let listening = false;
  let starting = false;
  let wake: (() => void) | undefined;
  let unlisten: (() => Promise<unknown>) | undefined;
  const signal = () => {
    if (closed) return;
    pending = true;
    wake?.();
  };
  const start = () => {
    if (closed || starting || listening) return;
    starting = true;
    void sql
      .listen("oron_messaging_jobs", signal, signal)
      .then((subscription) => {
        unlisten = () => subscription.unlisten();
        listening = true;
      })
      .catch(() => {
        /* Durable polling remains active on listener failure. */
      })
      .finally(() => {
        starting = false;
      });
  };
  start();
  return {
    wait(milliseconds: number): Promise<void> {
      start();
      if (closed || pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          wake = undefined;
          pending = false;
          resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        wake = finish;
      });
    },
    async close(): Promise<void> {
      closed = true;
      wake?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          unlisten?.().catch(() => undefined) ?? Promise.resolve(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      // postgres-js ends its dedicated LISTEN pool as well as the owner pool.
      await sql.end({ timeout: 0 });
    },
  };
}
