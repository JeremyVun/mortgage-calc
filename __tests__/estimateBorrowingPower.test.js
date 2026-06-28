// Tests for estimateBorrowingPower() — the AU serviceability estimate. It reads the
// whole S.estimator block plus S.rate/termYears and returns a snapshot of
// every intermediate (netMonthly, hem, commitments, surplus, serviceLoan, dtiLoan,
// power, bound, …).
//
// Expected intermediates are derived independently from the documented methodology:
//   • Tax (ATO FY2024-25): afterTax = g − (max(0, incomeTax − LITO) + Medicare)
//       incomeTax: 0 ≤18.2k; 16% 18.2–45k; $4288 + 30% over 45k to 135k; …
//       Medicare:  2% above $34,027 (shade-in 27,222–34,027); LITO per its taper.
//   • HEM living-expense floor: piecewise-linear on assessable income, clamped to a
//       band, plus $455/dependent. Single vs couple table by applicant count.
//   • assessmentRate = max(rate + 3% BUFFER, FLOOR_RATE=5.40).
//   • surplus = netMonthly − max(declaredExpenses, HEM) − commitments,
//       commitments = otherDebt + ccLimit·CC_FACTOR(3.8%) + HECS/12.
//   • serviceLoan = present value of `surplus` as a 30y monthly annuity at the
//       assessment rate; power = max(0, min(serviceLoan, 6×grossIncome)).
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { estimateBorrowingPower, BP } from "../src/finance.js";
import { S } from "../src/state.js";
import { resetState, approx, annuityLoan, income } from "./_helpers.js";

beforeEach(resetState);

describe("estimateBorrowingPower — serviceability-bound single applicant", () => {
  test("$100k salary, HEM floor binding, no debts", () => {
    S.estimator.incomes[0] = income({ salary: 100000 });
    const e = estimateBorrowingPower();

    assert.equal(e.assessmentRate, 9.0); // max(6+3, 5.40)
    assert.equal(e.grossAnnual, 100000);

    // tax = 4288 + 55000·0.30 = 20788 ; medicare = 2000 ; LITO = 0
    const netAnnual = 100000 - (20788 + 2000); // 77212
    approx(e.netMonthly, netAnnual / 12);

    approx(e.hem, 2085); // HEM_SINGLE anchor at $100k income
    approx(e.expensesMonthly, 2085);
    assert.equal(e.hemBinds, true); // declared expenses 0 ≤ HEM
    assert.equal(e.hecsMonthly, 0);
    approx(e.commitments, 0);

    const surplus = netAnnual / 12 - 2085;
    approx(e.surplus, surplus);

    approx(e.dtiLoan, 600000); // 6 × 100000
    approx(e.serviceLoan, annuityLoan(surplus, 9.0, 30, 12));
    assert.ok(e.serviceLoan < e.dtiLoan, "serviceability should bind below the DTI cap");
    assert.equal(e.bound, "serviceability");
    approx(e.power, annuityLoan(surplus, 9.0, 30, 12)); // independent of the returned serviceLoan field
  });
});

describe("estimateBorrowingPower — DTI cap and the floor rate", () => {
  test("low product rate clamps to the 5.40% floor and the 6× DTI cap binds", () => {
    // rate + 3% buffer = 5.0 < 5.40 floor → assessmentRate pinned at 5.40, which makes
    // serviceability generous enough that the 6× income cap is the binding limit.
    S.rate = 2.0;
    S.estimator.incomes[0] = income({ salary: 60000 });
    const e = estimateBorrowingPower();

    assert.equal(e.assessmentRate, 5.40); // floor clamp

    // tax = 4288 + 15000·0.30 = 8788 ; LITO = 325 − 15000·0.015 = 100 ; medicare = 1200
    const netAnnual = 60000 - ((8788 - 100) + 1200); // 50112
    approx(e.netMonthly, netAnnual / 12);
    approx(e.hem, 1626); // HEM_SINGLE anchor at $60k

    const surplus = netAnnual / 12 - 1626;
    approx(e.surplus, surplus);
    approx(e.dtiLoan, 360000); // 6 × 60000
    approx(e.serviceLoan, annuityLoan(surplus, 5.40, 30, 12));
    assert.ok(e.serviceLoan > e.dtiLoan, "DTI cap should bind below serviceability here");
    assert.equal(e.bound, "dti");
    approx(e.power, 360000);
  });
});

