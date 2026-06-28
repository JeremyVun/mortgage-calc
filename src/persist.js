import { S, STORAGE_KEY, PERSIST_KEYS } from "./state.js";
import { parseNum } from "./format.js";

/* ============================ Persistence (localStorage) ============================ */
export function saveState() {
  try {
    const out = {};
    for (const k of PERSIST_KEYS) out[k] = S[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch (e) { /* private mode / quota — fail silently */ }
}
let saveTimer = null;
export function saveStateSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 250); }

// Restore saved inputs, validating each field and MERGING over the defaults so that
// newly-added fields (absent from old saves) keep their default rather than breaking.
export function restoreState() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (e) { return; }
  if (!data || typeof data !== "object") return;
  const num = (v) => typeof v === "number" && isFinite(v);
  if (num(data.rate)) S.rate = Math.min(12, Math.max(0, data.rate));
  if (num(data.buffer)) S.buffer = Math.min(5, Math.max(0, data.buffer));
  if ([10, 15, 20, 25, 30, 35, 40].includes(data.termYears)) S.termYears = data.termYears;
  if (["monthly", "fortnightly", "weekly"].includes(data.freq)) S.freq = data.freq;
  if (num(data.property)) S.property = data.property;
  if (num(data.deposit)) S.deposit = data.deposit;
  if (num(data.loan)) S.loan = data.loan;
  if (num(data.repayment)) S.repayment = data.repayment;
  if (["assessed", "actual"].includes(data.repaymentBasis)) S.repaymentBasis = data.repaymentBasis;
  if (num(data.costs)) S.costs = data.costs;
  if (Array.isArray(data.depositSources)) {
    const src = data.depositSources
      .filter((s) => s && typeof s === "object")
      .map((s) => ({ name: String(s.name == null ? "" : s.name), amount: num(s.amount) ? s.amount : parseNum(s.amount) }));
    if (src.length) S.depositSources = src;
  }
  if (data.estimator && typeof data.estimator === "object") {
    const d = data.estimator, e = S.estimator;
    if (d.applicants === 1 || d.applicants === 2) e.applicants = d.applicants;
    if (Array.isArray(d.incomes)) e.incomes = d.incomes.map((x) => ({ base: num(x && x.base) ? x.base : 0, variable: num(x && x.variable) ? x.variable : 0 }));
    while (e.incomes.length < 2) e.incomes.push({ base: 0, variable: 0 });
    if (num(d.rental)) e.rental = d.rental;
    if (["single", "couple"].includes(d.household)) e.household = d.household;
    if (num(d.dependents)) e.dependents = Math.max(0, Math.round(d.dependents));
    if (num(d.expenses)) e.expenses = d.expenses;
    if (num(d.ccLimit)) e.ccLimit = d.ccLimit;
    if (num(d.otherDebt)) e.otherDebt = d.otherDebt;
    if (num(d.existingDebt)) e.existingDebt = d.existingDebt;
    if (typeof d.dtiOn === "boolean") e.dtiOn = d.dtiOn;
  }
  if (Array.isArray(data.locked)) {
    const lk = [...new Set(data.locked)].filter((k) => ["property", "deposit", "loan", "repayment"].includes(k));
    const forbidden = lk.includes("loan") && lk.includes("repayment");
    if (lk.length === 2 && !forbidden) S.locked = lk;
  }
  if (data.ui && typeof data.ui === "object") {
    for (const k of ["rates", "figures", "costs", "estimator"]) if (typeof data.ui[k] === "boolean") S.ui[k] = data.ui[k];
    if (["yearly", "period"].includes(data.ui.schedMode)) S.ui.schedMode = data.ui.schedMode;
  }
}
export function resetState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  location.reload();
}
// Apply persisted open/closed state to the collapsible panels.
export function applyPanels() {
  document.querySelectorAll("details[data-ui]").forEach((d) => {
    const k = d.dataset.ui;
    if (k in S.ui) d.open = !!S.ui[k];
  });
}
