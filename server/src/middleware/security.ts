import type { Request, Response, NextFunction } from "express";

// AIC-133: security response headers, hand-rolled rather than pulling in helmet.
// The set we actually need is small and every line below is a decision worth
// being able to read; a dependency would hide those decisions behind defaults
// that change on upgrade.

// Meta serves creative thumbnails and Page profile photos from its CDN, and the
// ad preview renders them directly in the browser. blob:/data: cover the
// object URLs the upload preview creates from a local file before it is sent.
const IMG_SRC = "'self' data: blob: https://*.fbcdn.net https://*.cdninstagram.com";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' is required for STYLE only, and it is not a loophole for
  // scripts. The app styles heavily through React `style={{…}}` props, which
  // CSP3 treats as inline styles; without this the UI renders unstyled.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src ${IMG_SRC}`,
  // The browser never talks to Meta directly — every Graph call goes through
  // this server — so same-origin is the whole legitimate surface.
  "connect-src 'self'",
  // Clickjacking: nothing may frame this app. Paired with X-Frame-Options
  // below for browsers that predate frame-ancestors.
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // No geolocation/camera/mic/payment anywhere in this product; deny by default
  // so a future dependency cannot quietly start asking for them.
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
  // HSTS only over TLS. Setting it on a plain-HTTP local dev response would
  // pin localhost to https for six months in the developer's browser, which is
  // a genuinely painful thing to undo.
  if (req.secure || req.header("x-forwarded-proto") === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

// ── Rate limiting ──────────────────────────────────────────────────────────
//
// Fixed-window, in-memory, keyed by IP + route. Deliberately simple: this runs
// as a single Railway instance, so a shared store would add a dependency and a
// failure mode without buying anything today. If it ever scales horizontally
// this becomes per-instance and the limits must move to a shared store — noted
// here rather than discovered later.
//
// The target is credential stuffing and password brute force. bcrypt at 12
// rounds already makes each guess expensive for US as well as the attacker,
// which is its own reason to cap the rate: unlimited login attempts are a CPU
// exhaustion vector against this server, not only a risk to the account.
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

// Bounded so a flood of distinct IPs cannot grow the map without limit — the
// rate limiter must not itself become the memory-exhaustion bug.
const MAX_KEYS = 10_000;

function hit(key: string, limit: number, windowMs: number, now: number): boolean {
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
      if (buckets.size >= MAX_KEYS) return true; // still full: fail CLOSED
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

// Which address to count against.
//
// AIC-133 follow-up, found by testing the LIVE endpoint rather than trusting
// the deploy: eleven bad logins in a row all returned 401 and the limiter never
// fired, while the identical code blocked on the eleventh locally.
//
// `req.ip` under `trust proxy: 1` resolves to the last X-Forwarded-For entry,
// which on Railway is the EDGE POP that handled the request — and the POP
// varies request to request (Railway exposes it as X-Railway-Edge). So every
// attempt landed in its own bucket and nothing was ever limited. A rate limiter
// that silently counts nothing is worse than none, because it looks like
// protection in the code review.
//
// Railway documents X-Real-IP as the client's remote address, set by its edge.
// Preferred here, with req.ip as the fallback for any other host.
function clientKey(req: Request): string {
  const real = req.header("x-real-ip");
  if (real && real.trim()) return real.trim();
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export function rateLimit(opts: { limit: number; windowMs: number; name: string }) {
  return function limiter(req: Request, res: Response, next: NextFunction): void {
    const ip = clientKey(req);
    if (hit(`${opts.name}:${ip}`, opts.limit, opts.windowMs, Date.now())) {
      next();
      return;
    }
    // Logged: a limiter that fires is either an attack or a broken client, and
    // both are things an operator wants to know happened rather than discover
    // from a customer. Also the signal that would have caught this middleware
    // counting nothing.
    console.warn(`[rate-limit] ${opts.name} blocked ${ip}`);
    res.setHeader("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
    res.status(429).json({ error: "too many attempts, try again later" });
  };
}

// Exported for tests, which must not inherit state between cases.
export function __resetRateLimits(): void {
  buckets.clear();
}
