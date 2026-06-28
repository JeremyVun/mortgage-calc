/* ============================ State ============================ */
export const S = {
  rate: 6.0,
  buffer: 3.0,
  termYears: 30,
  freq: "fortnightly",
  property: 1000000,
  deposit: 200000,          // effective deposit (= sum of sources when locked, else solved)
  depositSources: [         // your funding sources; their sum is your deposit
    { name: "Savings", amount: 200000 },
  ],
  loan: 800000,
  repayment: 0,             // assessed repayment capacity (by default)
  repaymentBasis: "assessed", // "assessed" | "actual"
  costs: 0,
  estimator: {                // "what will a bank lend me?" — AU serviceability estimate
    applicants: 1,
    incomes: [{ base: 120000, variable: 0 }, { base: 90000, variable: 0 }],
    rental: 0,
    household: "single",      // single | couple
    dependents: 0,
    expenses: 0,              // declared monthly living expenses (0 => HEM floor applies)
    ccLimit: 0,               // total credit-card / revolving limit
    otherDebt: 0,             // existing monthly debt repayments
    dtiOn: true,
    existingDebt: 0,          // outstanding balances, for the 6x DTI cap
  },
  locked: ["property", "deposit"], // exactly 2, never {loan,repayment}
  ui: {                       // view state (persisted): collapsible panels + schedule granularity
    rates: true, figures: true, costs: true, estimator: false,
    schedMode: "yearly",      // "yearly" | "period" (per selected repayment frequency)
  },
};
export function depositTotal() { return S.depositSources.reduce((a, s) => a + (isFinite(s.amount) ? s.amount : 0), 0); }

export const FREQ_PPY = { monthly: 12, fortnightly: 26, weekly: 52 };
export const FREQ_LABEL = { monthly: "month", fortnightly: "fortnight", weekly: "week" };
export const FREQ_SHORT = { monthly: "/mo", fortnightly: "/fn", weekly: "/wk" };
export const FREQ_TITLE = { monthly: "Monthly", fortnightly: "Fortnightly", weekly: "Weekly" };

/* ============================ Persistence keys ============================ */
export const STORAGE_KEY = "mortgage-calc/v1";
// Only the INPUT state is persisted; derived fields are recomputed by solve() on restore.
export const PERSIST_KEYS = ["rate", "buffer", "termYears", "freq", "property", "deposit",
  "depositSources", "loan", "repayment", "repaymentBasis", "costs", "estimator", "locked", "ui"];
