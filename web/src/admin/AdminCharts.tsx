import { useState } from "react";
import { splitIntoRuns, niceMax, project, runToPolyline, type DayPoint, type PlotBox } from "./chart-geometry";

// Inline-SVG charts for the /admin analytics blocks (AIC-122). No charting
// dependency on purpose: these are four small, fixed shapes, and the geometry
// they need is already a tested pure module (chart-geometry.ts). Adding a
// library would cost more bundle than the charts themselves.

const BOX: PlotBox = { width: 640, height: 150, padLeft: 8, padBottom: 22, padTop: 10 };

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}`;
}

/**
 * One measure over time. Deliberately ONE measure per chart: spend (agorot)
 * and leads (single digits) differ by ~3 orders of magnitude, and the dual-axis
 * chart that would "solve" that is the single most misleading chart form there
 * is — two y-scales let you manufacture any correlation you like by choosing
 * the scales. Two stacked charts share the x-axis and lie about nothing.
 */
export function TimeSeries({
  points, valueOf, color, label, format,
}: {
  points: DayPoint[];
  valueOf: (p: DayPoint) => number;
  color: string;
  label: string;
  format: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(points.map(valueOf));
  const runs = splitIntoRuns(points);
  const baselineY = BOX.padTop + (BOX.height - BOX.padBottom - BOX.padTop);

  return (
    <div className="ac-chart">
      <div className="ac-chart-head">
        <span className="ac-chart-label"><i className="ac-swatch" style={{ background: color }} />{label}</span>
        <span className="ac-chart-max">{format(max)}</span>
      </div>
      {/* dir=ltr scoped to the PLOT only — time reads left→right in a chart
          even inside an RTL page. Deliberately not on the whole block: the
          Hebrew label above it must stay RTL, and React's SVG types don't
          accept `dir` on <svg> itself. */}
      <div dir="ltr">
      <svg viewBox={`0 0 ${BOX.width} ${BOX.height}`} className="ac-svg" role="img" aria-label={label}>
        {/* recessive gridlines — three, including the baseline */}
        {[0, 0.5, 1].map((f) => {
          const y = BOX.padTop + (BOX.height - BOX.padBottom - BOX.padTop) * f;
          return <line key={f} x1={BOX.padLeft} x2={BOX.width} y1={y} y2={y} className="ac-grid" />;
        })}

        {runs.map((run, i) => (
          <polyline
            key={i}
            points={runToPolyline(run, valueOf, points, max, BOX)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* A lone point in its own run would be an invisible zero-length line. */}
        {runs.filter((r) => r.length === 1).map((run) => {
          const idx = points.indexOf(run[0]);
          const { x, y } = project(idx, valueOf(run[0]), points.length, max, BOX);
          return <circle key={`solo-${idx}`} cx={x} cy={y} r={3} fill={color} />;
        })}

        {hover !== null && (() => {
          const { x, y } = project(hover, valueOf(points[hover]), points.length, max, BOX);
          return (
            <g>
              <line x1={x} x2={x} y1={BOX.padTop} y2={baselineY} className="ac-crosshair" />
              {/* 2px surface ring so the marker reads on top of the line */}
              <circle cx={x} cy={y} r={5} fill={color} stroke="#fff" strokeWidth={2} />
            </g>
          );
        })()}

        {/* Hit targets are full-height columns, much bigger than the marks. */}
        {points.map((pt, i) => {
          const { x } = project(i, 0, points.length, max, BOX);
          const w = points.length > 1 ? (BOX.width - BOX.padLeft) / (points.length - 1) : BOX.width;
          return (
            <rect
              key={pt.date}
              x={x - w / 2} y={0} width={w} height={BOX.height}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}

        {/* first + last date only — a label per point is noise */}
        {points.length > 0 && (
          <>
            <text x={BOX.padLeft} y={BOX.height - 6} className="ac-axis" textAnchor="start">{shortDate(points[0].date)}</text>
            <text x={BOX.width} y={BOX.height - 6} className="ac-axis" textAnchor="end">{shortDate(points[points.length - 1].date)}</text>
          </>
        )}
      </svg>
      </div>
      <div className="ac-tip" aria-live="polite">
        {hover !== null
          ? `${shortDate(points[hover].date)} · ${format(valueOf(points[hover]))}`
          : " "}
      </div>
    </div>
  );
}

/**
 * A two-part proportion bar with both parts always labelled in text.
 * The status palette's amber fails the 3:1 contrast check and green↔amber sit
 * in the CVD floor band, so color alone may never carry the meaning — the
 * visible count+label beside each part is the required relief, not decoration.
 */
export function ProportionBar({
  parts,
}: {
  parts: Array<{ label: string; value: number; color: string }>;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div>
      <div className="ac-bar" dir="ltr">
        {parts.map((p) => (
          <span
            key={p.label}
            className="ac-bar-seg"
            style={{ width: `${total > 0 ? (p.value / total) * 100 : 0}%`, background: p.color }}
            title={`${p.label}: ${p.value}`}
          />
        ))}
      </div>
      <div className="ac-legend">
        {parts.map((p) => (
          <span key={p.label} className="ac-legend-item">
            <i className="ac-swatch" style={{ background: p.color }} />
            {p.label} <b>{p.value}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
