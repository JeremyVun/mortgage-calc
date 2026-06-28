// Tests for assessSchemes(r) — First Home Guarantee (FHBG) eligibility against the
// current property and buyer. Since the 1 Oct 2025 expansion the FHBG has no income or
// place test, so only the first-home flag and the regional price cap matter. `r` is a
// solve() snapshot (only r.P is read); the region, deposit % and LMI-saved figures are
// derived independently from REGIONS / FHBG and estimateLMI.
import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assessSchemes, estimateLMI, REGIONS } from "../src/finance.js";
import { S } from "../src/state.js";
import { resetState, approx } from "./_helpers.js";

beforeEach(resetState);

// NSW cities: FHBG cap $1.5M.
const NSW_CAP = REGIONS.find((x) => x.label === "NSW · cities");

describe("assessSchemes — First Home Guarantee eligibility", () => {
  test("a first-home buyer under the regional price cap qualifies", () => {
    const { region, fhbg } = assessSchemes({ P: 900000 });
    assert.equal(region.label, "NSW · cities");
    assert.equal(fhbg.eligible, true);
    assert.equal(fhbg.firstHome, true);
    assert.equal(fhbg.underCap, true);
    assert.equal(fhbg.cap, NSW_CAP.fhbg); // 1_500_000
    approx(fhbg.minDeposit, 900000 * 0.05); // 45000
    // LMI you'd otherwise pay buying at a 5% deposit: estimateLMI(855000, 900000).
    // LVR 95%, loan ≤ $1M band r95 = 4.60% → 855000 · 4.60/100 = 39330.
    approx(fhbg.lmiSaved, estimateLMI(855000, 900000).premium);
    approx(fhbg.lmiSaved, 855000 * 4.60 / 100);
  });

  test("eligibility ignores income (no income test since the 2025 expansion)", () => {
    S.estimator.incomes[0].salary = 5_000_000; // far above any former income cap
    const { fhbg } = assessSchemes({ P: 900000 });
    assert.equal(fhbg.eligible, true);
  });
});

describe("assessSchemes — price cap gating", () => {
  test("a property above the regional cap is ineligible", () => {
    S.buyer.region = "NSW · regional"; // FHBG cap $800k
    const { region, fhbg } = assessSchemes({ P: 900000 });
    assert.equal(region.label, "NSW · regional");
    assert.equal(fhbg.underCap, false);
    assert.equal(fhbg.eligible, false);
  });

  test("a non-positive property price is treated as not-under-cap", () => {
    const { fhbg } = assessSchemes({ P: 0 });
    assert.equal(fhbg.underCap, false);
    assert.equal(fhbg.eligible, false);
    approx(fhbg.minDeposit, 0);
    approx(fhbg.lmiSaved, 0);
  });

  test("the price cap is inclusive (P exactly at the cap is under-cap)", () => {
    const { fhbg } = assessSchemes({ P: 1500000 });
    assert.equal(fhbg.underCap, true); // 1.5M ≤ 1.5M (boundary)
    assert.equal(fhbg.eligible, true);
  });

  test("a price just under the cap qualifies; just over does not", () => {
    assert.equal(assessSchemes({ P: 1499999 }).fhbg.eligible, true);
    assert.equal(assessSchemes({ P: 1500001 }).fhbg.eligible, false);
  });
});

describe("assessSchemes — first-home and region edge cases", () => {
  test("a non-first-home buyer is ineligible even when under the cap", () => {
    S.buyer.firstHome = false;
    const { fhbg } = assessSchemes({ P: 900000 });
    assert.equal(fhbg.underCap, true);  // cap still computed…
    assert.equal(fhbg.eligible, false); // …but the first-home gate fails
  });

  test("an unknown region falls back to the first region in the table", () => {
    S.buyer.region = "does-not-exist";
    const { region } = assessSchemes({ P: 900000 });
    assert.equal(region.label, REGIONS[0].label);
  });
});
