// Telegram transport for the ops channel (AIC-118). One sender, used by the
// relay (campaign/ad changes, failures, ops items) and by the error forwarder.
//
// Config — all optional. With no bot token, or no chat id, every path here
// silently no-ops: local dev and CI must never post, and must never fail
// because they can't.
//   TELEGRAM_BOT_TOKEN        bot HTTP API token (from @BotFather)
//   TELEGRAM_CHAT_ID          destination for change/ops notifications
//   TELEGRAM_ALERT_CHAT_ID    destination for errors (optional; falls back to
//                             TELEGRAM_CHAT_ID, so one channel works fine)
//
// Three properties this must hold, because it is called from paths that must
// not care whether Telegram is up:
//   1. it never throws;
//   2. it never blocks a customer request (callers fire it off the hot path);
//   3. it cannot flood — identical messages are deduped inside a window, and
//      the whole sender is capped per minute with a single notice when it
//      starts dropping. An ops channel nobody can read is the same as no
//      channel at all.

// Captured before anything wraps console.*, so this module's own diagnostics
// can never re-enter the error forwarder and recurse.
const origError = console.error.bind(console);

const TELEGRAM_TEXT_CAP = 3900; // Telegram's hard limit is 4096
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_MIN = 20;

export type Channel = "ops" | "alert";

function botToken(): string | undefined {
  return process.env.TELEGRAM_BOT_TOKEN;
}

// Read at call time, not at import time: the tests set env per case, and
// reading once at module load would freeze whatever the first import saw.
function chatIdFor(channel: Channel): string | undefined {
  const ops = process.env.TELEGRAM_CHAT_ID;
  return channel === "alert" ? process.env.TELEGRAM_ALERT_CHAT_ID || ops : ops;
}

export function telegramConfigured(channel: Channel = "ops"): boolean {
  return !!(botToken() && chatIdFor(channel));
}

const recent = new Map<string, number>();
let windowStart = 0;
let sentThisWindow = 0;
let suppressionNoticeSent = false;

// Exported for tests — module-level counters would otherwise leak between them.
export function __resetTelegramThrottle(): void {
  recent.clear();
  windowStart = 0;
  sentThisWindow = 0;
  suppressionNoticeSent = false;
}

function prune(now: number): void {
  for (const [key, at] of recent) {
    if (now - at > DEDUPE_WINDOW_MS) recent.delete(key);
  }
}

export type SendOutcome = "sent" | "unconfigured" | "duplicate" | "rate_limited" | "failed";

/**
 * Send one message. Returns WHY it did what it did rather than a bare boolean,
 * because the relay has to tell "Telegram is down" (leave the row for a retry)
 * apart from "we deliberately didn't send this" (don't).
 */
export async function sendTelegram(
  text: string,
  opts: { channel?: Channel; dedupe?: boolean; now?: number } = {},
): Promise<SendOutcome> {
  const channel = opts.channel ?? "ops";
  const token = botToken();
  const chatId = chatIdFor(channel);
  if (!token || !chatId) return "unconfigured";

  const now = opts.now ?? Date.now();

  // Deduping is opt-in. Errors repeat identically and must be collapsed;
  // two customers pausing an ad a minute apart produce the same summary line
  // and are two real events, so the relay does not ask for it.
  if (opts.dedupe) {
    prune(now);
    const key = `${channel}:${text}`;
    if (recent.has(key)) return "duplicate";
    recent.set(key, now);
  }

  if (now - windowStart >= 60_000) {
    windowStart = now;
    sentThisWindow = 0;
    suppressionNoticeSent = false;
  }
  if (sentThisWindow >= MAX_PER_MIN) {
    // One notice per window, so the cap itself can't become the flood.
    if (!suppressionNoticeSent) {
      suppressionNoticeSent = true;
      sentThisWindow++;
      await post(token, chatId, `⚠️ Suppressing further notifications this minute (cap ${MAX_PER_MIN}).`);
    }
    return "rate_limited";
  }
  sentThisWindow++;

  return (await post(token, chatId, text)) ? "sent" : "failed";
}

async function post(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, TELEGRAM_TEXT_CAP),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      origError(`[notify] Telegram ${res.status}: ${await res.text().catch(() => "")}`);
      return false;
    }
    return true;
  } catch (err) {
    origError("[notify] Telegram send failed:", (err as Error).message);
    return false;
  }
}
