import { S } from "./state.js";
import { estimateBorrowingPower } from "./finance.js";
import { parseNum, nf0 } from "./format.js";
import { byId, REDUCE_MOTION } from "./dom.js";
import { render, renderSources, renderIncomes, syncBpSegs, renderEstimator, renderSchemeArea, setActiveEdit } from "./render.js";
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

  // servicing buffer (lives in the borrowing-power section now) — field + ± steppers
  const bufNum = byId("buffer-num");
  const setBuffer = (v) => { S.buffer = Math.min(5, Math.max(0, isFinite(v) ? v : 0)); render(); };
  bufNum.addEventListener("input", () => setBuffer(parseNum(bufNum.value)));
  bufNum.addEventListener("blur", () => { bufNum.value = S.buffer.toFixed(2); });
  byId("bufMinus").addEventListener("click", () => setBuffer(Math.round((S.buffer - 0.25) * 100) / 100));
  byId("bufPlus").addEventListener("click", () => setBuffer(Math.round((S.buffer + 0.25) * 100) / 100));

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

  // extra repayments (paid on top of each scheduled repayment, in the selected frequency)
  const extra = byId("f-extra");
  extra.addEventListener("focus", () => { extra.value = S.extra ? String(Math.round(S.extra)) : ""; extra.select(); });
  extra.addEventListener("input", () => { S.extra = parseNum(extra.value); render(); });
  extra.addEventListener("blur", () => { extra.value = S.extra ? nf0.format(Math.round(S.extra)) : ""; });

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
    if (el.classList.contains("dep-amt")) { const a = S.depositSources[+el.dataset.idx].amount; el.value = a ? String(Math.round(a)) : ""; el.select(); }
  });
  dep.addEventListener("focusout", (e) => {
    const el = e.target;
    if (el.classList.contains("dep-amt")) { const a = S.depositSources[+el.dataset.idx].amount; el.value = a ? nf0.format(Math.round(a)) : ""; }
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

  /* ---------- borrowing-power estimator ---------- */
  const bindBpMoney = (elId, get, set) => {
    const el = byId(elId);
    el.addEventListener("focus", () => { el.value = get() ? String(Math.round(get())) : ""; el.select(); });
    el.addEventListener("input", () => { set(parseNum(el.value)); renderEstimator(); });
    el.addEventListener("blur", () => { el.value = get() ? nf0.format(Math.round(get())) : ""; });
  };
  byId("bpApplicants").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.estimator.applicants = parseInt(b.dataset.app, 10); // household type is derived from this
    renderIncomes(); syncBpSegs(); render();
  });

  // income blocks (per applicant): salary + bonus boxes, extra income lines, HECS toggle.
  // Delegated on the container; rebuilt only on add/remove/applicant change so typing keeps caret.
  const inc = byId("bpIncomes");
  const incOf = (el) => S.estimator.incomes[+el.dataset.app];
  const extraOf = (el) => { const o = incOf(el); return o && o.extra ? o.extra[+el.dataset.idx] : null; };
  inc.addEventListener("input", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-main")) { const o = incOf(el); if (o) { o[el.dataset.field] = parseNum(el.value); render(); } } // salary / bonus
    else if (el.classList.contains("inc-amt")) { const row = extraOf(el); if (row) { row.amount = parseNum(el.value); render(); } } // extra income drives schemes too
    else if (el.classList.contains("inc-name")) { const row = extraOf(el); if (row) { row.label = el.value; saveStateSoon(); } } // label feeds no calc
  });
  inc.addEventListener("change", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-kind")) { const row = extraOf(el); if (row) { row.kind = el.value; render(); } }
    else if (el.classList.contains("hecs-check")) { const o = incOf(el); if (o) { o.hecs = el.checked; render(); } }
  });
  inc.addEventListener("focusin", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-main")) { const v = incOf(el)[el.dataset.field]; el.value = v ? String(Math.round(v)) : ""; el.select(); }
    else if (el.classList.contains("inc-amt")) { const row = extraOf(el); el.value = row && row.amount ? String(Math.round(row.amount)) : ""; el.select(); }
  });
  inc.addEventListener("focusout", (e) => {
    const el = e.target;
    if (el.classList.contains("inc-main")) { const v = incOf(el)[el.dataset.field]; el.value = v ? nf0.format(Math.round(v)) : ""; }
    else if (el.classList.contains("inc-amt")) { const row = extraOf(el); el.value = row && row.amount ? nf0.format(Math.round(row.amount)) : ""; }
  });
  inc.addEventListener("click", (e) => {
    const add = e.target.closest(".inc-add");
    if (add) {
      const o = S.estimator.incomes[+add.dataset.app];
      if (o) { if (!o.extra) o.extra = []; o.extra.push({ label: "", amount: 0, kind: "rental" }); }
      renderIncomes(); render();
      const names = inc.querySelectorAll(`.inc-row[data-app="${add.dataset.app}"] .inc-name`);
      if (names.length) names[names.length - 1].focus();
      return;
    }
    const del = e.target.closest(".inc-del"); if (!del) return;
    const o = S.estimator.incomes[+del.dataset.app];
    if (o && o.extra) o.extra.splice(+del.dataset.idx, 1);
    renderIncomes(); render();
  });

  bindBpMoney("bp-expenses", () => S.estimator.expenses, (v) => { S.estimator.expenses = v; });
  bindBpMoney("bp-cc", () => S.estimator.ccLimit, (v) => { S.estimator.ccLimit = v; });
  bindBpMoney("bp-otherdebt", () => S.estimator.otherDebt, (v) => { S.estimator.otherDebt = v; });
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
  byId("pkSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    S.buyer.propertyKind = b.dataset.pk; renderSchemeArea();
  });
  byId("regionSel").addEventListener("change", (e) => { S.buyer.region = e.target.value; renderSchemeArea(); });

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
