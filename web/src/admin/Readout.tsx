import { useEffect, useState } from "react";
import { formatShekel } from "@aic/shared";
import { api } from "../api";
import { strings } from "../strings";

// Mirror of the server's CampaignReadout (subset the screen renders).
interface Readout {
  name: string;
  status: string;
  period: { current: { start: string; end: string } };
  current: { spendAgorot: number; leads: number; cplAgorot: number | null };
  delta: { spendPct: number | null; leadsPct: number | null; cplPct: number | null };
  perCreative: Array<{
    metaObjectId: string;
    creativeName: string | null;
    spendAgorot: number;
    leads: number;
    cplAgorot: number | null;
    deliveryStatus: string;
  }>;
}

interface CampaignRef {
  id: string;
  name: string;
  status: string;
  business: string;
}

const a = strings.he.admin;

function money(agorot: number | null): string {
  return agorot === null ? a.noData : formatShekel(agorot);
}

function pct(p: number | null): string {
  if (p === null) return a.noData;
  return `${p > 0 ? "+" : ""}${p}%`;
}

// Internal dogfood readout. Reads only from our DB via /api/admin — no live Meta
// at render time (AIC-7). Picks the first managed campaign that has data.
export function AdminReadout() {
  const [readout, setReadout] = useState<Readout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { campaigns } = await api<{ campaigns: CampaignRef[] }>(
          "/admin/campaigns",
        );
        if (campaigns.length === 0) {
          setLoading(false);
          return;
        }
        const r = await api<Readout>(
          `/admin/campaigns/${campaigns[0].id}/readout`,
        );
        setReadout(r);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <main dir="rtl" style={S.page}>{a.loading}</main>;
  if (error) return <main dir="rtl" style={S.page}>⚠ {error}</main>;
  if (!readout) return <main dir="rtl" style={S.page}>{a.noCampaigns}</main>;

  return (
    <main dir="rtl" style={S.page}>
      <h1 style={{ margin: "0 0 4px" }}>{readout.name}</h1>
      <p style={{ color: "#6b7280", margin: "0 0 24px" }}>
        {a.readoutTitle} · {readout.period.current.start} – {readout.period.current.end}
      </p>

      <div style={S.tiles}>
        <Tile label={a.status} value={readout.status} />
        <Tile label={a.spend} value={money(readout.current.spendAgorot)} sub={`${a.vsPrevious}: ${pct(readout.delta.spendPct)}`} />
        <Tile label={a.leads} value={String(readout.current.leads)} sub={`${a.vsPrevious}: ${pct(readout.delta.leadsPct)}`} />
        <Tile label={a.cpl} value={money(readout.current.cplAgorot)} sub={`${a.vsPrevious}: ${pct(readout.delta.cplPct)}`} />
      </div>

      <h2 style={{ marginTop: 32 }}>{a.perCreative}</h2>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>{a.creative}</th>
            <th style={S.th}>{a.spend}</th>
            <th style={S.th}>{a.leads}</th>
            <th style={S.th}>{a.cpl}</th>
          </tr>
        </thead>
        <tbody>
          {readout.perCreative.map((c) => (
            <tr key={c.metaObjectId}>
              <td style={S.td}>{c.creativeName ?? c.metaObjectId}</td>
              <td style={S.td}>{money(c.spendAgorot)}</td>
              <td style={S.td}>{c.leads}</td>
              <td style={S.td}>{money(c.cplAgorot)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={S.tile}>
      <div style={{ color: "#6b7280", fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ color: "#9ca3af", fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 820, margin: "0 auto" },
  tiles: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 },
  tile: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16 },
  table: { width: "100%", borderCollapse: "collapse", marginTop: 8 },
  th: { textAlign: "right", borderBottom: "2px solid #e5e7eb", padding: "8px 6px", fontSize: 13, color: "#6b7280" },
  td: { borderBottom: "1px solid #f0f0f0", padding: "8px 6px" },
};
