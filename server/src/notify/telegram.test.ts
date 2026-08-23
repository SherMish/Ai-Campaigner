import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendTelegram, telegramConfigured, __resetTelegramThrottle } from "./telegram.js";

const OLD_ENV = { ...process.env };

function configure() {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "-100123";
}

beforeEach(() => {
  __resetTelegramThrottle();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
});

describe("Telegram transport (AIC-118)", () => {
  // The single most important property: an unconfigured environment — every
  // dev machine and CI — must never reach the network and never fail.
  it("no-ops without ever calling fetch when unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(telegramConfigured()).toBe(false);
    expect(await sendTelegram("anything")).toBe("unconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the configured chat and reports success", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendTelegram("hello")).toBe("sent");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/bottest-token/sendMessage");
    expect(JSON.parse(init.body).chat_id).toBe("-100123");
    expect(JSON.parse(init.body).text).toBe("hello");
  });

  // Never throws, whatever the network does — the callers are audit-trail and
  // logging paths that must not fail because Telegram is down.
  it("reports failure instead of throwing when the network or Telegram errors", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    expect(await sendTelegram("x")).toBe("failed");

    __resetTelegramThrottle();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "slow down" }));
    expect(await sendTelegram("y")).toBe("failed");
  });

  it("dedupes identical messages within the window, but only when asked", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    expect(await sendTelegram("same", { dedupe: true })).toBe("sent");
    expect(await sendTelegram("same", { dedupe: true })).toBe("duplicate");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The relay does NOT dedupe: two customers doing the same thing are two
    // real events, not one repeated log line.
    expect(await sendTelegram("same")).toBe("sent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets a deduped message through again once the window has passed", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const t0 = 1_000_000;
    expect(await sendTelegram("burst", { dedupe: true, now: t0 })).toBe("sent");
    expect(await sendTelegram("burst", { dedupe: true, now: t0 + 1000 })).toBe("duplicate");
    expect(await sendTelegram("burst", { dedupe: true, now: t0 + 6 * 60 * 1000 })).toBe("sent");
  });

  // A channel that floods is a channel that gets muted, which is the same as
  // having no channel — so the cap is a feature, not a safety net.
  it("caps the burst and says so exactly once", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const t0 = 2_000_000;

    const outcomes: string[] = [];
    for (let i = 0; i < 30; i++) outcomes.push(await sendTelegram(`m${i}`, { now: t0 }));

    expect(outcomes.filter((o) => o === "sent")).toHaveLength(20);
    expect(outcomes.filter((o) => o === "rate_limited").length).toBeGreaterThan(0);
    const notices = fetchMock.mock.calls.filter(([, i]) => JSON.parse(i.body).text.includes("Suppressing"));
    expect(notices).toHaveLength(1);

    // ...and the next minute starts clean.
    expect(await sendTelegram("after", { now: t0 + 61_000 })).toBe("sent");
  });

  it("truncates rather than letting Telegram reject an over-long message", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await sendTelegram("x".repeat(9000));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text.length).toBe(3900);
  });

  it("routes alerts to the alert chat, falling back to the ops chat when unset", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegram("a", { channel: "alert" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).chat_id).toBe("-100123");

    process.env.TELEGRAM_ALERT_CHAT_ID = "-100999";
    await sendTelegram("b", { channel: "alert" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).chat_id).toBe("-100999");
  });
});
