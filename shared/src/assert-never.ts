// Exhaustiveness guard for switches over customer-visible enums (AIC-98).
//
// The point is the COMPILE error, not the throw: if a new variant is added to
// one of those unions and a switch doesn't handle it, `value` is no longer
// `never` and `tsc` fails at the call site — which is what stops the next
// blank panel from shipping. The runtime throw only covers a value that
// reached us from outside the type system (a stale client, an old DB row).
export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}
