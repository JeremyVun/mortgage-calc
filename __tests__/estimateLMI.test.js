// Tests for estimateLMI(loan, propertyValue) — Lenders Mortgage Insurance premium
// as a % of the LOAN, interpolated across LVR bands within a loan-size band.
// Pure function (no state). Expected rates/premiums are derived independently from
// the LMI_TABLE rate card and the documented piecewise-linear LVR interpolation:
//   eff = min(LVR, 95)
//   eff ≤ 85:  rate = (eff-80)/5 · r85          (0 at 80% LVR, r85 at 85%)
//   eff ≤ 90:  rate = r85 + (eff-85)/5 · (r90-r85)
//   else:      rate = r90 + (eff-90)/5 · (r95-r90)
//   premium = loan · rate / 100
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { estimateLMI } from "../src/finance.js";
import { approx } from "./_helpers.js";

describe("estimateLMI", () => {
  test("no premium at or below 80% LVR (the LMI threshold)", () => {
    const r = estimateLMI(800000, 1000000); // LVR 80%
    assert.equal(r.premium, 0);
    assert.equal(r.rate, 0);
    approx(r.lvr, 80);
    assert.equal(r.capped, false);
  });

  test("reports LVR even when no premium is due", () => {
    const r = estimateLMI(700000, 1000000); // LVR 70%
    assert.equal(r.premium, 0);
    approx(r.lvr, 70);
  });

  test("no premium for a non-positive loan", () => {
    const r = estimateLMI(0, 500000);
    assert.equal(r.premium, 0);
    assert.equal(r.rate, 0);
    assert.equal(r.capped, false);
  });

  test("handles a zero property value without dividing by zero", () => {
    const r = estimateLMI(400000, 0);
    assert.equal(r.premium, 0);
    assert.equal(r.lvr, 0);
  });

  test("82% LVR interpolates within the 80→85 segment (band: ≤500k, r85=0.97)", () => {
    // rate = (82-80)/5 · 0.97 = 0.388 ; premium = 410000 · 0.388/100
    const r = estimateLMI(410000, 500000);
    approx(r.lvr, 82);
    approx(r.rate, 0.388);
    approx(r.premium, 410000 * 0.388 / 100); // 1590.80
    assert.equal(r.capped, false);
  });

  test("exactly 85% LVR hits the r85 anchor", () => {
    // rate = 0.97 ; premium = 425000 · 0.97/100 = 4122.50
    const r = estimateLMI(425000, 500000);
    approx(r.lvr, 85);
    approx(r.rate, 0.97);
    approx(r.premium, 4122.5);
  });

  test("exactly 90% LVR hits the r90 anchor", () => {
    // band ≤500k, r90 = 1.87 ; premium = 450000 · 1.87/100 = 8415
    const r = estimateLMI(450000, 500000);
    approx(r.lvr, 90);
    approx(r.rate, 1.87);
    approx(r.premium, 8415);
  });

  test("exactly 95% LVR hits the r95 anchor and is NOT flagged capped", () => {
    // band ≤500k, r95 = 3.35 ; premium = 475000 · 3.35/100 = 15912.50
    const r = estimateLMI(475000, 500000);
    approx(r.lvr, 95);
    approx(r.rate, 3.35);
    approx(r.premium, 15912.5);
    assert.equal(r.capped, false); // 95 is the last writable LVR
  });

  test("above 95% LVR clamps the rate to the 95% column and flags capped", () => {
    // LVR 98% → eff clamps to 95 → rate 3.35 ; premium on the ACTUAL loan.
    const r = estimateLMI(490000, 500000);
    approx(r.lvr, 98);
    approx(r.rate, 3.35);
    approx(r.premium, 490000 * 3.35 / 100); // 16415
    assert.equal(r.capped, true);
  });

  test("selects the loan-size band by its upper bound (r90 column across bands)", () => {
    // Hold LVR at 90% (pv = loan/0.9) and step loan across each band boundary.
    // r90 columns: ≤300k→1.46, ≤500k→1.87, ≤750k→2.27, ≤1M→2.52, else→2.60.
    approx(estimateLMI(300000, 300000 / 0.9).rate, 1.46);
    approx(estimateLMI(300001, 300001 / 0.9).rate, 1.87);
    approx(estimateLMI(500000, 500000 / 0.9).rate, 1.87);
    approx(estimateLMI(500001, 500001 / 0.9).rate, 2.27);
    approx(estimateLMI(750000, 750000 / 0.9).rate, 2.27);
    approx(estimateLMI(750001, 750001 / 0.9).rate, 2.52);
    approx(estimateLMI(1000000, 1000000 / 0.9).rate, 2.52);
    approx(estimateLMI(1000001, 1000001 / 0.9).rate, 2.60);
  });

  test("premium scales with the loan within a fixed band + LVR", () => {
    // Both ≤300k band at 90% LVR → identical rate (1.46); premium tracks the loan.
    const a = estimateLMI(250000, 250000 / 0.9);
    const b = estimateLMI(300000, 300000 / 0.9);
    approx(a.rate, 1.46);
    approx(b.rate, 1.46);
    approx(b.premium, a.premium * (300000 / 250000), 1e-6);
  });

  test("87% LVR interpolates within the 85→90 segment", () => {
    // band ≤500k: rate = 0.97 + (87-85)/5 · (1.87-0.97) = 1.33
    const r = estimateLMI(435000, 500000);
    approx(r.lvr, 87);
    approx(r.rate, 1.33);
    approx(r.premium, 435000 * 1.33 / 100);
  });

  test("92.5% LVR interpolates within the 90→95 segment", () => {
    // band ≤500k: rate = 1.87 + (92.5-90)/5 · (3.35-1.87) = 2.61
    const r = estimateLMI(462500, 500000);
    approx(r.lvr, 92.5);
    approx(r.rate, 2.61);
    approx(r.premium, 462500 * 2.61 / 100);
  });

  test("a small positive premium begins just above 80% LVR", () => {
    // 80.5%: rate = (80.5-80)/5 · 0.97 = 0.097
    const r = estimateLMI(402500, 500000);
    approx(r.lvr, 80.5);
    approx(r.rate, 0.097);
    approx(r.premium, 402500 * 0.097 / 100); // 390.425
    assert.ok(r.premium > 0);
  });
});
