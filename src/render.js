import { S, FREQ_LABEL, FREQ_TITLE } from "./state.js";
import { solve, amortize, periodRows, estimateBorrowingPower } from "./finance.js";
import { money, pct, nf0, compact, compactK, esc } from "./format.js";
import { byId, NARROW, anim, setNum, segState, lockClosedSVG, lockOpenSVG } from "./dom.js";
import { saveStateSoon } from "./persist.js";

/* ============================ Render ============================ */
let activeEdit = null; // key currently being typed in
let lastRepayMode = null; // tracks hero figure semantics to avoid cross-meaning tweens

// events.js sets the field being typed in so render() won't reformat it mid-edit.
export function setActiveEdit(v) { activeEdit = v; }

export function render() {
  const r = solve();

  /* rate controls */
  byId("rateVal").textContent = pct(S.rate, 2);
  byId("rate").setAttribute("aria-valuetext", pct(S.rate, 2));
  byId("assessInline").textContent = pct(r.aRate, 2);
  if (document.activeElement !== byId("buffer-num")) byId("buffer-num").value = +S.buffer.toFixed(2);
  byId("costsVal").textContent = money(S.costs);
  byId("rate").style.setProperty("--fill", (S.rate / 12) * 100 + "%");

  /* money fields — lock styling for all four; simple inputs for three (deposit is a sources card) */
  const vals = { property: r.P, loan: r.L, repayment: S.repayment };
  ["property", "deposit", "loan", "repayment"].forEach((key) => {
    const field = document.querySelector(`.field[data-key="${key}"]`);
    const locked = S.locked.includes(key);
    field.classList.toggle("locked", locked);
    field.classList.toggle("solved", !locked);
    const lockBtn = field.querySelector(".lock");
    lockBtn.innerHTML = locked ? lockClosedSVG() : lockOpenSVG();
    lockBtn.setAttribute("aria-pressed", String(locked));
    const labelText = field.querySelector("label").textContent;
    lockBtn.setAttribute("aria-label", labelText + (locked
      ? " — locked. Lock a different figure to solve for this one instead."
      : " — solved. Press to lock this figure."));
    field.querySelector(".tag").textContent = locked ? "locked" : "solved";
    if (key !== "deposit") {
      const input = byId("f-" + key);
      input.readOnly = !locked;
      if (key !== activeEdit) input.value = nf0.format(Math.round(vals[key] || 0));
    }
  });

  /* deposit card (funding sources) */
  const depLocked = S.locked.includes("deposit");
  byId("depCap").textContent = depLocked ? "Your funding sources" : "Deposit required to settle";
  setNum(byId("depHeadline"), r.D, money);
  if (depLocked) {
    byId("sub-deposit").innerHTML = `<b>${pct(r.depPct, 1)}</b> of property · summed from your sources below`;
  } else {
    const gap = r.availableFunds - r.D;
    byId("sub-deposit").innerHTML = `you have <b>${money(r.availableFunds)}</b> across your sources · ` +
      (gap >= -0.5
        ? `<span style="color:var(--green-2)">surplus ${money(gap)}</span>`
        : `<span style="color:var(--clay)">shortfall ${money(-gap)}</span>`);
  }

  /* field sub-labels */
  byId("sub-property").innerHTML = `Loan-to-value <b>${pct(r.lvr, 1)}</b>`;
  byId("sub-loan").innerHTML = `LVR <b>${pct(r.lvr, 1)}</b> · ${money(r.L)}`;
  const basisRate = S.repaymentBasis === "assessed" ? r.aRate : S.rate;
  byId("sub-repayment").innerHTML = `per ${FREQ_LABEL[S.freq]} · ${S.repaymentBasis === "assessed" ? "assessed" : "actual"} @ <b>${pct(basisRate, 2)}</b>`;

  /* basis + freq + term segmented states */
  segState("basisSeg", "basis", S.repaymentBasis);
  segState("freqSeg", "freq", S.freq);
  byId("term").value = String(S.termYears);

  /* hero */
  byId("heroLabel").textContent = FREQ_TITLE[S.freq] + " repayment";
  setNum(byId("heroRepay"), r.rActual, (v) => money(v));
  byId("heroFreqNote").innerHTML =
    `at your <b style="opacity:.95">${pct(S.rate, 2)}</b> rate · assessed <b style="opacity:.95">${money(r.rAssessed)}</b>/${FREQ_LABEL[S.freq]} @ ${pct(r.aRate, 2)}`;

  // hero pair adapts to what's interesting (borrowing power mode vs price mode)
  const repayMode = S.locked.includes("repayment");
  // When the hero figures swap meaning (price <-> borrowing power), snap instead of
  // tweening between two unrelated quantities.
  if (lastRepayMode !== null && repayMode !== lastRepayMode) { anim.delete(byId("heroAV")); anim.delete(byId("heroBV")); }
  lastRepayMode = repayMode;
  byId("heroAK").textContent = repayMode ? "Borrowing power" : "Property value";
  byId("heroBK").textContent = repayMode ? "Property you can target" : "Loan amount";
  setNum(byId("heroAV"), repayMode ? r.L : r.P, (v) => money(v));
  setNum(byId("heroBV"), repayMode ? r.P : r.L, (v) => money(v));

  const badge = byId("lvrBadge");
  badge.textContent = "LVR " + pct(r.lvr, 1);
  badge.className = "lvr-badge " + (r.lvr <= 0 ? "neutral" : r.lvr > 90 ? "bad" : r.lvr > 80 ? "warn" : "ok");

  /* warnings */
  const warn = byId("warnBanner");
  let msg = "";
  if (r.D < 0) msg = `<b>Deposit is negative.</b> Your loan exceeds the property value — lower the loan, raise the deposit, or increase the property price.`;
  else if (r.L <= 0) msg = `<b>No loan needed.</b> Your deposit covers the full property value at these settings.`;
  else if (r.lvr > 95) msg = `<b>LVR above 95%.</b> Few lenders go this high; expect significant LMI and stricter assessment.`;
  else if (r.lvr > 90) msg = `<b>LVR above 90%.</b> LMI applies and lending criteria tighten considerably.`;
  else if (r.lvr > 80) msg = `<b>LVR above 80%.</b> Lenders Mortgage Insurance (LMI) typically applies — not included in these figures.`;
  warn.classList.toggle("show", !!msg);
  if (msg) byId("warnText").innerHTML = msg;

  /* mini sticky repayment bar (shown once the hero scrolls away) */
  byId("mbLabel").textContent = FREQ_TITLE[S.freq] + " repayment";
  byId("mbVal").textContent = money(r.rActual);
  byId("mbMeta").textContent = repayMode
    ? `borrow ${money(r.L)} · target ${money(r.P)}`
    : `${money(r.L)} loan · LVR ${pct(r.lvr, 1)}`;

  /* stat grid + schedule + chart + borrowing-power estimate */
  renderStats(r);
  renderSchedule(r);
  renderChart(r);
  renderEstimator();

  saveStateSoon(); // persist inputs (debounced) so they survive a refresh
}

