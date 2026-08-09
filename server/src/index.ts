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

// AIC-1 live probe (temporary): when META_PROBE is set, run the read-only Meta
// access check on boot and log the result. Remove META_PROBE after reading it.
if (process.env.META_PROBE) {
  import("./meta/probe.js")
    .then(({ runMetaProbe }) => runMetaProbe(consoleLogger))
    .catch((e) => consoleLogger.error("[meta-probe] crashed", e));
}

// AIC-1 write half + AIC-12/13 live validation (temporary): a reversible no-op
// budget set through the full safe-execute pipeline. Gated by META_WRITE_TEST.
if (process.env.META_WRITE_TEST) {
  import("./meta/write-test.js")
    .then(({ runWriteTest }) => runWriteTest(consoleLogger))
    .catch((e) => consoleLogger.error("[write-test] crashed", e));
}

// One-off READ-ONLY: find a Meta campaign by name across reachable ad accounts.
// Gated by META_FIND_CAMPAIGN; remove after reading the logs.
if (process.env.META_FIND_CAMPAIGN) {
  import("./meta/find-campaign.js")
    .then(({ findCampaign }) => findCampaign(consoleLogger))
    .catch((e) => consoleLogger.error("[find-campaign] crashed", e));
}

// One-off: make META_SEED_OWNER_EMAIL the owner of a Pisga customer + wire the
// dogfood connection/campaign. Gated by META_SEED_PISGA; remove after.
if (process.env.META_SEED_PISGA) {
  import("./db/seed-pisga-owner.js")
    .then(({ seedPisgaOwner }) => seedPisgaOwner(consoleLogger))
    .catch((e) => consoleLogger.error("[seed-pisga] crashed", e));
}

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
