import { describe, it, expect } from "vitest";
import { FakeMetaClient } from "./client.js";
import {
  InMemoryConnectionStore,
  type ConnectionRow,
} from "./connection-store.js";
import {
  ConnectionService,
  AccessHaltedError,
  worstHealth,
} from "./connection-service.js";

const FIXED = new Date("2026-08-03T00:00:00Z");

function makeStore(overrides: Partial<ConnectionRow> = {}) {
  const conn: ConnectionRow = {
    id: "conn-1",
    customerId: "cust-1",
    accessHealth: "ok",
    adAccountMetaId: "act_100",
    pageId: "page_1",
    instagramId: "ig_1",
    ...overrides,
  };
  return new InMemoryConnectionStore(new Map([[conn.id, conn]]));
}

describe("worstHealth", () => {
  it("is ok only when every asset is ok", () => {
    expect(worstHealth(["ok", "ok"])).toBe("ok");
  });
  it("prefers the most specific reason (invalid > revoked > needs_reconnect)", () => {
    expect(worstHealth(["ok", "revoked", "invalid"])).toBe("invalid");
    expect(worstHealth(["needs_reconnect", "revoked"])).toBe("revoked");
  });
});

describe("ConnectionService.verify", () => {
  it("healthy read: stays ok, no ops item, refreshes last_verified", async () => {
    const store = makeStore({ accessHealth: "ok" });
    const svc = new ConnectionService(store, new FakeMetaClient(), () => FIXED);

    const health = await svc.verify("conn-1");

    expect(health).toBe("ok");
    expect(store.opsItems).toHaveLength(0);
    expect(store.verifiedTouches).toEqual([{ id: "conn-1", at: FIXED }]);
    expect(store.healthUpdates).toHaveLength(0);
  });

  it("simulated revocation: moves to revoked, raises one ops item", async () => {
    const store = makeStore({ accessHealth: "ok" });
    // Ad account grant pulled → revoked; Page/IG still ok.
    const client = new FakeMetaClient({ act_100: "revoked" });
    const svc = new ConnectionService(store, client, () => FIXED);

    const health = await svc.verify("conn-1");

    expect(health).toBe("revoked");
    expect(store.healthUpdates).toEqual([
      { id: "conn-1", health: "revoked", at: FIXED },
    ]);
    expect(store.opsItems).toHaveLength(1);
    expect(store.opsItems[0]).toMatchObject({
      customerId: "cust-1",
      type: "meta_connection_failure",
      severity: "high",
    });
    expect(store.opsItems[0].detail).toContain("ad_account:revoked");
  });

  it("dead token: classifies invalid across assets", async () => {
    const store = makeStore({ accessHealth: "ok" });
    const client = new FakeMetaClient({}, "invalid"); // everything invalid
    const svc = new ConnectionService(store, client, () => FIXED);
    expect(await svc.verify("conn-1")).toBe("invalid");
  });

  it("no duplicate ops item when health is unchanged from a prior loss", async () => {
    const store = makeStore({ accessHealth: "revoked" });
    const client = new FakeMetaClient({ act_100: "revoked" });
    const svc = new ConnectionService(store, client, () => FIXED);

    const health = await svc.verify("conn-1");

    expect(health).toBe("revoked");
    expect(store.opsItems).toHaveLength(0); // unchanged → no new item
    expect(store.verifiedTouches).toHaveLength(1);
  });
});

describe("ConnectionService.assertExecutable (safety halt)", () => {
  it("passes when access is ok", async () => {
    const svc = new ConnectionService(
      makeStore({ accessHealth: "ok" }),
      new FakeMetaClient(),
      () => FIXED,
    );
    await expect(svc.assertExecutable("conn-1")).resolves.toBeUndefined();
  });

  it("throws AccessHaltedError when access is lost", async () => {
    const svc = new ConnectionService(
      makeStore({ accessHealth: "needs_reconnect" }),
      new FakeMetaClient(),
      () => FIXED,
    );
    await expect(svc.assertExecutable("conn-1")).rejects.toBeInstanceOf(
      AccessHaltedError,
    );
  });
});
