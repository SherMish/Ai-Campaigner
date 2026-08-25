// security audit 2026-08-25: the rate limiter and the header set.
import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, securityHeaders, __resetRateLimits } from "./security.js";

type Res = {
  headers: Record<string, string>;
  statusCode: number | null;
  body: unknown;
  setHeader(k: string, v: string): void;
  status(c: number): Res;
  json(b: unknown): Res;
};
function res(): Res {
  const r: Res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { r.headers[k.toLowerCase()] = v; },
    status(c) { r.statusCode = c; return r; },
    json(b) { r.body = b; return r; },
  };
  return r;
}
const req = (ip: string, secure = true, realIp?: string) =>
  ({
    ip,
    socket: { remoteAddress: ip },
    secure,
    header: (h: string) => (h.toLowerCase() === "x-real-ip" ? realIp : undefined),
  }) as never;

describe("rate limiting (security audit 2026-08-25)", () => {
  beforeEach(() => __resetRateLimits());

  it("allows up to the limit, then refuses with 429 and Retry-After", () => {
    const limiter = rateLimit({ name: "t", limit: 3, windowMs: 60_000 });
    let allowed = 0;
    const r = res();
    for (let i = 0; i < 5; i++) limiter(req("1.1.1.1"), r as never, () => { allowed++; });
    expect(allowed).toBe(3);
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBe("60");
  });

  it("counts per IP — one attacker cannot lock everyone else out", () => {
    // The failure this prevents: a shared bucket turns a brute-force attempt
    // into a denial of service against every other customer.
    const limiter = rateLimit({ name: "t", limit: 2, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) limiter(req("9.9.9.9"), res() as never, () => {});
    let allowed = 0;
    limiter(req("2.2.2.2"), res() as never, () => { allowed++; });
    expect(allowed).toBe(1);
  });

  // The bug this pins: req.ip under `trust proxy` is the last X-Forwarded-For
  // entry, which on Railway is the edge POP and CHANGES between requests. Every
  // attempt got its own bucket and the limiter counted nothing — in production,
  // while passing every test, because the tests supplied a stable req.ip.
  it("counts by X-Real-IP when present, so a rotating proxy address cannot scatter the buckets", () => {
    const limiter = rateLimit({ name: "t", limit: 2, windowMs: 60_000 });
    let allowed = 0;
    // Same client, a different proxy-assigned req.ip every time.
    for (let i = 0; i < 5; i++) {
      limiter(req(`10.0.0.${i}`, true, "203.0.113.7"), res() as never, () => { allowed++; });
    }
    expect(allowed).toBe(2);
  });

  it("keeps separate buckets per route name", () => {
    // Exhausting login must not also block signup, and vice versa.
    const login = rateLimit({ name: "login", limit: 1, windowMs: 60_000 });
    const signup = rateLimit({ name: "signup", limit: 1, windowMs: 60_000 });
    login(req("3.3.3.3"), res() as never, () => {});
    login(req("3.3.3.3"), res() as never, () => {});
    let allowed = 0;
    signup(req("3.3.3.3"), res() as never, () => { allowed++; });
    expect(allowed).toBe(1);
  });
});

describe("security headers (security audit 2026-08-25)", () => {
  it("sets the full set, and a CSP that denies framing and inline script", () => {
    const r = res();
    securityHeaders(req("1.2.3.4"), r as never, () => {});
    const csp = r.headers["content-security-policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // 'unsafe-inline' is permitted for STYLE only. If it ever leaks into
    // script-src the CSP stops being an XSS control at all, which is the one
    // thing this assertion exists to catch.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sends HSTS over TLS but never over plain HTTP", () => {
    // Setting HSTS on a local http response pins localhost to https in the
    // developer's browser for six months, which is painful to undo.
    const secure = res();
    securityHeaders(req("1.2.3.4", true), secure as never, () => {});
    expect(secure.headers["strict-transport-security"]).toContain("max-age=");

    const plain = res();
    securityHeaders(req("1.2.3.4", false), plain as never, () => {});
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
  });
});
