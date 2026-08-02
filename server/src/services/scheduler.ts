import { consoleLogger } from "./logger.js";

// Minimal interval scheduler. The tick's own errors are caught here too, so a
// crashing tick never takes the process down. Returns a stop function. The timer
// is unref'd so it doesn't keep the process alive on its own.
export function startScheduler(opts: {
  intervalMs: number;
  tick: () => Promise<void>;
  label?: string;
}): () => void {
  const label = opts.label ?? "scheduler";
  const timer = setInterval(() => {
    opts.tick().catch((err) => consoleLogger.error(`${label} tick crashed`, err));
  }, opts.intervalMs);
  timer.unref?.();
  consoleLogger.info(`${label} started (every ${opts.intervalMs}ms)`);
  return () => clearInterval(timer);
}
