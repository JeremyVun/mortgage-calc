// Tests for hecsRepaymentAnnual() — the compulsory HECS/HELP repayment ($/yr) a
// lender deducts as a serviceability commitment. Pure function of income; no state.
// Expected values are derived independently from the ATO FY2024-25 rate table
// encoded in HECS_TABLE: the FIRST bracket whose upper bound the income falls UNDER
// (strict <) sets the whole-of-income percentage. Below the $54,435 minimum the
// repayment is zero.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { hecsRepaymentAnnual } from "../src/finance.js";
import { approx } from "./_helpers.js";

describe("hecsRepaymentAnnual", () => {
  test("returns 0 below the FY2024-25 minimum threshold ($54,435)", () => {
    assert.equal(hecsRepaymentAnnual(0), 0);
    assert.equal(hecsRepaymentAnnual(30000), 0);
    assert.equal(hecsRepaymentAnnual(54434), 0); // one dollar under the threshold
  });

  test("returns 0 for non-finite / negative income (guard)", () => {
    assert.equal(hecsRepaymentAnnual(NaN), 0);
    assert.equal(hecsRepaymentAnnual(-5000), 0);
  });

  test("charges 1.0% exactly at the threshold", () => {
    // 54435 >= 54435 → in scope; 54435 < 62851 → first band, rate 1.0%.
    approx(hecsRepaymentAnnual(54435), 54435 * 0.010);
  });

  test("rate band boundaries use a strict < on the bracket's upper bound", () => {
    // 62850 < 62851 → still the 1.0% band; 62851 is NOT < 62851 → next band, 2.0%.
    approx(hecsRepaymentAnnual(62850), 62850 * 0.010);
    approx(hecsRepaymentAnnual(62851), 62851 * 0.020);
  });

  test("picks the correct mid-table band", () => {
    // 70000 < 70619 → 2.5% band.
    approx(hecsRepaymentAnnual(70000), 70000 * 0.025);
    // 150000 < 150627 → 9.0% band (this is the rate the couple scenario relies on).
    approx(hecsRepaymentAnnual(150000), 150000 * 0.090);
  });

  test("tops out at 10.0% above the final finite bracket", () => {
    // 159663 < 159664 → 9.5%; 159664 is NOT < 159664 → falls through to [Infinity, 0.10].
    approx(hecsRepaymentAnnual(159663), 159663 * 0.095);
    approx(hecsRepaymentAnnual(159664), 159664 * 0.100);
    approx(hecsRepaymentAnnual(250000), 250000 * 0.100);
  });

  test("each intermediate rate bracket charges its whole-of-income rate", () => {
    // [income strictly inside a bracket, expected whole-of-income rate]. Incomes are
    // chosen between consecutive HECS_TABLE ceilings so the strict-< lookup is
    // unambiguous; covers the 1.0%–9.5% bands the headline cases skip.
    const cases = [
      [60000, 0.010], [65000, 0.020], [68000, 0.025], [72000, 0.030],
      [77000, 0.035], [82000, 0.040], [87000, 0.045], [92000, 0.050],
      [98000, 0.055], [103000, 0.060], [110000, 0.065], [116000, 0.070],
      [123000, 0.075], [130000, 0.080], [138000, 0.085], [146000, 0.090],
      [155000, 0.095],
    ];
    for (const [g, rate] of cases) approx(hecsRepaymentAnnual(g), g * rate);
  });

  test("characterises the unguarded edge inputs", () => {
    assert.equal(hecsRepaymentAnnual(undefined), 0); // !(undefined >= min) → guarded to 0
    assert.equal(hecsRepaymentAnnual(Infinity), Infinity); // passes the guard; top 10% band → Infinity
  });

  test("is monotonically non-decreasing in income", () => {
    let prev = -1;
    for (let g = 0; g <= 300000; g += 2500) {
      const r = hecsRepaymentAnnual(g);
      assert.ok(r >= prev - 1e-9, `repayment dropped at income ${g}: ${r} < ${prev}`);
      prev = r;
    }
  });
});
