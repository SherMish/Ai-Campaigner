import { consoleLogger } from "./logger.js";

// Minimal interval scheduler. The tick's own errors are caught here too, so a
// crashing tick never takes the process down. Returns a stop function. The timer
// is unref'd so it doesn't keep the process alive on its own.
export function startScheduler(opts: {
  intervalMs: number;
  tick: () => Promise<void>;
  label?: string;
  // Run once on start rather than waiting a full interval (default true) — so a
  // fresh boot/deploy doesn't leave up to `intervalMs` with no tick.
  runImmediately?: boolean;
}): () => void {
  const label = opts.label ?? "scheduler";
  const run = () => opts.tick().catch((err) => consoleLogger.error(`${label} tick crashed`, err));
  const timer = setInterval(run, opts.intervalMs);
  timer.unref?.();
  consoleLogger.info(`${label} started (every ${opts.intervalMs}ms)`);
  if (opts.runImmediately !== false) run();
  return () => clearInterval(timer);
}
