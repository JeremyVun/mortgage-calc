import { S, depositTotal, FREQ_PPY, INCOME_SHADE } from "./state.js";

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
  // income shading (salary/bonus/other at 100%, rental at ~85%) now lives in state.INCOME_SHADE
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
   `couple` is derived from the applicant count (2 applicants → couple). The
   interpolated base is clamped to a sane band so it neither decays toward $0 below
   the lowest income anchor nor extrapolates without bound above the highest. */
function hemFloor(couple, totalAssessable, dependents) {
  const table = couple ? BP.HEM_COUPLE : BP.HEM_SINGLE;
  const lo = couple ? 2400 : 1450, hi = couple ? 7500 : 6000;
  const base = Math.max(lo, Math.min(hi, lerpTable(table, totalAssessable || 0)));
  return base + (dependents || 0) * BP.HEM_CHILD;
}

/* Compulsory HECS/HELP repayment ($/yr) on a repayment income, ATO FY2024-25 rate
   table (whole-of-income percentage). A real serviceability commitment that continues
   until the debt clears, so lenders deduct it. Returns 0 below the first threshold. */
// [upper-bound-of-bracket, rate]: the first row whose bound the income falls under wins.
export const HECS_TABLE = [
  [62851, 0.010], [66621, 0.020], [70619, 0.025], [74856, 0.030], [79347, 0.035],
  [84108, 0.040], [89155, 0.045], [94504, 0.050], [100175, 0.055], [106186, 0.060],
  [112557, 0.065], [119310, 0.070], [126468, 0.075], [134057, 0.080], [142101, 0.085],
  [150627, 0.090], [159664, 0.095], [Infinity, 0.100],
];
export function hecsRepaymentAnnual(income) {
  if (!(income >= 54435)) return 0; // below the FY2024-25 minimum repayment threshold
  let rate = 0.10;
  for (const [ceil, r] of HECS_TABLE) { if (income < ceil) { rate = r; break; } }
  return income * rate;
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

/* Sum one applicant's income (salary + bonus + extra lines) into a shaded-assessable
   total and a raw total. `shaded` is what a lender counts (rental haircut to 85%);
   `raw` is the headline gross. */
function sumIncome(inc) {
  const n = (v) => (isFinite(v) ? v : 0);
  let shaded = n(inc && inc.salary) + n(inc && inc.bonus);
  let raw = shaded;
  for (const r of (inc && inc.extra) || []) {
    const amt = r && isFinite(r.amount) ? r.amount : 0;
    shaded += amt * (INCOME_SHADE[r && r.kind] ?? 1);
    raw += amt;
  }
  return { shaded, raw };
}

/* Estimate borrowing power the way a lender assesses serviceability (all monthly, p=12). */
export function estimateBorrowingPower() {
  const e = S.estimator;
  const couple = e.applicants === 2; // household type is derived from applicant count
  const assessmentRate = Math.max(S.rate + S.buffer, BP.FLOOR_RATE);
  let netAnnual = 0, grossAnnual = 0, assessableAnnual = 0, hecsAnnual = 0;
  for (let idx = 0; idx < e.applicants; idx++) {
    const inc = e.incomes[idx];
    const { shaded, raw } = sumIncome(inc); // tax & HEM key on shaded assessable income
    netAnnual += afterTaxAU(shaded);
    assessableAnnual += shaded;
    grossAnnual += raw; // unshaded, for the DTI cap
    if (inc && inc.hecs) hecsAnnual += hecsRepaymentAnnual(raw); // HECS keys on repayment income
  }
  const netMonthly = netAnnual / 12;
  const hem = hemFloor(couple, assessableAnnual, e.dependents);
  const expensesMonthly = Math.max(e.expenses || 0, hem);
  const hemBinds = (e.expenses || 0) <= hem;
  const hecsMonthly = hecsAnnual / 12;
  const commitments = (e.otherDebt || 0) + (e.ccLimit || 0) * BP.CC_FACTOR + hecsMonthly;
  const surplus = netMonthly - expensesMonthly - commitments;
  const serviceLoan = surplus > 0 ? loanFromPmt(surplus, assessmentRate, S.termYears, 12) : 0;
  // The 6× debt-to-income limit is a real APRA-flagged lending ceiling — always applied.
  const dtiLoan = Math.max(0, BP.DTI * grossAnnual);
  const power = Math.max(0, Math.min(serviceLoan, dtiLoan));
  const bound = surplus <= 0 ? "fail" : (serviceLoan <= dtiLoan ? "serviceability" : "dti");
  return { assessmentRate, netMonthly, hem, expensesMonthly, hemBinds, hecsMonthly, commitments, surplus, serviceLoan, dtiLoan, power, bound, grossAnnual };
}

/* ===================== LMI (Lenders Mortgage Insurance) =====================
   Premium as a % of the LOAN (not property), rising with both LVR and loan size.
   Table is a widely-published Helia/QBE-style owner-occupier P&I rate card (Jun 2026):
   columns are the top-of-band rate at ~85 / ~90 / ~95% LVR; we interpolate within a band.
   Real quotes vary materially by insurer/lender (±30-50%) and attract state stamp duty —
   this is a planning estimate, not a quote. Source: homeloanexperts / money.com.au / Helia. */
export const LMI_TABLE = [
  { max: 300000,   r: [0.73, 1.46, 2.61] },
  { max: 500000,   r: [0.97, 1.87, 3.35] },
  { max: 750000,   r: [1.25, 2.27, 4.30] },
  { max: 1000000,  r: [1.41, 2.52, 4.60] },
  { max: Infinity, r: [1.50, 2.60, 4.70] },
];
/* Estimated LMI for a loan against a property. Returns premium $, the % rate used,
   the LVR, and a `capped` flag when LVR exceeds the 95% most insurers will write. */
export function estimateLMI(loan, propertyValue) {
  const lvr = propertyValue > 0 ? (loan / propertyValue) * 100 : 0;
  if (!(loan > 0) || lvr <= 80) return { premium: 0, rate: 0, lvr, capped: false };
  const band = LMI_TABLE.find((b) => loan <= b.max) || LMI_TABLE[LMI_TABLE.length - 1];
  const [r85, r90, r95] = band.r;
  const eff = Math.min(lvr, 95); // clamp; >95% is generally unwritable outside a scheme/guarantor
  let rate;
  if (eff <= 85) rate = ((eff - 80) / 5) * r85;             // 0 at 80% -> r85 at 85%
  else if (eff <= 90) rate = r85 + ((eff - 85) / 5) * (r90 - r85);
  else rate = r90 + ((eff - 90) / 5) * (r95 - r90);
  return { premium: (loan * rate) / 100, rate, lvr, capped: lvr > 95 };
}

/* ===================== Government schemes (FY2025-26) =====================
   First Home Guarantee (the "5% deposit, no LMI" scheme) — expanded 1 Oct 2025:
   income caps and place limits removed; only property price caps remain.
   Help to Buy — federal shared-equity scheme, live since 5 Dec 2025: min 2% deposit,
   Commonwealth takes up to 40% (new) / 30% (established) equity; income-capped.
   Price caps by region. Sources: housingaustralia.gov.au, firsthomebuyers.gov.au, treasury. */
export const REGIONS = [
  { id: "nsw-cap",  label: "NSW · Sydney, Newcastle, Illawarra", fhbg: 1500000, htb: 1300000 },
  { id: "nsw-rest", label: "NSW · rest of state",               fhbg: 800000,  htb: 800000 },
  { id: "vic-cap",  label: "VIC · Melbourne / Geelong",         fhbg: 950000,  htb: 950000 },
  { id: "vic-rest", label: "VIC · rest of state",               fhbg: 650000,  htb: 650000 },
  { id: "qld-cap",  label: "QLD · Brisbane, Gold & Sunshine Cst", fhbg: 1000000, htb: 1000000 },
  { id: "qld-rest", label: "QLD · rest of state",               fhbg: 700000,  htb: 700000 },
  { id: "wa-cap",   label: "WA · Perth",                        fhbg: 850000,  htb: 850000 },
  { id: "wa-rest",  label: "WA · rest of state",                fhbg: 600000,  htb: 600000 },
  { id: "sa-cap",   label: "SA · Adelaide",                     fhbg: 900000,  htb: 900000 },
  { id: "sa-rest",  label: "SA · rest of state",                fhbg: 500000,  htb: 500000 },
  { id: "tas-cap",  label: "TAS · Hobart",                      fhbg: 700000,  htb: 700000 },
  { id: "tas-rest", label: "TAS · rest of state",               fhbg: 550000,  htb: 550000 },
  { id: "act",      label: "ACT",                               fhbg: 1000000, htb: 1000000 },
  { id: "nt",       label: "NT",                                fhbg: 600000,  htb: 600000 },
];
export const HTB = { minDepositPct: 2, equityNew: 40, equityExisting: 30, incomeSingle: 100000, incomeJoint: 160000 };
export const FHBG = { minDepositPct: 5 };

/* Assess scheme eligibility against the current property, household & income.
   `r` is a solve() snapshot; `est` is an estimateBorrowingPower() snapshot. */
export function assessSchemes(r, est) {
  const b = S.buyer;
  const region = REGIONS.find((x) => x.id === b.region) || REGIONS[0];
  const P = r.P, p = ppy();

  // ---- First Home Guarantee (5% deposit, no LMI) ----
  const fCap = region.fhbg;
  const fUnderCap = P > 0 && P <= fCap;
  const fhbg = {
    eligible: b.firstHome && fUnderCap,
    firstHome: b.firstHome, underCap: fUnderCap, cap: fCap,
    minDeposit: P * (FHBG.minDepositPct / 100),
    lmiSaved: estimateLMI(P * 0.95, P).premium, // LMI you'd otherwise pay buying at 5% deposit
  };

  // ---- Help to Buy (shared equity) ----
  const hCap = region.htb;
  const hUnderCap = P > 0 && P <= hCap;
  const single = S.estimator.applicants === 1;
  const incomeCap = single ? HTB.incomeSingle : HTB.incomeJoint;
  const underIncome = est.grossAnnual <= incomeCap;
  const equityPct = b.propertyKind === "new" ? HTB.equityNew : HTB.equityExisting;
  const govEquity = P * (equityPct / 100);
  const minDeposit = P * (HTB.minDepositPct / 100);
  const buyerLoan = Math.max(0, P - govEquity - minDeposit);
  const htb = {
    eligible: b.firstHome && hUnderCap && underIncome,
    firstHome: b.firstHome, underCap: hUnderCap, cap: hCap,
    underIncome, incomeCap, single, equityPct, govEquity, minDeposit, buyerLoan,
    repayment: pmt(buyerLoan, S.rate, S.termYears, p),
    repayMonthly: pmt(buyerLoan, S.rate, S.termYears, 12),
  };

  return { region, fhbg, htb };
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

/* Solve the system from the two locked figures. Returns a full snapshot.
   Repayment capacity is ALWAYS the actual repayment at your rate — the servicing
   buffer lives only in the borrowing-power estimate, never here. */
export function solve() {
  const p = ppy();
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
    L = loanFromPmt(S.repayment, S.rate, S.termYears, p); // actual rate, always
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

  // write derived values back so inputs reflect them
  if (!L_isLocked) S.loan = L;
  if (!P_isLocked) S.property = P;
  S.deposit = D; // effective deposit (input sum when locked, solved requirement otherwise)
  if (!R_isLocked) S.repayment = rActual;

  const n = S.termYears * p;
  const totalRepaid = rActual * n;
  const totalInterest = totalRepaid - L;
  const lvr = P > 0 ? (L / P) * 100 : 0;
  const depPct = P > 0 ? (D / P) * 100 : 0;
  const monthly = pmt(L, S.rate, S.termYears, 12);

  return { p, L, P, D, rActual, monthly, n, totalRepaid, totalInterest, lvr, depPct, availableFunds: D_input };
}

/* Per-payment amortisation rows (one per period: monthly/fortnightly/weekly).
   `extra` is paid on top of every scheduled payment; the loan then clears early. */
export function periodRows(L, annualPct, years, p, extra = 0) {
  const i = annualPct / 100 / p, n = years * p, M = pmt(L, annualPct, years, p) + Math.max(0, extra);
  let bal = L; const rows = [];
  for (let k = 1; k <= n; k++) {
    const int = i === 0 ? 0 : bal * i;
    let prin = M - int; if (prin > bal) prin = bal;
    bal -= prin;
    rows.push({ k, interest: int, principal: prin, balance: Math.max(0, bal) });
    if (bal <= 0) break; // extra repayments cleared the loan early
  }
  return rows;
}

/* ---- amortisation schedule + chart ----
   `extra` (paid on top of every scheduled payment) shortens the loan; `payoffYears`
   reports when the balance actually hits zero so callers can show the time saved. */
export function amortize(L, annualPct, years, p, extra = 0) {
  const i = annualPct / 100 / p, n = years * p;
  const M = pmt(L, annualPct, years, p);
  const pay = M + Math.max(0, extra);
  let bal = L, intCum = 0, yrInt = 0, yrPrin = 0;
  const pts = [{ yr: 0, bal: L }];
  const rows = []; // one per year: {yr, interest, principal, balance}
  let last = 0;
  for (let k = 1; k <= n; k++) {
    last = k;
    const int = i === 0 ? 0 : bal * i;
    let prin = pay - int;
    if (prin > bal) prin = bal;
    bal -= prin; intCum += int; yrInt += int; yrPrin += prin;
    if (k % p === 0 || bal <= 0 || k === n) {
      pts.push({ yr: k / p, bal: Math.max(0, bal) });
      rows.push({ yr: Math.ceil(k / p), interest: yrInt, principal: yrPrin, balance: Math.max(0, bal) });
      yrInt = 0; yrPrin = 0;
    }
    if (bal <= 0) break;
  }
  return { pts, rows, totalInterest: intCum, M, pay, periods: last, payoffYears: last / p };
}