function renderStats(r) {
  const cashToSettle = Math.max(0, r.D) + S.costs;
  const stats = [
    { k: "Deposit", v: money(r.D), note: pct(r.depPct, 1) + " of price", accent: false },
    { k: "Cash to settle", v: money(cashToSettle), note: S.costs > 0 ? "incl. " + money(S.costs) + " costs" : "deposit only", accent: true },
    { k: "Loan-to-value", v: pct(r.lvr, 1), note: r.lvr > 80 ? "LMI territory" : "no LMI", accent: false },
    { k: "Assessed repayment", v: money(r.rAssessed) + " ", note: "@ " + pct(r.aRate, 2) + " /" + FREQ_LABEL[S.freq], accent: false },
    { k: "Total interest", v: money(r.totalInterest), note: "over " + S.termYears + " yrs", accent: false },
    { k: "Total repaid", v: money(r.totalRepaid), note: "principal + interest", accent: false },
  ];
  byId("statGrid").innerHTML = stats.map((s) =>
    `<div class="stat${s.accent ? " accent" : ""}"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="note">${s.note}</div></div>`
  ).join("");
}

/* ---- repayment schedule (your actual rate) — toggles yearly vs per-period ---- */
let lastSchedKey = null;
function renderSchedule(r) {
  const intro = byId("schedIntro"), body = byId("schedBody"), colHead = byId("schedColHead");
  const mode = S.ui.schedMode; // "yearly" | "period"
  segState("schedSeg", "sched", mode);
  byId("schedPeriodBtn").textContent = FREQ_TITLE[S.freq]; // toggle's 2nd label tracks the chosen frequency
  if (!(r.L > 0)) {
    intro.textContent = "No loan to schedule at these settings.";
    colHead.textContent = mode === "period" ? FREQ_TITLE[S.freq] : "Year";
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--ink-3)">—</td></tr>`;
    lastSchedKey = null;
    return;
  }
  const am = amortize(r.L, S.rate, S.termYears, r.p);
  const annual = r.rActual * r.p, y1 = am.rows[0];
  intro.innerHTML =
    `Each year you pay <b>${money(annual)}</b> (${money(r.rActual)}/${FREQ_LABEL[S.freq]}), split into interest — your cost of borrowing — and principal — equity you keep. ` +
    `<b>Year-one interest ≈ ${money(y1.interest)}</b> (${money(y1.interest / 12)}/mo): the figure to weigh against a year of rent.`;
  // The per-period view can be hundreds of rows — only rebuild when an input that changes it does.
  const key = `${mode}|${Math.round(r.L)}|${S.rate}|${S.termYears}|${S.freq}|${NARROW.matches ? 1 : 0}`;
  if (key === lastSchedKey) return;
  lastSchedKey = key;
  const fmt = NARROW.matches ? compactK : money; // abbreviate on phones so the table never side-scrolls
  if (mode === "period") {
    colHead.textContent = FREQ_TITLE[S.freq];
    body.innerHTML = periodRows(r.L, S.rate, S.termYears, r.p).map((row) =>
      `<tr${row.k === 1 ? ' class="current"' : ''}><td>${row.k}</td><td>${fmt(row.interest)}</td><td>${fmt(row.principal)}</td><td>${fmt(row.balance)}</td></tr>`
    ).join("");
  } else {
    colHead.textContent = "Year";
    body.innerHTML = am.rows.map((row, idx) =>
      `<tr${idx === 0 ? ' class="current"' : ''}><td>Year ${row.yr}</td><td>${fmt(row.interest)}</td><td>${fmt(row.principal)}</td><td>${fmt(row.balance)}</td></tr>`
    ).join("");
  }
}

