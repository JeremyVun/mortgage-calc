import { S, STORAGE_KEY, PERSIST_KEYS, freshIncome } from "./state.js";
import { parseNum } from "./format.js";

const isNum = (v) => typeof v === "number" && isFinite(v);
/* Normalise one applicant's saved income into the current {salary,bonus,extra,hecs}
   shape, validating each field so an old or corrupt save can't break load. Extra lines
   are {label, amount}: all assessable income counts at 100%. */
function normIncome(v) {
  const out = freshIncome();
  const amtOf = (x) => (isNum(x.amount) ? x.amount : parseNum(x.amount));
  if (v && typeof v === "object") {
    if (isNum(v.salary)) out.salary = v.salary;
    if (isNum(v.bonus)) out.bonus = v.bonus;
    if (typeof v.hecs === "boolean") out.hecs = v.hecs;
    if (Array.isArray(v.extra)) {
      out.extra = v.extra.filter((x) => x && typeof x === "object").map((x) => ({
        label: String(x.label == null ? "" : x.label),
        amount: amtOf(x),
      }));
    }
  }
  return out;
}

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
  if (isNum(data.rate)) S.rate = Math.min(12, Math.max(0, data.rate));
  if ([10, 15, 20, 25, 30, 35, 40].includes(data.termYears)) S.termYears = data.termYears;
  if (["monthly", "fortnightly", "weekly"].includes(data.freq)) S.freq = data.freq;
  if (isNum(data.property)) S.property = data.property;
  if (isNum(data.deposit)) S.deposit = data.deposit;
  if (isNum(data.loan)) S.loan = data.loan;
  if (isNum(data.repayment)) S.repayment = data.repayment;
  if (isNum(data.extra)) S.extra = Math.max(0, data.extra);
  if (Array.isArray(data.depositSources)) {
    const src = data.depositSources
      .filter((s) => s && typeof s === "object")
      .map((s) => ({ name: String(s.name == null ? "" : s.name), amount: isNum(s.amount) ? s.amount : parseNum(s.amount) }));
    if (src.length) S.depositSources = src;
  }
  if (data.estimator && typeof data.estimator === "object") {
    const d = data.estimator, e = S.estimator;
    if (d.applicants === 1 || d.applicants === 2) e.applicants = d.applicants;
    if (Array.isArray(d.incomes)) {
      e.incomes = d.incomes.slice(0, 2).map(normIncome);
      while (e.incomes.length < 2) e.incomes.push(freshIncome());
    }
    if (isNum(d.dependents)) e.dependents = Math.max(0, Math.round(d.dependents));
    if (isNum(d.expenses)) e.expenses = d.expenses;
    if (isNum(d.ccLimit)) e.ccLimit = d.ccLimit;
    if (isNum(d.otherDebt)) e.otherDebt = d.otherDebt;
  }
  if (data.buyer && typeof data.buyer === "object") {
    const d = data.buyer, bu = S.buyer;
    if (typeof d.firstHome === "boolean") bu.firstHome = d.firstHome;
    if (typeof d.region === "string" && d.region) bu.region = d.region; // validated against REGIONS at render
  }
  if (Array.isArray(data.locked)) {
    const lk = [...new Set(data.locked)].filter((k) => ["property", "deposit", "loan", "repayment"].includes(k));
    const forbidden = lk.includes("loan") && lk.includes("repayment");
    if (lk.length === 2 && !forbidden) S.locked = lk;
  }
  if (data.ui && typeof data.ui === "object") {
    for (const k of ["rates", "figures", "estimator", "schemes"]) if (typeof data.ui[k] === "boolean") S.ui[k] = data.ui[k];
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
