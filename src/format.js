/* ============================ Formatting ============================ */
export const nf0 = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
export const nf2 = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function money(x) { if (!isFinite(x)) return "—"; const r = Math.round(x); return (r < 0 ? "-$" : "$") + nf0.format(Math.abs(r)); }
export function pct(x, d = 1) { if (!isFinite(x)) return "—"; return x.toFixed(d) + "%"; }
// Abbreviated money for the dense per-period schedule on narrow screens ($47.7k / $1.20M).
export function compactK(x) {
  if (!isFinite(x)) return "—";
  const a = Math.abs(x), s = x < 0 ? "-$" : "$";
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
  return money(x);
}
// Compact axis labels for the chart ($1.2M / $250k / $900).
export function compact(x) {
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(x >= 1e7 ? 0 : 1) + "M";
  if (x >= 1e3) return "$" + Math.round(x / 1e3) + "k";
  return "$" + Math.round(x);
}
// Non-negative money parser: strips currency chrome, keeps a single decimal point,
// no leading minus, and clamps absurd entries instead of silently collapsing to 0.
export function parseNum(str) {
  let s = String(str).replace(/[^0-9.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  const v = parseFloat(s);
  if (Number.isNaN(v)) return 0;          // empty / non-numeric
  if (!isFinite(v)) return 1e12;          // overflow -> clamp, don't silently zero
  return Math.min(v, 1e12);               // domain ceiling: a trillion dollars
}

export function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Human duration from a number of years ("24 yr 6 mo", "5 yr", "8 mo").
export function fmtDuration(years) {
  if (!isFinite(years) || years <= 0) return "0 mo";
  const totalMonths = Math.round(years * 12);
  const y = Math.floor(totalMonths / 12), m = totalMonths % 12;
  if (y && m) return `${y} yr ${m} mo`;
  if (y) return `${y} yr`;
  return `${m} mo`;
}
