import "./load-env.js";
import { createApp } from "./app.js";
import { pool } from "./db/pool.js";
import { buildIngestionTick } from "./meta/scheduled-ingestion.js";
import { startScheduler } from "./services/scheduler.js";
import { consoleLogger } from "./services/logger.js";

const PORT = Number(process.env.PORT) || 4000;

createApp().listen(PORT, () => {
  console.log(`[server] AI Campaigner API listening on :${PORT}`);
});

// Insights ingestion + connection health check. buildIngestionTick returns null
// when no Meta token is configured, leaving the scheduler off until Meta is wired
// up (see docs/META_SETUP.md). Interval defaults to hourly.
const tick = buildIngestionTick(pool);
if (tick) {
  const intervalMs = Number(process.env.INGESTION_INTERVAL_MS) || 60 * 60 * 1000;
  startScheduler({
    intervalMs,
    label: "ingestion",
    tick: async () => {
      const summary = await tick();
      consoleLogger.info(
        `ingestion tick: ${summary.ok} ok, ${summary.failed} failed, ${summary.snapshots} snapshots`,
      );
    },
  });
}