describe("estimateBorrowingPower — negative surplus fails", () => {
  test("declared expenses above HEM can push surplus negative → power 0, bound 'fail'", () => {
    S.estimator.incomes[0] = income({ salary: 50000 });
    S.estimator.expenses = 10000; // well above the HEM floor
    const e = estimateBorrowingPower();

    // HEM at $50k = 1450 + (1626-1450)·(50000-40000)/(60000-40000) = 1538
    approx(e.hem, 1538);
    approx(e.expensesMonthly, 10000); // declared expenses override the floor…
    assert.equal(e.hemBinds, false); // …so the HEM floor does NOT bind

    assert.ok(e.surplus < 0);
    assert.equal(e.serviceLoan, 0);
    assert.equal(e.bound, "fail");
    assert.equal(e.power, 0);
  });

  test("zero income → HEM lower clamp, surplus negative, fail", () => {
    const e = estimateBorrowingPower();
    assert.equal(e.netMonthly, 0);
    approx(e.hem, 1450); // lower clamp for a single household even at $0 income
    assert.ok(e.surplus < 0);
    assert.equal(e.power, 0);
    assert.equal(e.bound, "fail");
    assert.equal(e.grossAnnual, 0);
    assert.equal(e.dtiLoan, 0);
  });
});

describe("estimateBorrowingPower — couple, full commitment mix", () => {
  test("extra income, HECS, card limit, other debt and dependents all apply", () => {
    S.estimator.applicants = 2; // couple → HEM_COUPLE table
    S.estimator.incomes[0] = income({
      salary: 120000, bonus: 10000, hecs: true,
      extra: [{ amount: 20000 }],
    });
    S.estimator.incomes[1] = income({
      salary: 80000,
      extra: [{ amount: 5000 }],
    });
    S.estimator.dependents = 2;
    S.estimator.ccLimit = 20000;
    S.estimator.otherDebt = 500;
    const e = estimateBorrowingPower();

    // All assessable income counts at 100% (salary + bonus + extra lines); tax & HECS key on it.
    //   app0 = 120000 + 10000 + 20000 = 150000
    //   app1 = 80000  + 5000          = 85000
    const net0 = 150000 - ((31288 + 15000 * 0.37) + 150000 * 0.02); // 110162
    const net1 = 85000 - ((4288 + 40000 * 0.30) + 85000 * 0.02); // 67012
    approx(e.netMonthly, (net0 + net1) / 12);

    approx(e.grossAnnual, 235000); // 150000 + 85000 (drives the DTI cap)

    // HEM_COUPLE at assessable 235000, between anchors [220000,4846] & [300000,5375],
    // plus 2 dependents × $455.
    const hem = 4846 + (5375 - 4846) * (235000 - 220000) / (300000 - 220000) + 2 * 455;
    approx(e.hem, hem);
    assert.equal(e.hemBinds, true);

    approx(e.hecsMonthly, 150000 * 0.090 / 12); // 150000 → 9.0% band
    const commitments = 500 + 20000 * BP.CC_FACTOR + 150000 * 0.090 / 12;
    approx(e.commitments, commitments);

    const surplus = (net0 + net1) / 12 - hem - commitments;
    approx(e.surplus, surplus);
    approx(e.serviceLoan, annuityLoan(surplus, 9.0, 30, 12));
    approx(e.dtiLoan, 6 * 235000);
    assert.equal(e.bound, "serviceability");
    approx(e.power, annuityLoan(surplus, 9.0, 30, 12)); // independent of the returned serviceLoan field
  });
});

describe("estimateBorrowingPower — bounds, clamps and monotonicity", () => {
  test("HEM is clamped to the single-household ceiling at very high income", () => {
    S.estimator.incomes[0] = income({ salary: 2000000 });
    const e = estimateBorrowingPower();
    approx(e.hem, 6000); // upper clamp (table would extrapolate far higher)
  });

  test("each dependent adds the HEM child allowance", () => {
    S.estimator.incomes[0] = income({ salary: 100000 });
    const base = estimateBorrowingPower().hem;
    S.estimator.dependents = 3;
    const withKids = estimateBorrowingPower().hem;
    approx(withKids - base, 3 * BP.HEM_CHILD);
  });

  test("a higher credit-card limit raises commitments by limit · CC_FACTOR", () => {
    S.estimator.incomes[0] = income({ salary: 100000 });
    const a = estimateBorrowingPower();
    S.estimator.ccLimit = 30000;
    const b = estimateBorrowingPower();
    approx(b.commitments - a.commitments, 30000 * BP.CC_FACTOR);
  });

  test("power is non-decreasing in income and never negative", () => {
    let prev = -1;
    for (const salary of [0, 40000, 60000, 80000, 100000, 150000, 250000]) {
      S.estimator.incomes[0] = income({ salary });
      const p = estimateBorrowingPower().power;
      assert.ok(p >= 0, `power negative at ${salary}`);
      assert.ok(p >= prev, `power decreased at salary ${salary}: ${p} < ${prev}`);
      prev = p;
    }
  });
});

