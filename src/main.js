import "./styles.css";
import { S } from "./state.js";
import { solve } from "./finance.js";
import { render, renderSources, renderIncomes, syncBpSegs } from "./render.js";
import { restoreState, applyPanels, resetState } from "./persist.js";
import { bind } from "./events.js";
import { byId, NARROW } from "./dom.js";
import { nf0 } from "./format.js";

/* ============================ Init ============================ */
function init() {
  restoreState(); // load saved inputs BEFORE solving/seeding so the UI reflects them
  // seed repayment from defaults so locking it later has a sensible value (solve() also does this)
  const seed = solve();
  if (!S.locked.includes("repayment")) S.repayment = seed.rActual;
  renderSources();
  renderIncomes();
  syncBpSegs();
  // reflect any RESTORED estimator amounts back into their inputs (these fields are
  // empty-when-zero and aren't repainted by render(), so seed them once on load)
  const e = S.estimator, fmt = (v) => (v ? nf0.format(Math.round(v)) : "");
  byId("bp-expenses").value = fmt(e.expenses);
  byId("bp-cc").value = fmt(e.ccLimit);
  byId("bp-otherdebt").value = fmt(e.otherDebt);
  byId("bp-deps").value = e.dependents ? String(e.dependents) : "";
  byId("f-extra").value = fmt(S.extra); // standalone input — not repainted by render(), so seed once
  applyPanels(); // reflect saved collapse state before listeners attach
  byId("resetBtn").addEventListener("click", resetState);
  bind();
  render();
  // Now that the DOM holds real values (not the $0 placeholders the static HTML
  // ships with), reveal + play the entrance animation. Gating on this avoids the
  // load flicker where placeholders paint first and then pop to the solved numbers.
  document.body.classList.add("ready");
  // re-render when crossing the mobile breakpoint so the schedule re-formats (full ↔ compact)
  if (NARROW.addEventListener) NARROW.addEventListener("change", render);
  // reveal the slim repayment bar once you've scrolled and the hero isn't meaningfully in view
  const heroEl = document.querySelector(".hero"), mb = byId("minibar");
  const updateMinibar = () => {
    const rect = heroEl.getBoundingClientRect();
    const heroVisible = rect.bottom > 70 && rect.top < window.innerHeight * 0.6;
    mb.classList.toggle("show", !heroVisible && window.scrollY > 80);
  };
  let ticking = false;
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; updateMinibar(); }); } };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  updateMinibar();
}
// Production build: this is a classic, render-blocking <script> at the end of <body>
// (see vite.config.js), so the whole DOM above it already exists and we run init()
// NOW — before the first paint — so the populated UI is what paints, with no flash of
// the empty placeholder HTML. Dev serves it as a deferred module, where the DOM is
// likewise parsed by the time it runs. Only defer if this somehow runs before <body>.
if (document.body) init();
else document.addEventListener("DOMContentLoaded", init);
