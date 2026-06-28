// Shared helpers for the estimator unit tests.
//
// This file is intentionally NOT named `*.test.js`, so `node --test` will not run
// it as a test entry — it is only imported by the real test files.
//
// The estimator functions in src/finance.js read directly from the mutable global
// `S` singleton (src/state.js). Tests therefore mutate S and must reset it to a
// known baseline before each case.
import assert from "node:assert/strict";
import { S, freshIncome } from "../src/state.js";

/* Restore the global state singleton to a clean, deterministic baseline. Covers
   every field the estimator functions read (S.rate/termYears/freq plus the
   whole S.estimator and S.buyer blocks). Call from beforeEach(). */
export function resetState() {
  S.rate = 6.0;
  S.termYears = 30;
  S.freq = "fortnightly";
  S.property = 1000000;
  S.loan = 800000;
  S.estimator.applicants = 1;
  S.estimator.incomes = [freshIncome(), freshIncome()];
  S.estimator.dependents = 0;
  S.estimator.expenses = 0;
  S.estimator.ccLimit = 0;
  S.estimator.otherDebt = 0;
  S.buyer.firstHome = true;
  S.buyer.region = "NSW · cities";
}

/* Float comparison with a RELATIVE tolerance (scales with magnitude, so it works
   for both ~1e3 ratios and ~1e6 dollar figures without flaking on binary-float
   rounding). eps is the relative slack; absolute floor of `eps` keeps it sane near
   zero. */
export function approx(actual, expected, eps = 1e-9, msg) {
  const tol = eps * Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= tol,
    msg || `expected ${actual} ≈ ${expected} (|Δ|=${Math.abs(actual - expected)} > tol=${tol})`,
  );
}

/* Independent annuity oracles — deliberately re-implemented here rather than
   imported from finance.js, so tests check the production serviceability/repayment
   math against a SEPARATE derivation instead of against itself. Standard
   present-value-of-annuity formulas. */
export function annuityPayment(loan, annualPct, years, p) {
  if (!(loan > 0)) return 0;
  const i = annualPct / 100 / p, n = years * p;
  if (i === 0) return loan / n;
  return (loan * i) / (1 - Math.pow(1 + i, -n));
}
export function annuityLoan(payment, annualPct, years, p) {
  if (!(payment > 0)) return 0;
  const i = annualPct / 100 / p, n = years * p;
  if (i === 0) return payment * n;
  return (payment * (1 - Math.pow(1 + i, -n))) / i;
}

/* Terse applicant income-block builder for estimator tests. */
export function income({ salary = 0, bonus = 0, extra = [], hecs = false } = {}) {
  return { salary, bonus, extra, hecs };
}
