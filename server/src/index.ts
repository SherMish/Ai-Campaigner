import "./load-env.js";
import { createApp } from "./app.js";
import { pool } from "./db/pool.js";
import { buildIngestionTick } from "./meta/scheduled-ingestion.js";
import { buildGenerationTick } from "./recommendations/generation.js";
import { buildOutcomeTick } from "./services/outcome-measurement.js";
import { startScheduler } from "./services/scheduler.js";
import { consoleLogger } from "./services/logger.js";
import { buildNotificationRelay } from "./notify/relay.js";
import { installErrorForwarder } from "./notify/error-forwarder.js";

// AIC-118: before anything else can throw, so a boot-time crash is reported
// rather than only landing in Railway's logs. No-ops when Telegram is unset.
installErrorForwarder();

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

// AIC-36 live proof: reversible pause_adset round-trip on a live campaign
// (pause → verify → un-pause). Gated by META_ADSET_WRITE_TEST; remove after.
if (process.env.META_ADSET_WRITE_TEST) {
  import("./meta/adset-write-test.js")
    .then(({ runAdsetWriteTest }) => runAdsetWriteTest(consoleLogger))
    .catch((e) => consoleLogger.error("[adset-write-test] crashed", e));
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

// One-off (AIC-87): connect the real free_beta_signups_leads Pixel campaign
// to META_SEED_TEST_FREEBETA_EMAIL. Gated by META_SEED_TEST_FREEBETA; remove after.
if (process.env.META_SEED_TEST_FREEBETA) {
  import("./db/seed-test-freebeta.js")
    .then(({ seedTestFreeBeta }) => seedTestFreeBeta(consoleLogger))
    .catch((e) => consoleLogger.error("[seed-test-freebeta] crashed", e));
}

// The engine loop: ingest fresh snapshots, run the recommendation evaluator
// over them (AIC-9), then measure any past recommendation whose outcome window
// has closed (AIC-76). Ingestion and generation build to null when no Meta
// token is set, leaving the scheduler off until Meta is wired up (see
// docs/META_SETUP.md). Order is deliberate:
//   ingest → generate (sees the freshest snapshots)
//          → measure  (reads only already-ingested snapshots, and going last
//                      means an outcome recorded now is available to the NEXT
//                      tick's rules)
// Interval defaults to hourly.
const ingestTick = buildIngestionTick(pool);
const generationTick = buildGenerationTick(pool);
// Needs no Meta token — it reads snapshots we already stored — so it is never
// inert. It still only runs inside the engine loop: with no token nothing can
// execute, so there is never anything to measure.
const outcomeTick = buildOutcomeTick(pool, consoleLogger);
if (ingestTick || generationTick) {
  const intervalMs = Number(process.env.INGESTION_INTERVAL_MS) || 60 * 60 * 1000;
  startScheduler({
    intervalMs,
    label: "engine",
    tick: async () => {
      if (ingestTick) {
        const s = await ingestTick();
        consoleLogger.info(
          `ingestion tick: ${s.ok} ok, ${s.failed} failed, ${s.snapshots} snapshots`,
        );
      }
      if (generationTick) {
        const g = await generationTick();
        consoleLogger.info(
          `generation tick: ${g.evaluated} evaluated, ${g.created} proposed, ${g.expired} expired, ${g.skipped} skipped, ${g.deliveryProblems} delivery-problems`,
        );
      }
      // Isolated: a measurement failure must never make an otherwise-successful
      // ingest+generate tick read as crashed.
      try {
        const o = await outcomeTick();
        if (o.due > 0) {
          consoleLogger.info(
            `outcome tick: ${o.due} due, ${o.measured} measured, ${o.failed} failed — ${JSON.stringify(o.byVerdict)}`,
          );
        }
      } catch (e) {
        consoleLogger.error(`outcome tick crashed — ${(e as Error).message}`);
      }
    },
  });
}

// AIC-118: the ops notification relay. Its own loop, not the engine's — the
// engine runs hourly, and "the customer just paused an ad" is worth knowing in
// the next minute, not the next hour. Builds to null when Telegram is not
// configured, so nothing claims rows it can't deliver.
const notificationRelay = buildNotificationRelay(pool, consoleLogger);
if (notificationRelay) {
  startScheduler({
    intervalMs: Number(process.env.NOTIFY_INTERVAL_MS) || 60 * 1000,
    label: "notify",
    tick: async () => {
      const r = await notificationRelay();
      // Silent when there was nothing to do — this runs every minute, and an
      // "0 sent" line every minute would bury the lines that matter.
      if (r.claimed > 0) {
        consoleLogger.info(
          `notify tick: ${r.claimed} claimed, ${r.sent} sent, ${r.skipped} too old, ${r.failed} failed`,
        );
      }
    },
  });
}
