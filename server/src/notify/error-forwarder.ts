// Server errors → the Telegram alert channel (AIC-118).
//
// The relay covers everything that reaches the DB. This covers what doesn't:
// the exceptions and error logs that mean something went wrong on a path the
// audit trail never got to — a Meta read that threw, a tick that crashed, an
// unhandled rejection.
//
// Wrapping console.error/warn rather than asking every call site to also
// notify: same reasoning as the relay reading tables instead of adding call
// sites. There are hundreds of log statements and there will be more.
import { sendTelegram, telegramConfigured } from "./telegram.js";

// Captured before wrapping, so the forwarder's own failures — and anything
// Telegram logs — can never re-enter it. Without this an error inside the
// send path logs an error, which sends, which fails, which logs.
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

let installed = false;

function render(level: string, args: unknown[]): string {
  const body = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  return `${level === "error" ? "❌" : "⚠️"} ${level.toUpperCase()}\n${body}`;
}

/**
 * Forward console.error/console.warn, uncaught exceptions and unhandled
 * rejections to the alert channel. No-ops when Telegram isn't configured, so
 * local dev and CI are untouched. Idempotent.
 */
export function installErrorForwarder(): void {
  if (installed || !telegramConfigured("alert")) return;
  installed = true;

  const forward = (level: "error" | "warn", args: unknown[]) => {
    // Deduped: the same error usually arrives in bursts (every tick, every
    // request), and one line about it is as useful as two hundred.
    void sendTelegram(render(level, args), { channel: "alert", dedupe: true }).catch(() => {});
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    forward("error", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    forward("warn", args);
  };

  process.on("uncaughtException", (err) => {
    origError("[notify] uncaught exception", err);
    void sendTelegram(`💥 UNCAUGHT EXCEPTION\n${err.message}\n${err.stack ?? ""}`, {
      channel: "alert",
      dedupe: true,
    }).catch(() => {});
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    origError("[notify] unhandled rejection", err);
    void sendTelegram(`💥 UNHANDLED REJECTION\n${err.message}\n${err.stack ?? ""}`, {
      channel: "alert",
      dedupe: true,
    }).catch(() => {});
  });
}
