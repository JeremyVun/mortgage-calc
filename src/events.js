import { S } from "./state.js";
import { estimateBorrowingPower } from "./finance.js";
import { parseNum, money, nf0 } from "./format.js";
import { byId, REDUCE_MOTION } from "./dom.js";
import { render, renderSources, renderIncomes, syncBpSegs, renderEstimator, setActiveEdit } from "./render.js";
import { saveStateSoon } from "./persist.js";

/* ============================ Lock logic ============================ */
export function lockField(key) {
  if (S.locked.includes(key)) return; // already locked; clicking does nothing
  S.locked.push(key); // S.locked is kept in lock order (oldest first, newest last)

  // bijective constraint: loan & repayment can't both be locked — drop the older sibling
  // (i.e. the one that isn't the figure just clicked).
  if (S.locked.includes("loan") && S.locked.includes("repayment")) {
    const drop = key === "loan" ? "repayment" : "loan";
    S.locked = S.locked.filter((k) => k !== drop);
  }
  // keep exactly two: evict the OLDEST lock (FIFO), never the one just clicked.
  while (S.locked.length > 2) {
    const evict = S.locked.find((k) => k !== key);
    S.locked = S.locked.filter((k) => k !== evict);
  }
  render();
}

/* ============================ Events ============================ */
export function bind() {
  // rate slider + compact buffer field
  byId("rate").addEventListener("input", (e) => { S.rate = parseFloat(e.target.value) || 0; render(); });
  const bufNum = byId("buffer-num");
  bufNum.addEventListener("input", () => { const v = parseFloat(bufNum.value); S.buffer = Math.min(5, Math.max(0, isFinite(v) ? v : 0)); render(); });
  bufNum.addEventListener("blur", () => { bufNum.value = +S.buffer.toFixed(2); });

  // term
  byId("term").addEventListener("change", (e) => { S.termYears = parseInt(e.target.value, 10); render(); });

  // frequency
  byId("freqSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.freq = b.dataset.freq; render();
  });

  // repayment basis
  byId("basisSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.repaymentBasis = b.dataset.basis; render();
  });

  // lock buttons
  document.querySelectorAll(".field .lock").forEach((btn) => {
    btn.addEventListener("click", () => lockField(btn.closest(".field").dataset.key));
  });

  // money inputs (only locked ones are editable; deposit is a sources card, handled below)
  ["property", "loan", "repayment"].forEach((key) => {
    const input = byId("f-" + key);
    input.addEventListener("focus", () => { if (!input.readOnly) { setActiveEdit(key); input.value = String(Math.round(S[key] || 0)); input.select(); } });
    input.addEventListener("input", () => {
      if (input.readOnly) return;
      S[key] = parseNum(input.value);
      render(); // render skips reformatting the active field
    });
    input.addEventListener("blur", () => { setActiveEdit(null); render(); });
  });

  // upfront costs
  const costs = byId("f-costs");
  costs.addEventListener("focus", () => { costs.value = String(Math.round(S.costs || 0)); costs.select(); });
  costs.addEventListener("input", () => { S.costs = parseNum(costs.value); byId("costsVal").textContent = money(S.costs); render(); });
  costs.addEventListener("blur", () => { costs.value = nf0.format(Math.round(S.costs || 0)); });

  // deposit funding sources (delegated; rows rebuilt only on add/remove so typing never loses caret)
  const dep = byId("depSources");
  dep.addEventListener("input", (e) => {
    const el = e.target, i = +el.dataset.idx;
    if (!S.depositSources[i]) return;
    if (el.classList.contains("dep-amt")) { S.depositSources[i].amount = parseNum(el.value); render(); }
    else if (el.classList.contains("dep-name")) { S.depositSources[i].name = el.value; saveStateSoon(); } // name feeds no calc — skip the full render/recompute
  });
  dep.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el.classList.contains("dep-amt")) { el.value = String(Math.round(S.depositSources[+el.dataset.idx].amount || 0)); el.select(); }
  });
  dep.addEventListener("focusout", (e) => {
    const el = e.target;
    if (el.classList.contains("dep-amt")) el.value = nf0.format(Math.round(S.depositSources[+el.dataset.idx].amount || 0));
  });
  dep.addEventListener("click", (e) => {
    const del = e.target.closest(".dep-del"); if (!del) return;
    const idx = +del.dataset.idx;
    S.depositSources.splice(idx, 1);
    if (S.depositSources.length === 0) S.depositSources.push({ name: "", amount: 0 });
    renderSources(); render();
    const names = byId("depSources").querySelectorAll(".dep-name"); // keep keyboard focus in the list
    const focusEl = names[Math.min(idx, names.length - 1)];
    if (focusEl) focusEl.focus();
  });
  byId("addSource").addEventListener("click", () => {
    S.depositSources.push({ name: "", amount: 0 });
    renderSources(); render();
    const names = byId("depSources").querySelectorAll(".dep-name");
    if (names.length) names[names.length - 1].focus();
  });

  // mini repayment bar -> back to top
  byId("minibar").addEventListener("click", () => window.scrollTo({ top: 0, behavior: REDUCE_MOTION.matches ? "auto" : "smooth" }));

  // collapsible panels — persist open/closed state
  document.querySelectorAll("details[data-ui]").forEach((d) => {
    d.addEventListener("toggle", () => { if (d.dataset.ui in S.ui) { S.ui[d.dataset.ui] = d.open; saveStateSoon(); } });
  });

  // repayment-schedule granularity toggle (yearly vs per selected frequency)
  byId("schedSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.ui.schedMode = b.dataset.sched; render();
  });

  // borrowing-power estimator
  const bindBpMoney = (elId, get, set) => {
    const el = byId(elId);
    el.addEventListener("focus", () => { el.value = String(Math.round(get() || 0)); el.select(); });
    el.addEventListener("input", () => { set(parseNum(el.value)); renderEstimator(); });
    el.addEventListener("blur", () => { el.value = nf0.format(Math.round(get() || 0)); });
  };
  byId("bpApplicants").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.estimator.applicants = parseInt(b.dataset.app, 10);
    // keep household in step with applicant count (symmetric: 2→couple, 1→single)
    S.estimator.household = S.estimator.applicants === 2 ? "couple" : "single";
    renderIncomes(); syncBpSegs(); renderEstimator();
  });
  byId("bpHousehold").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.estimator.household = b.dataset.hh; syncBpSegs(); renderEstimator();
  });
  const inc = byId("bpIncomes");
  inc.addEventListener("input", (e) => {
    const el = e.target; if (!el.classList.contains("bp-inc")) return;
    const i = +el.dataset.idx, f = el.dataset.field;
    if (!S.estimator.incomes[i]) S.estimator.incomes[i] = { base: 0, variable: 0 };
    S.estimator.incomes[i][f] = parseNum(el.value);
    renderEstimator();
  });
  inc.addEventListener("focusin", (e) => { const el = e.target; if (!el.classList.contains("bp-inc")) return; const r = S.estimator.incomes[+el.dataset.idx] || { base: 0, variable: 0 }; el.value = String(Math.round(r[el.dataset.field] || 0)); el.select(); });
  inc.addEventListener("focusout", (e) => { const el = e.target; if (!el.classList.contains("bp-inc")) return; const r = S.estimator.incomes[+el.dataset.idx] || { base: 0, variable: 0 }; el.value = nf0.format(Math.round(r[el.dataset.field] || 0)); });
  bindBpMoney("bp-expenses", () => S.estimator.expenses, (v) => { S.estimator.expenses = v; });
  bindBpMoney("bp-cc", () => S.estimator.ccLimit, (v) => { S.estimator.ccLimit = v; });
  bindBpMoney("bp-otherdebt", () => S.estimator.otherDebt, (v) => { S.estimator.otherDebt = v; });
  bindBpMoney("bp-rental", () => S.estimator.rental, (v) => { S.estimator.rental = v; });
  byId("bp-deps").addEventListener("input", () => { S.estimator.dependents = Math.max(0, Math.round(parseNum(byId("bp-deps").value))); renderEstimator(); });
  byId("bp-dti").addEventListener("change", () => { S.estimator.dtiOn = byId("bp-dti").checked; renderEstimator(); });
  byId("bpApply").addEventListener("click", () => {
    const est = estimateBorrowingPower();
    if (!(est.power > 0)) return;
    S.loan = Math.round(est.power);
    S.locked = ["deposit", "loan"]; // solve property & repayment from this loan + your deposit
    render();
    window.scrollTo({ top: 0, behavior: REDUCE_MOTION.matches ? "auto" : "smooth" });
  });

  // keyboard: arrow nudge on focused money field
  document.querySelectorAll(".field input.money").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (input.readOnly) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const key = input.closest(".field").dataset.key;
      const base = key === "repayment" ? 50 : 5000;
      const step = e.shiftKey ? base * 10 : base;
      S[key] = Math.max(0, (S[key] || 0) + (e.key === "ArrowUp" ? step : -step));
      // keep the field "active" so render() won't reformat it (which would jump the caret);
      // display the nudged value directly, without thousands separators
      setActiveEdit(key); render(); input.value = String(Math.round(S[key]));
    });
  });
}