describe("estimateBorrowingPower — tax, Medicare and LITO components (via netMonthly)", () => {
  test("top marginal bracket (>$190k, 45%) with full Medicare", () => {
    S.estimator.incomes[0] = income({ salary: 250000 });
    const e = estimateBorrowingPower();
    // tax = 51638 + (250000-190000)·0.45 = 78638 ; medicare = 5000 ; LITO = 0
    approx(e.netMonthly, (250000 - (78638 + 5000)) / 12);
    assert.equal(e.grossAnnual, 250000);
  });

  test("16% bracket with the LITO taper (37.5–45k) and full Medicare", () => {
    S.estimator.incomes[0] = income({ salary: 40000 });
    const e = estimateBorrowingPower();
    // tax = (40000-18200)·0.16 = 3488 ; LITO = 700 - (40000-37500)·0.05 = 575
    // medicare = 40000·0.02 = 800 ; net = 40000 - (max(0,3488-575) + 800)
    approx(e.netMonthly, (40000 - ((3488 - 575) + 800)) / 12);
  });

  test("Medicare shade-in band (27,222–34,027) with the flat $700 LITO", () => {
    S.estimator.incomes[0] = income({ salary: 30000 });
    const e = estimateBorrowingPower();
    // tax = (30000-18200)·0.16 = 1888 ; LITO = 700 (flat below 37.5k)
    // medicare shade-in = (30000-27222)·0.10 = 277.8
    approx(e.netMonthly, (30000 - ((1888 - 700) + 277.8)) / 12);
  });
});

describe("estimateBorrowingPower — HECS flag, couple DTI, expense floor and term", () => {
  test("the per-applicant HECS flag toggles a real commitment", () => {
    S.estimator.incomes[0] = income({ salary: 100000, hecs: false });
    const off = estimateBorrowingPower();
    assert.equal(off.hecsMonthly, 0);

    S.estimator.incomes[0] = income({ salary: 100000, hecs: true });
    const on = estimateBorrowingPower();
    // 100000 < 100175 → 5.5% band → $5500/yr.
    approx(on.hecsMonthly, 100000 * 0.055 / 12);
    approx(on.commitments - off.commitments, 100000 * 0.055 / 12);
  });

  test("the DTI cap can bind for a couple (bound 'dti')", () => {
    S.rate = 2.0; // assessmentRate pinned to the 5.40 floor → generous serviceability
    S.estimator.applicants = 2;
    S.estimator.incomes[0] = income({ salary: 60000 });
    S.estimator.incomes[1] = income({ salary: 60000 });
    const e = estimateBorrowingPower();
    approx(e.dtiLoan, 6 * 120000); // 720000
    assert.ok(e.serviceLoan > e.dtiLoan, "serviceability should exceed the DTI cap here");
    assert.equal(e.bound, "dti");
    approx(e.power, 720000);
  });

  test("a nonzero declared expense below the HEM floor still leaves HEM binding", () => {
    S.estimator.incomes[0] = income({ salary: 100000 });
    S.estimator.expenses = 1000; // > 0 but below the $2085 HEM floor at this income
    const e = estimateBorrowingPower();
    assert.equal(e.hemBinds, true);
    approx(e.expensesMonthly, 2085); // the floor wins, not the declared figure
  });

  test("the serviceability annuity respects S.termYears", () => {
    S.estimator.incomes[0] = income({ salary: 100000 });
    S.termYears = 25;
    const e = estimateBorrowingPower();
    const surplus = (100000 - (20788 + 2000)) / 12 - 2085;
    approx(e.serviceLoan, annuityLoan(surplus, 9.0, 25, 12));
  });
});
