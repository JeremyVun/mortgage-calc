/* ============================ State ============================ */
/* A fresh per-applicant income block: a salary + bonus box (the common case) plus an
   optional list of extra income lines (rental / other) the user adds on demand. */
export function freshIncome() { return { salary: 0, bonus: 0, extra: [], hecs: false }; }

export const S = {
  rate: 6.0,
  buffer: 3.0,              // servicing buffer — used ONLY by the borrowing-power estimate
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
  buyer: {                    // for LMI + government-scheme eligibility
    firstHome: true,
    propertyKind: "established", // "established" | "new"
    region: "nsw-cap",        // keyed into SCHEME price-cap regions (see schemes.js)
  },
  locked: ["property", "loan"], // exactly 2, never {loan,repayment}
  ui: {                       // view state (persisted): collapsible panels + schedule granularity
    rates: true, figures: true, estimator: true, schemes: false,
    schedMode: "period",      // "period" (per selected repayment frequency) | "yearly"
  },
};

/* Extra income-line kinds (salary & bonus have their own boxes, so these are the
   "add another income" options). `shade` is how much a lender counts toward
   serviceability — rental is haircut to 85%, other counted in full (matching CBA). */
export const INCOME_KINDS = [
  { id: "rental", label: "Rental income" },
  { id: "other",  label: "Other income" },
];
export const INCOME_SHADE = { salary: 1.0, bonus: 1.0, rental: 0.85, other: 1.0 };

export function depositTotal() { return S.depositSources.reduce((a, s) => a + (isFinite(s.amount) ? s.amount : 0), 0); }

export const FREQ_PPY = { monthly: 12, fortnightly: 26, weekly: 52 };
export const FREQ_LABEL = { monthly: "month", fortnightly: "fortnight", weekly: "week" };
export const FREQ_SHORT = { monthly: "/mo", fortnightly: "/fn", weekly: "/wk" };
export const FREQ_TITLE = { monthly: "Monthly", fortnightly: "Fortnightly", weekly: "Weekly" };

/* ============================ Persistence keys ============================ */
export const STORAGE_KEY = "mortgage-calc/v2";
// Only the INPUT state is persisted; derived fields are recomputed by solve() on restore.
export const PERSIST_KEYS = ["rate", "buffer", "termYears", "freq", "property", "deposit",
  "depositSources", "loan", "repayment", "extra", "estimator", "buyer", "locked", "ui"];
