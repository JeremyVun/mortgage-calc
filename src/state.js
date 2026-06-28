/* ============================ State ============================ */
/* A fresh per-applicant income block: a salary + bonus box (the common case) plus an
   optional list of extra income lines (rental / other) the user adds on demand. */
export function freshIncome() { return { salary: 0, bonus: 0, extra: [], hecs: false }; }

export const S = {
  rate: 6.0,
  termYears: 30,
  freq: "fortnightly",
  property: 1000000,
  deposit: 0,               // effective deposit (= sum of sources when locked, else solved)
  depositSources: [         // your funding sources; their sum is your deposit. Starts blank.
    { name: "", amount: 0 },
  ],
  loan: 800000,
  repayment: 0,             // repayment capacity — always your ACTUAL repayment at your rate
  extra: 0,                 // optional extra paid on top of every scheduled repayment (per period)
  estimator: {                // "will a bank lend me?" — AU serviceability estimate
    applicants: 1,
    // One income block PER applicant: salary + bonus boxes, plus extra lines (rental/other)
    // and a HECS/HELP flag. Household type is DERIVED from applicant count (1→single, 2→couple).
    incomes: [freshIncome(), freshIncome()],
    dependents: 0,
    expenses: 0,              // declared monthly living expenses (0 => HEM floor applies)
    ccLimit: 0,               // total credit-card / revolving limit
    otherDebt: 0,             // existing monthly debt repayments
  },
  buyer: {                    // for LMI + First Home Guarantee eligibility
    firstHome: true,
    region: "NSW · cities",   // matches a REGIONS[].label in finance.js (label is the key now)
  },
  locked: ["property", "loan"], // exactly 2, never {loan,repayment}
  ui: {                       // view state (persisted): collapsible panels + schedule granularity
    rates: true, figures: true, estimator: true, schemes: false,
    schedMode: "period",      // "period" (per selected repayment frequency) | "yearly"
  },
};

export function depositTotal() { return S.depositSources.reduce((a, s) => a + (isFinite(s.amount) ? s.amount : 0), 0); }

export const FREQ_PPY = { monthly: 12, fortnightly: 26, weekly: 52 };
export const FREQ_LABEL = { monthly: "month", fortnightly: "fortnight", weekly: "week" };
export const FREQ_TITLE = { monthly: "Monthly", fortnightly: "Fortnightly", weekly: "Weekly" };

/* ============================ Persistence keys ============================ */
export const STORAGE_KEY = "mortgage-calc/v2";
// Only the INPUT state is persisted; derived fields are recomputed by solve() on restore.
export const PERSIST_KEYS = ["rate", "termYears", "freq", "property", "deposit",
  "depositSources", "loan", "repayment", "extra", "estimator", "buyer", "locked", "ui"];