function renderChart(r) {
  // Reconcile rounded parts so Principal + Interest always equals Total in the legend.
  const rP = Math.round(r.L), rT = Math.round(r.totalRepaid);
  byId("legPrin").textContent = money(rP);
  byId("legInt").textContent = money(rT - rP);
  byId("legTotal").textContent = money(rT);
  byId("chartSub").textContent = `· ${S.termYears}-yr P&I at ${pct(S.rate,2)}`;
  const total = r.L + r.totalInterest;
  const pPct = total > 0 ? (r.L / total) * 100 : 100;
  const sb = byId("splitBar");
  sb.querySelector(".seg-p").style.width = pPct + "%";
  sb.querySelector(".seg-i").style.width = (100 - pPct) + "%";

  if (!(r.L > 0)) { byId("chartWrap").innerHTML = `<div style="padding:30px 0;text-align:center;color:var(--ink-3);font-size:13px">No loan to amortise.</div>`; return; }

  const am = amortize(r.L, S.rate, S.termYears, r.p);
  const W = 600, H = 220, padL = 58, padR = 12, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxYr = S.termYears, maxBal = r.L;
  const X = (yr) => padL + (yr / maxYr) * innerW;
  const Y = (bal) => padT + (1 - bal / maxBal) * innerH;

  // area + line path
  let line = "", area = `M ${X(0)} ${Y(am.pts[0].bal)} `;
  am.pts.forEach((pt, idx) => {
    const cmd = (idx === 0 ? "M" : "L") + ` ${X(pt.yr).toFixed(1)} ${Y(pt.bal).toFixed(1)} `;
    line += cmd; area += "L" + ` ${X(pt.yr).toFixed(1)} ${Y(pt.bal).toFixed(1)} `;
  });
  area += `L ${X(maxYr).toFixed(1)} ${Y(0).toFixed(1)} L ${X(0).toFixed(1)} ${Y(0).toFixed(1)} Z`;

  // y gridlines
  let grid = "", ylabels = "";
  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const bal = (maxBal / steps) * s;
    const y = Y(bal).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line-2)" stroke-width="1"/>`;
    ylabels += `<text x="${padL - 8}" y="${(+y + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--ink-3)" font-family="IBM Plex Mono,monospace">${compact(bal)}</text>`;
  }
  // x labels every ~5 yrs
  let xlabels = "";
  const xstep = maxYr <= 15 ? 3 : 5;
  for (let yr = 0; yr <= maxYr; yr += xstep) {
    xlabels += `<text x="${X(yr).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9.5" fill="var(--ink-3)" font-family="IBM Plex Mono,monospace">${yr === 0 ? "now" : yr + "y"}</text>`;
  }
  // halfway marker (when ~half the loan is paid off)
  let half = am.pts.find((pt) => pt.bal <= maxBal / 2);
  let halfMark = "";
  if (half && half.yr > 0 && half.yr < maxYr) {
    const hx = X(half.yr).toFixed(1), hy = Y(half.bal).toFixed(1);
    halfMark = `<line x1="${hx}" y1="${padT}" x2="${hx}" y2="${H - padB}" stroke="var(--gold)" stroke-width="1" stroke-dasharray="3 3" opacity=".6"/>
      <circle cx="${hx}" cy="${hy}" r="3.5" fill="var(--paper-2)" stroke="var(--green)" stroke-width="2"/>
      <text x="${hx}" y="${padT - 1}" text-anchor="middle" font-size="9" fill="var(--gold)" font-family="IBM Plex Mono,monospace">½ paid · yr ${Math.round(half.yr)}</text>`;
  }

  byId("chartWrap").innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Loan balance over time">
      <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--green-3)" stop-opacity=".30"/>
        <stop offset="100%" stop-color="var(--green-3)" stop-opacity=".02"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#ag)"/>
      <path d="${line}" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-linejoin="round"/>
      ${halfMark}
      ${ylabels}${xlabels}
    </svg>`;
}

/* Build the editable deposit-source rows (only on init / add / remove) */
export function renderSources() {
  const multi = S.depositSources.length > 1;
  byId("depSources").innerHTML = S.depositSources.map((s, i) => `
    <div class="dep-row">
      <input class="dep-name" data-idx="${i}" value="${esc(s.name)}" placeholder="Source (e.g. Savings)" aria-label="Funding source ${i + 1} name" />
      <div class="dep-amt-wrap"><span class="dep-cur">$</span><input class="dep-amt" data-idx="${i}" inputmode="numeric" value="${nf0.format(Math.round(s.amount || 0))}" aria-label="${esc(s.name) || "Source " + (i + 1)} amount" /></div>
      ${multi ? `<button type="button" class="dep-del" data-idx="${i}" aria-label="Remove ${esc(s.name) || "source " + (i + 1)}">&times;</button>` : `<span class="dep-del-spacer"></span>`}
    </div>`).join("");
}

/* Build per-applicant income inputs (on init / applicants change) */
export function renderIncomes() {
  const e = S.estimator;
  let html = "";
  for (let i = 0; i < e.applicants; i++) {
    const inc = e.incomes[i] || { base: 0, variable: 0 };
    const title = e.applicants > 1 ? `Applicant ${i + 1}` : "Your income";
    html += `
      <div class="bp-applicant">
        <div class="bp-app-title">${title}</div>
        <div class="bp-grid3">
          <div class="bp-field">
            <label class="mini-label" for="bp-base-${i}">Gross salary /yr</label>
            <div class="bp-in"><span class="bp-cur">$</span><input id="bp-base-${i}" class="bp-inc bp-num" data-idx="${i}" data-field="base" inputmode="numeric" value="${nf0.format(Math.round(inc.base || 0))}" /></div>
          </div>
          <div class="bp-field">
            <label class="mini-label" for="bp-var-${i}">+ OT / bonus /yr</label>
            <div class="bp-in"><span class="bp-cur">$</span><input id="bp-var-${i}" class="bp-inc bp-num" data-idx="${i}" data-field="variable" inputmode="numeric" value="${nf0.format(Math.round(inc.variable || 0))}" /></div>
          </div>
        </div>
      </div>`;
  }
  byId("bpIncomes").innerHTML = html;
}

export function syncBpSegs() {
  segState("bpApplicants", "app", String(S.estimator.applicants));
  segState("bpHousehold", "hh", S.estimator.household);
}

/* Live borrowing-power estimate (summary chip + result block) */
export function renderEstimator() {
  const est = estimateBorrowingPower();
  byId("bpAssessNote").textContent = pct(est.assessmentRate, 2);
  byId("bpHead").textContent = est.bound === "fail" ? "$0" : money(est.power);
  byId("bpHemHint").textContent = est.hemBinds ? `HEM floor ${money(est.hem)}/mo applies` : "";
  const result = byId("bpResult");
  result.classList.toggle("fail", est.bound === "fail");
  const boundLabel = est.bound === "fail"
    ? "Income doesn't cover expenses + debts at the assessment rate"
    : est.bound === "dti" ? "Capped by the 6× debt-to-income limit" : "Limited by income serviceability";
  result.innerHTML = `
    <div class="bp-r-head">
      <span class="bp-r-cap">Estimated borrowing power</span>
      <span class="bp-r-val">${est.bound === "fail" ? "$0" : money(est.power)}</span>
    </div>
    <div class="bp-r-bound">${boundLabel}</div>
    <div class="bp-r-rows">
      <div class="bp-r-row"><span>Net income</span><span>${money(est.netMonthly)}/mo</span></div>
      <div class="bp-r-row"><span>Living expenses</span><span>−${money(est.expensesMonthly)}/mo</span></div>
      <div class="bp-r-row"><span>Debt commitments</span><span>−${money(est.commitments)}/mo</span></div>
      <div class="bp-r-row"><span>Monthly surplus</span><span>${money(est.surplus)}/mo</span></div>
      <div class="bp-r-row"><span>Serviced @ ${pct(est.assessmentRate, 2)}</span><span>${money(est.serviceLoan)}</span></div>
      ${est.dtiLoan !== Infinity ? `<div class="bp-r-row"><span>6× income cap</span><span>${money(est.dtiLoan)}</span></div>` : ""}
    </div>`;
  byId("bpApply").disabled = !(est.power > 0);
}
