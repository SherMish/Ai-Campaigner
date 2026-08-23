// Pure geometry for the /admin analytics charts (AIC-122). Separated from the
// SVG so it can be unit-tested — same reason as ops-queue-view.ts and
// onboarding-step4.ts: this repo has no component-test tooling.

export interface DayPoint {
  date: string; // YYYY-MM-DD
  spendAgorot: number;
  leads: number;
}

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

/**
 * Split points into runs of CONSECUTIVE days.
 *
 * A day with no ingested row is absent from the data entirely, and that is not
 * the same fact as a day with zero spend. Drawing one line straight through the
 * hole would assert continuity we never measured — the chart equivalent of the
 * bugs this codebase keeps hitting, where a value meaning one thing gets
 * rendered as a claim about another. So the line breaks instead, and the gap
 * stays visible.
 */
export function splitIntoRuns(points: DayPoint[]): DayPoint[][] {
  const runs: DayPoint[][] = [];
  let current: DayPoint[] = [];
  for (const p of points) {
    const prev = current[current.length - 1];
    if (prev && dayNumber(p.date) - dayNumber(prev.date) !== 1) {
      runs.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Nice upper bound for a y-axis: never below 1 (so an all-zero series still has
 * a real axis rather than dividing by zero), and rounded up to a readable step
 * so the top gridline is a number a human would choose.
 */
export function niceMax(values: number[]): number {
  const peak = Math.max(0, ...values);
  if (peak <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  return Math.ceil(peak / magnitude) * magnitude;
}

export interface PlotBox { width: number; height: number; padLeft: number; padBottom: number; padTop: number; }

/** Map a point's index + value to SVG coordinates inside the plot box. */
export function project(
  index: number,
  value: number,
  total: number,
  max: number,
  box: PlotBox,
): { x: number; y: number } {
  const innerW = box.width - box.padLeft;
  const innerH = box.height - box.padBottom - box.padTop;
  // A single point sits at the left edge rather than dividing by zero.
  const x = box.padLeft + (total <= 1 ? 0 : (index / (total - 1)) * innerW);
  const y = box.padTop + innerH - (max <= 0 ? 0 : (value / max) * innerH);
  return { x, y };
}

/** An SVG polyline `points` string for one contiguous run. */
export function runToPolyline(
  run: DayPoint[],
  valueOf: (p: DayPoint) => number,
  allPoints: DayPoint[],
  max: number,
  box: PlotBox,
): string {
  return run
    .map((p) => {
      const idx = allPoints.indexOf(p);
      const { x, y } = project(idx, valueOf(p), allPoints.length, max, box);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
