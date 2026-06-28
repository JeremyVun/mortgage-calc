import { S, depositTotal, FREQ_PPY } from "./state.js";

/* ===== Borrowing-power constants (public AU serviceability methodology, FY2024-25) =====
   Tweakable in one place. CALIBRATED EMPIRICALLY against CommBank's live "How much can I
   borrow" calculator (driven headless across ~55 scenarios, Jun 2026). Key findings:
   • CBA's HEM living-expense floor is INCOME-SCALED, not flat — this was the main over-
     estimation bug. The tables below are HEM $/mo keyed on TOTAL assessable income, derived
     by isolating CBA's net income (high-expense runs) from its floor ($0-expense runs).
   • CBA's after-tax (net) income matches our ATO tax fns below within ~0.5%, so tax is untouched.
   • CBA's public calculator credits "other income" (bonus/overtime/dividends) at 100% and
     rental at ~85%; credit-card limit assessed ~3.75%/mo; each dependent child ≈ $455/mo HEM.
   Sources: APRA (3.0pp buffer kept Jul 2025), CBA (5.40% floor, 9.09% assessed at 6.09% product). */
export const BP = {
  FLOOR_RATE: 5.40,     // assessment rate = max(rate + buffer, floor)
  CC_FACTOR: 0.0380,    // assessed monthly repayment = 3.8% of card LIMIT (even at $0 balance)
  HEM_CHILD: 455,       // added to the HEM floor per dependent child
  SHADE_OT: 1.00,       // "other income" (OT/bonus/dividends): CBA's calculator counts 100%.
  SHADE_BONUS: 1.00,    //   (set to 0.80 for a more conservative, real-underwriting view.)
  SHADE_RENT: 0.85,     // rental income counted at 85%
  DTI: 6.0,             // soft cap: max loan ~ 6x gross income
  // HEM living-expense floor ($/mo, excl. rent/mortgage) vs TOTAL assessable income ($/yr).
  // Piecewise-linear; scales toward 0 below the first anchor, extrapolates above the last.
  HEM_SINGLE: [[40000,1450],[60000,1626],[80000,1820],[100000,2085],[120000,2467],
               [150000,2813],[170000,3151],[200000,3407],[250000,3644],[350000,4888]],
  HEM_COUPLE: [[100000,3294],[160000,4016],[220000,4846],[300000,5375],[400000,6088]],
};
/* Interpolate a [income, value] anchor table at x (income $/yr). */
function lerpTable(table, x) {
  if (x <= table[0][0]) return table[0][1] * (x / table[0][0]);
  for (let k = 0; k < table.length - 1; k++) {
    if (x <= table[k + 1][0]) {
      const [x0, y0] = table[k], [x1, y1] = table[k + 1];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  const [x0, y0] = table[table.length - 2], [x1, y1] = table[table.length - 1];
  return y1 + (y1 - y0) / (x1 - x0) * (x - x1);
}
/* HEM living-expense floor for a household at a given total assessable income.
   The interpolated base is clamped to a sane band so it neither decays toward $0
   below the lowest income anchor nor extrapolates without bound above the highest. */
function hemFloor(household, totalAssessable, dependents) {
  const couple = household === "couple";
  const table = couple ? BP.HEM_COUPLE : BP.HEM_SINGLE;
  const lo = couple ? 2400 : 1450, hi = couple ? 7500 : 6000;
  const base = Math.max(lo, Math.min(hi, lerpTable(table, totalAssessable || 0)));
  return base + (dependents || 0) * BP.HEM_CHILD;
}
// AU resident income tax, FY2024-25 / FY2025-26 (16c second bracket; drops to 15c from 1 Jul 2026).
function incomeTaxAU(ti) {
  if (ti <= 18200) return 0;
  if (ti <= 45000) return (ti - 18200) * 0.16;
  if (ti <= 135000) return 4288 + (ti - 45000) * 0.30;
  if (ti <= 190000) return 31288 + (ti - 135000) * 0.37;
  return 51638 + (ti - 190000) * 0.45;
}
function medicareAU(ti) {
  if (ti <= 27222) return 0;
  if (ti <= 34027) return (ti - 27222) * 0.10; // shade-in
  return ti * 0.02;
}
function litoAU(ti) {
  if (ti <= 37500) return 700;
  if (ti <= 45000) return 700 - (ti - 37500) * 0.05;
  if (ti <= 66667) return Math.max(0, 325 - (ti - 45000) * 0.015);
  return 0;
}
function afterTaxAU(g) {
  if (!(g > 0)) return 0;
  return g - (Math.max(0, incomeTaxAU(g) - litoAU(g)) + medicareAU(g));
}

/* Estimate borrowing power the way a lender assesses serviceability (all monthly, p=12). */
export function estimateBorrowingPower() {
  const e = S.estimator;
  const assessmentRate = Math.max(S.rate + S.buffer, BP.FLOOR_RATE);
  let netAnnual = 0, grossAnnual = 0, assessableAnnual = 0;
  for (let idx = 0; idx < e.applicants; idx++) {
    const inc = e.incomes[idx] || { base: 0, variable: 0 };
    let assessableGross = (inc.base || 0) + (inc.variable || 0) * BP.SHADE_OT; // OT/bonus
    if (idx === 0) assessableGross += (e.rental || 0) * BP.SHADE_RENT; // attribute rental to primary applicant
    netAnnual += afterTaxAU(assessableGross);
    assessableAnnual += assessableGross; // HEM is keyed on total assessable income (matches CBA)
    grossAnnual += (inc.base || 0) + (inc.variable || 0);
  }
  grossAnnual += e.rental || 0; // unshaded, for the DTI cap
  const netMonthly = netAnnual / 12;
  const hem = hemFloor(e.household, assessableAnnual, e.dependents);
  const expensesMonthly = Math.max(e.expenses || 0, hem);
  const hemBinds = (e.expenses || 0) <= hem;
  const commitments = (e.otherDebt || 0) + (e.ccLimit || 0) * BP.CC_FACTOR;
  const surplus = netMonthly - expensesMonthly - commitments;
  const serviceLoan = surplus > 0 ? loanFromPmt(surplus, assessmentRate, S.termYears, 12) : 0;
  const dtiLoan = e.dtiOn ? Math.max(0, BP.DTI * grossAnnual - (e.existingDebt || 0)) : Infinity;
  const power = Math.max(0, Math.min(serviceLoan, dtiLoan));
  const bound = surplus <= 0 ? "fail" : (serviceLoan <= dtiLoan ? "serviceability" : "dti");
  return { assessmentRate, netMonthly, hem, expensesMonthly, hemBinds, commitments, surplus, serviceLoan, dtiLoan, power, bound, grossAnnual };
}

/* ============================ Math ============================ */
export const ppy = () => FREQ_PPY[S.freq];

export function pmt(L, annualPct, years, p) {
  if (!(L > 0)) return 0;
  const i = annualPct / 100 / p, n = years * p;
  if (i === 0) return L / n;
  return (L * i) / (1 - Math.pow(1 + i, -n));
}
export function loanFromPmt(R, annualPct, years, p) {
  if (!(R > 0)) return 0;
  const i = annualPct / 100 / p, n = years * p;
  if (i === 0) return R * n;
  return (R * (1 - Math.pow(1 + i, -n))) / i;
}

/* Solve the system from the two locked figures. Returns a full snapshot. */
export function solve() {
  const p = ppy();
  const aRate = S.rate + S.buffer;
  const L_isLocked = S.locked.includes("loan");
  const R_isLocked = S.locked.includes("repayment");
  const P_isLocked = S.locked.includes("property");
  const D_isLocked = S.locked.includes("deposit");
  const D_input = depositTotal(); // your deposit when it is the locked anchor

  // ---- loan size ----
  let L;
  if (L_isLocked) {
    L = S.loan;
  } else if (R_isLocked) {
    const basisRate = S.repaymentBasis === "assessed" ? aRate : S.rate;
    L = loanFromPmt(S.repayment, basisRate, S.termYears, p);
  } else {
    // both property & deposit locked
    L = S.property - D_input;
  }

  // ---- position (property / deposit) ----
  let P, D;
  if (P_isLocked) {
    P = S.property; D = P - L;
  } else if (D_isLocked) {
    D = D_input; P = L + D;
  } else {
    // neither locked -> {loan,repayment} would be forbidden; defensive fallback
    P = S.property; D = P - L;
  }

  const rActual = pmt(L, S.rate, S.termYears, p);
  const rAssessed = pmt(L, aRate, S.termYears, p);

  // write derived values back so inputs reflect them
  if (!L_isLocked) S.loan = L;
  if (!P_isLocked) S.property = P;
  S.deposit = D; // effective deposit (input sum when locked, solved requirement otherwise)
  if (!R_isLocked) S.repayment = S.repaymentBasis === "assessed" ? rAssessed : rActual;

  const n = S.termYears * p;
  const totalRepaid = rActual * n;
  const totalInterest = totalRepaid - L;
  const lvr = P > 0 ? (L / P) * 100 : 0;
  const depPct = P > 0 ? (D / P) * 100 : 0;

  return { p, aRate, L, P, D, rActual, rAssessed, n, totalRepaid, totalInterest, lvr, depPct, availableFunds: D_input };
}

/* Per-payment amortisation rows (one per period: monthly/fortnightly/weekly). */
export function periodRows(L, annualPct, years, p) {
  const i = annualPct / 100 / p, n = years * p, M = pmt(L, annualPct, years, p);
  let bal = L; const rows = [];
  for (let k = 1; k <= n; k++) {
    const int = i === 0 ? 0 : bal * i;
    let prin = M - int; if (prin > bal) prin = bal;
    bal -= prin;
    rows.push({ k, interest: int, principal: prin, balance: Math.max(0, bal) });
  }
  return rows;
}

/* ---- amortisation schedule + chart ---- */
export function amortize(L, annualPct, years, p) {
  const i = annualPct / 100 / p, n = years * p;
  const M = pmt(L, annualPct, years, p);
  let bal = L, intCum = 0, yrInt = 0, yrPrin = 0;
  const pts = [{ yr: 0, bal: L }];
  const rows = []; // one per year: {yr, interest, principal, balance}
  for (let k = 1; k <= n; k++) {
    const int = i === 0 ? 0 : bal * i;
    let prin = M - int;
    if (prin > bal) prin = bal;
    bal -= prin; intCum += int; yrInt += int; yrPrin += prin;
    if (k % p === 0 || k === n) {
      pts.push({ yr: k / p, bal: Math.max(0, bal) });
      rows.push({ yr: Math.ceil(k / p), interest: yrInt, principal: yrPrin, balance: Math.max(0, bal) });
      yrInt = 0; yrPrin = 0;
    }
  }
  return { pts, rows, totalInterest: intCum, M };
}
