import "./styles.css";
import { S } from "./state.js";
import { solve } from "./finance.js";
import { render, renderSources, renderIncomes, syncBpSegs } from "./render.js";
import { restoreState, applyPanels, resetState } from "./persist.js";
import { bind } from "./events.js";
import { byId, NARROW } from "./dom.js";

/* ============================ Init ============================ */
function init() {
  restoreState(); // load saved inputs BEFORE solving/seeding so the UI reflects them
  // seed repayment from defaults so locking it later has a sensible value
  const seed = solve();
  if (!S.locked.includes("repayment")) S.repayment = S.repaymentBasis === "assessed" ? seed.rAssessed : seed.rActual;
  renderSources();
  renderIncomes();
  syncBpSegs();
  applyPanels(); // reflect saved collapse state before listeners attach
  byId("resetBtn").addEventListener("click", resetState);
  bind();
  render();
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
document.addEventListener("DOMContentLoaded", init);
