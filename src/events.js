import { S } from "./state.js";
import { estimateBorrowingPower } from "./finance.js";
import { parseNum, moneyInput, moneyRaw } from "./format.js";
import { byId, REDUCE_MOTION } from "./dom.js";
import { render, renderSources, renderIncomes, syncBpSegs, renderEstimator, renderIncomeArea, renderSchemeArea, setActiveEdit } from "./render.js";
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
  // interest rate — precise typed entry (the old slider couldn't hit exact rates)
  const rateNum = byId("rate");
  rateNum.addEventListener("input", () => { S.rate = Math.min(12, Math.max(0, parseNum(rateNum.value))); render(); });
  rateNum.addEventListener("blur", () => { rateNum.value = S.rate.toFixed(2); });

  // term
  byId("term").addEventListener("change", (e) => { S.termYears = parseInt(e.target.value, 10); render(); });

  // frequency
  byId("freqSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.freq = b.dataset.freq; render();
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

  // Generic binder for the grouped-digits / edit-raw / blank-when-zero money inputs
  // (deposit + per-applicant income rows are delegated separately). `paint` is the
  // re-render run on each keystroke — renderEstimator for the estimator fields by default.
  const bindMoney = (elId, get, set, paint = renderEstimator) => {
    const el = byId(elId);
    el.addEventListener("focus", () => { el.value = moneyRaw(get()); el.select(); });
    el.addEventListener("input", () => { set(parseNum(el.value)); paint(); });
    el.addEventListener("blur", () => { el.value = moneyInput(get()); });
  };
  // extra repayments (paid on top of each scheduled repayment, in the selected frequency)
  bindMoney("f-extra", () => S.extra, (v) => { S.extra = v; }, render);

  // deposit funding sources (delegated; rows rebuilt only on add/remove so typing never loses caret)
  const dep = byId("depSources");
  dep.addEventListener("input", (e) => {
    const el = e.target, i = +el.dataset.idx;
    if (!S.depositSources[i]) return;
    if (el.classList.contains("src-amt")) { S.depositSources[i].amount = parseNum(el.value); render(); }
    else if (el.classList.contains("src-name")) { S.depositSources[i].name = el.value; saveStateSoon(); } // name feeds no calc — skip the full render/recompute
  });
  dep.addEventListener("focusin", (e) => {
    const el = e.target, src = S.depositSources[+el.dataset.idx];
    // guard the index: deleting a row splices the array, so a still-focused sibling's
    // data-idx can be stale by the time its focus event fires.
    if (el.classList.contains("src-amt") && src) { el.value = moneyRaw(src.amount); el.select(); }
  });
  dep.addEventListener("focusout", (e) => {
    const el = e.target, src = S.depositSources[+el.dataset.idx];
    if (el.classList.contains("src-amt") && src) { el.value = moneyInput(src.amount); }
  });
  dep.addEventListener("click", (e) => {
    const del = e.target.closest(".src-del"); if (!del) return;
    const idx = +del.dataset.idx;
    S.depositSources.splice(idx, 1);
    if (S.depositSources.length === 0) S.depositSources.push({ name: "", amount: 0 });
    renderSources(); render();
    const names = byId("depSources").querySelectorAll(".src-name"); // keep keyboard focus in the list
    const focusEl = names[Math.min(idx, names.length - 1)];
    if (focusEl) focusEl.focus();
  });
  byId("addSource").addEventListener("click", () => {
    S.depositSources.push({ name: "", amount: 0 });
    renderSources(); render();
    const names = byId("depSources").querySelectorAll(".src-name");
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

  /* ---------- borrowing-power estimator ---------- */
  byId("bpApplicants").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.estimator.applicants = parseInt(b.dataset.app, 10); // household type is derived from this
    renderIncomes(); syncBpSegs(); renderIncomeArea(); // income-only: skip the loan/chart/schedule repaint
  });

  // income blocks (per applicant): salary + bonus boxes, extra income lines, HECS toggle.
  // Delegated on the container; rebuilt only on add/remove/applicant change so typing keeps caret.
  const inc = byId("bpIncomes");
  const incOf = (el) => S.estimator.incomes[+el.dataset.app];
  const extraOf = (el) => { const o = incOf(el); return o && o.extra ? o.extra[+el.dataset.idx] : null; };
  inc.addEventListener("input", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-main")) { const o = incOf(el); if (o) { o[el.dataset.field] = parseNum(el.value); renderIncomeArea(); } } // salary / bonus
    else if (el.classList.contains("src-amt")) { const row = extraOf(el); if (row) { row.amount = parseNum(el.value); renderIncomeArea(); } } // extra income line (rental/other)
    else if (el.classList.contains("src-name")) { const row = extraOf(el); if (row) { row.label = el.value; saveStateSoon(); } } // label feeds no calc
  });
  inc.addEventListener("change", (e) => {
    const el = e.target;
    if (el.classList.contains("hecs-check")) { const o = incOf(el); if (o) { o.hecs = el.checked; renderIncomeArea(); } }
  });
  inc.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-main")) { const v = incOf(el)[el.dataset.field]; el.value = moneyRaw(v); el.select(); }
    else if (el.classList.contains("src-amt")) { const row = extraOf(el); el.value = row ? moneyRaw(row.amount) : ""; el.select(); }
  });
  inc.addEventListener("focusout", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-main")) { const v = incOf(el)[el.dataset.field]; el.value = moneyInput(v); }
    else if (el.classList.contains("src-amt")) { const row = extraOf(el); el.value = row ? moneyInput(row.amount) : ""; }
  });
  inc.addEventListener("click", (e) => {
    const add = e.target.closest(".inc-add");
    if (add) {
      const o = S.estimator.incomes[+add.dataset.app];
      if (o) { if (!o.extra) o.extra = []; o.extra.push({ label: "", amount: 0 }); }
      renderIncomes(); render();
      const names = inc.querySelectorAll(`.src-row[data-app="${add.dataset.app}"] .src-name`);
      if (names.length) names[names.length - 1].focus();
      return;
    }
    const del = e.target.closest(".src-del"); if (!del) return;
    const o = S.estimator.incomes[+del.dataset.app];
    if (o && o.extra) o.extra.splice(+del.dataset.idx, 1);
    renderIncomes(); render();
  });

  bindMoney("bp-expenses", () => S.estimator.expenses, (v) => { S.estimator.expenses = v; });
  bindMoney("bp-cc", () => S.estimator.ccLimit, (v) => { S.estimator.ccLimit = v; });
  bindMoney("bp-otherdebt", () => S.estimator.otherDebt, (v) => { S.estimator.otherDebt = v; });
  byId("bp-deps").addEventListener("input", () => { S.estimator.dependents = Math.max(0, Math.round(parseNum(byId("bp-deps").value))); renderEstimator(); });
  byId("bpApply").addEventListener("click", () => {
    const est = estimateBorrowingPower();
    if (!(est.power > 0)) return;
    S.loan = Math.round(est.power);
    S.locked = ["deposit", "loan"]; // solve property & repayment from this loan + your deposit
    render();
    window.scrollTo({ top: 0, behavior: REDUCE_MOTION.matches ? "auto" : "smooth" });
  });

  /* ---------- Government schemes — these only affect scheme eligibility + LMI waiver,
       so use the lightweight renderSchemeArea() (no chart/schedule repaint). Keeps
       changing the location snappy. ---------- */
  byId("fhSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.buyer.firstHome = b.dataset.fh === "yes"; renderSchemeArea();
  });
  byId("regionSel").addEventListener("change", (e) => { S.buyer.region = e.target.value; renderSchemeArea(); });
}
