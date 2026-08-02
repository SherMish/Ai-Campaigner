// Minimal logger abstraction. Ingestion and other jobs log through this so a
// caught error is surfaced, never swallowed. In P0 it writes to the console;
// wiring a Telegram/alert sink (as Pisga does) is a later notifications concern.
export interface Logger {
  info(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (msg) => console.log(`[aic] ${msg}`),
  error: (msg, err) => console.error(`[aic] ${msg}`, err ?? ""),
};

// Collecting logger for tests — asserts what was logged without console noise.
export class CollectingLogger implements Logger {
  public infos: string[] = [];
  public errors: Array<{ msg: string; err?: unknown }> = [];
  info(msg: string): void {
    this.infos.push(msg);
  }
  error(msg: string, err?: unknown): void {
    this.errors.push({ msg, err });
  }
}
