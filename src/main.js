import "./styles.css";
import { S } from "./state.js";
import { render, renderSources, renderIncomes, syncBpSegs } from "./render.js";
import { restoreState, applyPanels, resetState } from "./persist.js";
import { bind } from "./events.js";
import { byId, NARROW } from "./dom.js";
import { moneyInput } from "./format.js";
import { trackPageview } from "./analytics.js";

/* ============================ Init ============================ */
function init() {
  restoreState(); // load saved inputs BEFORE rendering so the UI reflects them
  renderSources();
  renderIncomes();
  syncBpSegs();
  // reflect any RESTORED estimator amounts back into their inputs (these fields are
  // empty-when-zero and aren't repainted by render(), so seed them once on load)
  const e = S.estimator;
  byId("bp-expenses").value = moneyInput(e.expenses);
  byId("bp-cc").value = moneyInput(e.ccLimit);
  byId("bp-otherdebt").value = moneyInput(e.otherDebt);
  byId("bp-deps").value = e.dependents ? String(e.dependents) : "";
  byId("f-extra").value = moneyInput(S.extra); // standalone input — not repainted by render(), so seed once
  applyPanels(); // reflect saved collapse state before listeners attach
  byId("resetBtn").addEventListener("click", resetState);
  // Now that the DOM holds real values (not the $0 placeholders the static HTML ships with),
  // reveal + play the entrance animation. Gating on `.ready` avoids the load flicker where
  // placeholders paint first and then pop to the solved numbers. Wrapped in try/finally so a
  // throw in bind()/render() still flips `.ready` — otherwise the opacity:0 reveal gate would
  // leave the whole page stuck blank (the <noscript> reveal only covers JS-disabled).
  try {
    bind();
    render();
  } finally {
    document.body.classList.add("ready");
  }
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
  trackPageview(); // fire-and-forget page-visit beacon, deferred to idle (off the critical path)
}
// Production build: this is a classic, render-blocking <script> at the end of <body>
// (see vite.config.js), so the whole DOM above it already exists and we run init()
// NOW — before the first paint — so the populated UI is what paints, with no flash of
// the empty placeholder HTML. Dev serves it as a deferred module, where the DOM is
// likewise parsed by the time it runs. Only defer if this somehow runs before <body>.
if (document.body) init();
else document.addEventListener("DOMContentLoaded", init);
