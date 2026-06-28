import { S, FREQ_LABEL, FREQ_TITLE, INCOME_KINDS } from "./state.js";
import { solve, amortize, periodRows, estimateBorrowingPower, estimateLMI, assessSchemes, REGIONS } from "./finance.js";
import { money, pct, nf0, compact, compactK, esc, fmtDuration } from "./format.js";
import { byId, NARROW, anim, setNum, segState, lockClosedSVG, lockOpenSVG } from "./dom.js";
import { saveStateSoon } from "./persist.js";

/* ============================ Render ============================ */
let activeEdit = null; // key currently being typed in
let lastRepayMode = null; // tracks hero figure semantics to avoid cross-meaning tweens
// Cached amortisation from the last full render. Scheme-only updates (which can't change
// the loan or schedule) reuse these so they never recompute the amortisation or repaint
// the chart/table — that keeps changing region / first-home / property-type snappy.
let lastAm = null, lastAmBase = null;

// events.js sets the field being typed in so render() won't reformat it mid-edit.
export function setActiveEdit(v) { activeEdit = v; }

export function render() {
  const r = solve();
  const est = estimateBorrowingPower();
  const sc = assessSchemes(r, est);
  // Amortise ONCE (reflecting any extra repayment) and share across stats/schedule/chart;
  // baseline (no extra) drives the "you'd save" comparisons.
  const am = amortize(r.L, S.rate, S.termYears, r.p, S.extra);
  const amBase = S.extra > 0 ? amortize(r.L, S.rate, S.termYears, r.p, 0) : am;
  lastAm = am; lastAmBase = amBase;

  /* rate + buffer controls — reflect state unless you're mid-edit in that field */
  if (document.activeElement !== byId("rate")) byId("rate").value = S.rate.toFixed(2);
  if (document.activeElement !== byId("buffer-num")) byId("buffer-num").value = S.buffer.toFixed(2);

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

  /* deposit card (funding sources) — just captures your money; no shortfall/validation.
     Whether LMI applies is a separate concern, shown in the results stats. */
  const depLocked = S.locked.includes("deposit");
  byId("depCap").textContent = depLocked ? "Your funding sources" : "Deposit required to settle";
  setNum(byId("depHeadline"), r.D, money);
  byId("sub-deposit").innerHTML = `<b>${pct(r.depPct, 1)}</b> of property value`;

  /* field sub-labels */
  byId("sub-property").innerHTML = `Loan-to-value <b>${pct(r.lvr, 1)}</b>`;
  byId("sub-loan").innerHTML = `LVR <b>${pct(r.lvr, 1)}</b> · ${money(r.L)}`;
  byId("sub-repayment").innerHTML = `per ${FREQ_LABEL[S.freq]} · what you'd pay at your <b>${pct(S.rate, 2)}</b> rate`;

  /* freq + term segmented states */
  segState("freqSeg", "freq", S.freq);
  byId("term").value = String(S.termYears);

  /* hero */
  byId("heroLabel").textContent = FREQ_TITLE[S.freq] + " repayment";
  setNum(byId("heroRepay"), r.rActual, (v) => money(v));
  const fnote = `at your <b style="opacity:.95">${pct(S.rate, 2)}</b> rate · over ${S.termYears} years`;
  byId("heroFreqNote").innerHTML = S.freq === "monthly" ? fnote : `${fnote} · ${money(r.monthly)}/mo`;

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
  else if (r.lvr > 80) msg = `<b>LVR above 80%.</b> Lenders Mortgage Insurance (LMI) typically applies — see the estimate in your results.`;
  warn.classList.toggle("show", !!msg);
  if (msg) byId("warnText").innerHTML = msg;

  /* mini sticky repayment bar (shown once the hero scrolls away) — carries all three figures */
  byId("mbLabel").textContent = FREQ_TITLE[S.freq] + " repay";
  byId("mbVal").textContent = money(r.rActual);
  byId("mbAK").textContent = repayMode ? "Borrow" : "Property";
  byId("mbAV").textContent = money(repayMode ? r.L : r.P);
  byId("mbBK").textContent = repayMode ? "Target" : "Loan";
  byId("mbBV").textContent = money(repayMode ? r.P : r.L);

  /* stat grid + extra repayments + schedule + chart + borrowing-power + schemes */
  renderStats(r, am, amBase, sc);
  renderExtra(r, am, amBase);
  renderSchedule(r, am);
  renderChart(r, am);
  renderEstimator(r, est);
  renderSchemes(r, est, sc);

  saveStateSoon(); // persist inputs (debounced) so they survive a refresh
}

/* Lightweight update for the LMI + government-scheme controls (region / first-home /
   property type). These change scheme eligibility — and therefore whether LMI is waived —
   but never the loan, schedule or chart, so we reuse the cached amortisation and skip the
   heavy repaints. Keeps changing the location snappy (no full re-render). */
export function renderSchemeArea() {
  const r = solve();
  const est = estimateBorrowingPower();
  const sc = assessSchemes(r, est);
  renderSchemes(r, est, sc);
  renderStats(r, lastAm, lastAmBase, sc); // refresh the LMI stat (waiver may have flipped)
  saveStateSoon();
}

function renderStats(r, am, amBase, sc) {
  const lmi = estimateLMI(r.L, r.P);
  // req 12: when the First Home Guarantee applies, LMI is waived — show it struck
  // through and reduced to $0 (the "on sale" pattern).
  const waived = lmi.premium > 0 && sc && sc.fhbg && sc.fhbg.eligible;
  let lmiStat;
  if (waived) {
    lmiStat = { k: "Est. LMI", v: `<s class="strike">${money(lmi.premium)}</s> $0`, note: "waived · First Home Guarantee", tone: "ok" };
  } else if (lmi.premium > 0) {
    lmiStat = { k: "Est. LMI", v: money(lmi.premium), note: "@ " + pct(lmi.lvr, 1) + " LVR · est.", tone: "warn" };
  } else {
    lmiStat = { k: "Est. LMI", v: "None", note: r.L > 0 ? "LVR ≤ 80%" : "no loan" };
  }
  const early = r.L > 0 && S.extra > 0 && am.payoffYears < S.termYears - 1e-6;
  const saved = amBase.totalInterest - am.totalInterest;
  const stats = [
    { k: "Deposit", v: money(r.D), note: pct(r.depPct, 1) + " of price" },
    { k: "Loan-to-value", v: pct(r.lvr, 1), note: r.lvr > 80 ? "LMI territory" : "no LMI" },
    lmiStat,
    { k: "Payoff time", v: r.L > 0 ? fmtDuration(am.payoffYears) : "—", note: early ? fmtDuration(S.termYears - am.payoffYears) + " sooner" : "full term", tone: early ? "accent" : "" },
    { k: "Total interest", v: money(am.totalInterest), note: saved > 1 ? "saves " + money(saved) + " with extra" : "over " + S.termYears + " yrs" },
    { k: "Total repaid", v: money(r.L + am.totalInterest), note: "principal + interest" },
  ];
  byId("statGrid").innerHTML = stats.map((s) =>
    `<div class="stat${s.tone ? " " + s.tone : ""}"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="note">${s.note}</div></div>`
  ).join("");
}

/* Extra-repayments panel (req 10): default $0; reflects how much faster you'd be debt-free
   and how much interest you'd save by paying extra on top of each scheduled repayment. */
function renderExtra(r, am, amBase) {
  byId("extraFreq").textContent = "/" + FREQ_LABEL[S.freq];
  const out = byId("extraResult");
  if (!(r.L > 0)) { out.innerHTML = `No loan to pay down at these settings.`; return; }
  if (!(S.extra > 0)) {
    out.innerHTML = `Add an amount you could pay on top of each repayment to see how much sooner you'd be debt-free — and how much interest you'd save.`;
    return;
  }
  const saved = amBase.totalInterest - am.totalInterest;
  const sooner = S.termYears - am.payoffYears;
  out.innerHTML =
    `Paying <b>${money(S.extra)}/${FREQ_LABEL[S.freq]}</b> extra clears your loan` +
    (sooner > 0.04 ? ` <b class="good">${fmtDuration(sooner)} sooner</b>` : ``) +
    (saved > 1 ? ` and saves <b class="good">${money(saved)}</b> in interest.` : `.`);
}

/* ---- repayment schedule (your actual rate) — toggles yearly vs per-period ---- */
let lastSchedKey = null;
function renderSchedule(r, am) {
  const intro = byId("schedIntro"), body = byId("schedBody"), colHead = byId("schedColHead");
  const mode = S.ui.schedMode; // "period" | "yearly"
  segState("schedSeg", "sched", mode);
  byId("schedPeriodBtn").textContent = FREQ_TITLE[S.freq]; // toggle's period label tracks the chosen frequency
  if (!(r.L > 0)) {
    intro.textContent = "No loan to schedule at these settings.";
    colHead.textContent = mode === "period" ? FREQ_TITLE[S.freq] : "Year";
    body.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--ink-3)">—</td></tr>`;
    lastSchedKey = null;
    return;
  }
  const perPeriod = r.rActual + (S.extra || 0), annual = perPeriod * r.p, y1 = am.rows[0];
  intro.innerHTML =
    `Each year you pay about <b>${money(annual)}</b> (${money(perPeriod)}/${FREQ_LABEL[S.freq]}${S.extra > 0 ? `, incl. ${money(S.extra)} extra` : ``}), split into interest — your cost of borrowing — and principal — equity you keep. ` +
    `<b>Year-one interest ≈ ${money(y1.interest)}</b> (${money(y1.interest / 12)}/mo): the figure to weigh against a year of rent.`;
  // The per-period view can be hundreds of rows — only rebuild when an input that changes it does.
  const key = `${mode}|${Math.round(r.L)}|${S.rate}|${S.termYears}|${S.freq}|${Math.round(S.extra)}|${NARROW.matches ? 1 : 0}`;
  if (key === lastSchedKey) return;
  lastSchedKey = key;
  const fmt = NARROW.matches ? compactK : money; // abbreviate on phones so the table never side-scrolls
  if (mode === "period") {
    colHead.textContent = FREQ_TITLE[S.freq];
    body.innerHTML = periodRows(r.L, S.rate, S.termYears, r.p, S.extra).map((row) =>
      `<tr${row.k === 1 ? ' class="current"' : ''}><td>${row.k}</td><td>${fmt(row.interest)}</td><td>${fmt(row.principal)}</td><td>${fmt(row.balance)}</td></tr>`
    ).join("");
  } else {
    colHead.textContent = "Year";
    body.innerHTML = am.rows.map((row, idx) =>
      `<tr${idx === 0 ? ' class="current"' : ''}><td>Year ${row.yr}</td><td>${fmt(row.interest)}</td><td>${fmt(row.principal)}</td><td>${fmt(row.balance)}</td></tr>`
    ).join("");
  }
}

function renderChart(r, am) {
  // Reconcile rounded parts so Principal + Interest always equals Total in the legend.
  const rP = Math.round(r.L), rT = Math.round(r.L + am.totalInterest);
  byId("legPrin").textContent = money(rP);
  byId("legInt").textContent = money(rT - rP);
  byId("legTotal").textContent = money(rT);
  byId("chartSub").textContent = S.extra > 0 && am.payoffYears < S.termYears - 1e-6
    ? `· paid off in ${fmtDuration(am.payoffYears)} with extra`
    : `· ${S.termYears}-yr P&I at ${pct(S.rate, 2)}`;
  const total = r.L + am.totalInterest;
  const pPct = total > 0 ? (r.L / total) * 100 : 100;
  const sb = byId("splitBar");
  sb.querySelector(".seg-p").style.width = pPct + "%";
  sb.querySelector(".seg-i").style.width = (100 - pPct) + "%";

  if (!(r.L > 0)) { byId("chartWrap").innerHTML = `<div style="padding:30px 0;text-align:center;color:var(--ink-3);font-size:13px">No loan to amortise.</div>`; return; }

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
  // extra repayments clear the loan early — run the line flat along zero to the term end
  const lastPt = am.pts[am.pts.length - 1];
  if (lastPt.yr < maxYr - 1e-6) line += `L ${X(maxYr).toFixed(1)} ${Y(0).toFixed(1)} `;
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
      <div class="dep-amt-wrap"><span class="dep-cur">$</span><input class="dep-amt" data-idx="${i}" inputmode="numeric" value="${s.amount ? nf0.format(Math.round(s.amount)) : ""}" placeholder="0" aria-label="${esc(s.name) || "Source " + (i + 1)} amount" /></div>
      ${multi ? `<button type="button" class="dep-del" data-idx="${i}" aria-label="Remove ${esc(s.name) || "source " + (i + 1)}">&times;</button>` : `<span class="dep-del-spacer"></span>`}
    </div>`).join("");
}

/* Build per-applicant income blocks: a Salary + Bonus box (the common case), optional
   extra income lines (rental / other), and a HECS/HELP toggle. Rebuilt only on init /
   add / remove / applicant change so typing never loses the caret. */
export function renderIncomes() {
  const e = S.estimator;
  const fmtAmt = (v) => (v ? nf0.format(Math.round(v)) : "");
  let html = "";
  for (let a = 0; a < e.applicants; a++) {
    const inc = e.incomes[a] || {};
    const extra = inc.extra || [];
    const title = e.applicants > 1 ? `Applicant ${a + 1}` : "Your income";
    const extraHtml = extra.map((row, i) => {
      const opts = INCOME_KINDS.map((k) => `<option value="${k.id}"${k.id === row.kind ? " selected" : ""}>${k.label}</option>`).join("");
      return `<div class="inc-row" data-app="${a}" data-idx="${i}">
        <input class="inc-name" data-app="${a}" data-idx="${i}" value="${esc(row.label)}" placeholder="e.g. Rental" aria-label="Extra income ${i + 1} label" />
        <select class="inc-kind" data-app="${a}" data-idx="${i}" aria-label="Extra income ${i + 1} type">${opts}</select>
        <div class="inc-amt-wrap"><span class="inc-cur">$</span><input class="inc-amt" data-app="${a}" data-idx="${i}" inputmode="numeric" value="${fmtAmt(row.amount)}" placeholder="0" aria-label="Extra income ${i + 1} amount per year" /></div>
        <button type="button" class="inc-del" data-app="${a}" data-idx="${i}" aria-label="Remove extra income ${i + 1}">&times;</button>
      </div>`;
    }).join("");
    html += `<div class="bp-applicant">
      <div class="bp-app-title">${title}</div>
      <div class="inc-primary">
        <div class="bp-field">
          <label class="mini-label" for="inc-salary-${a}">Salary /yr</label>
          <div class="bp-in"><span class="bp-cur">$</span><input id="inc-salary-${a}" class="inc-main" data-app="${a}" data-field="salary" inputmode="numeric" value="${fmtAmt(inc.salary)}" placeholder="0" /></div>
        </div>
        <div class="bp-field">
          <label class="mini-label" for="inc-bonus-${a}">Bonus /yr</label>
          <div class="bp-in"><span class="bp-cur">$</span><input id="inc-bonus-${a}" class="inc-main" data-app="${a}" data-field="bonus" inputmode="numeric" value="${fmtAmt(inc.bonus)}" placeholder="0" /></div>
        </div>
      </div>
      ${extra.length ? `<div class="inc-list">${extraHtml}</div>` : ``}
      <div class="inc-actions">
        <button type="button" class="inc-add" data-app="${a}">+ Add income</button>
        <label class="hecs-toggle"><input type="checkbox" class="hecs-check" data-app="${a}"${inc.hecs ? " checked" : ""} /> HECS/HELP debt</label>
      </div>
    </div>`;
  }
  byId("bpIncomes").innerHTML = html;
}

export function syncBpSegs() {
  segState("bpApplicants", "app", String(S.estimator.applicants));
}

/* Live borrowing-power estimate (summary chip + result block + shortfall flag) */
export function renderEstimator(r, est) {
  if (!r) r = solve();
  if (!est) est = estimateBorrowingPower();
  // This is the partial-render entry point for estimator-only edits (expenses, card limit,
  // other debt, dependents) — none of which pass through render(), so persist here. The
  // 250ms debounce coalesces the duplicate save that render() issues when it calls us.
  saveStateSoon();
  const needLoan = r.L;
  const hasIncome = est.grossAnnual > 0;
  const shortBy = needLoan - est.power;
  const short = hasIncome && needLoan > 0 && est.power < needLoan - 1;

  byId("bpAssessNote").textContent = pct(est.assessmentRate, 2);
  byId("bpHemHint").textContent = est.hemBinds && hasIncome ? `HEM floor ${money(est.hem)}/mo applies` : "";
  const result = byId("bpResult");

  // empty state — no income entered yet. Show "—", NOT "$0": asserting a $0 borrowing
  // power before any income is entered reads as broken (req 3).
  if (!hasIncome) {
    byId("bpHead").textContent = "—";
    byId("bpFlag").hidden = true;
    byId("bpFlag").className = "bp-sum-flag";
    byId("bpApply").disabled = true;
    result.classList.remove("fail", "short");
    result.innerHTML = `<div class="bp-r-empty">Add your income above and we'll estimate the maximum a lender is likely to advance — and flag if it falls short of the loan you need.</div>`;
    return;
  }

  // Always show the real computed power — on a shortfall it's the genuine serviceable
  // figure, never a misleading $0 (req 3).
  byId("bpHead").textContent = money(est.power);

  // summary flag (visible even when collapsed) — turns red on a shortfall
  const flag = byId("bpFlag");
  if (short) { flag.hidden = false; flag.textContent = `short ${money(shortBy)}`; flag.className = "bp-sum-flag short"; }
  else { flag.hidden = false; flag.textContent = "covers your loan"; flag.className = "bp-sum-flag ok"; }

  result.classList.toggle("fail", est.bound === "fail");
  result.classList.toggle("short", short && est.bound !== "fail");
  const boundLabel = est.bound === "fail"
    ? "Your declared expenses + debts exceed your income at the assessment rate — lower them to see your capacity"
    : est.bound === "dti"
      ? "Capped at about 6× your income — a limit on high debt-to-income lending"
      : "Limited by what your income can service at the assessment rate";
  let verdict = "";
  if (needLoan > 0 && est.bound !== "fail") {
    verdict = short
      ? `<div class="bp-r-verdict short">A lender may not advance the <b>${money(needLoan)}</b> loan you're planning — about <b>${money(shortBy)}</b> short. Lower the price, add deposit, or extend the term.</div>`
      : `<div class="bp-r-verdict ok">Comfortably covers the <b>${money(needLoan)}</b> loan you're planning — <b>${money(-shortBy)}</b> of headroom.</div>`;
  }
  result.innerHTML = `
    <div class="bp-r-head">
      <span class="bp-r-cap">Estimated borrowing power</span>
      <span class="bp-r-val">${money(est.power)}</span>
    </div>
    <div class="bp-r-bound">${boundLabel}</div>
    ${verdict}
    <div class="bp-r-rows">
      <div class="bp-r-row"><span>Net income</span><span>${money(est.netMonthly)}/mo</span></div>
      <div class="bp-r-row"><span>Living expenses</span><span>−${money(est.expensesMonthly)}/mo</span></div>
      <div class="bp-r-row"><span>Debt commitments</span><span>−${money(est.commitments - est.hecsMonthly)}/mo</span></div>
      ${est.hecsMonthly > 0 ? `<div class="bp-r-row"><span>HECS/HELP repay</span><span>−${money(est.hecsMonthly)}/mo</span></div>` : ``}
      <div class="bp-r-row"><span>Monthly surplus</span><span>${money(est.surplus)}/mo</span></div>
      <div class="bp-r-row"><span>Serviced @ ${pct(est.assessmentRate, 2)}</span><span>${money(est.serviceLoan)}</span></div>
      <div class="bp-r-row"><span>Max ~6× your income</span><span>${money(est.dtiLoan)}</span></div>
    </div>`;
  byId("bpApply").disabled = !(est.power > 0);
}

/* Government first-home-buyer scheme eligibility cards (LMI itself lives in the results
   stats — these schemes are what can waive it). */
export function renderSchemes(r, est, sc) {
  if (!r) r = solve();
  if (!est) est = estimateBorrowingPower();
  if (!sc) sc = assessSchemes(r, est);
  const b = S.buyer;

  // populate the region <select> once, then reflect current selections
  const sel = byId("regionSel");
  if (!sel.options.length) sel.innerHTML = REGIONS.map((rg) => `<option value="${rg.id}">${esc(rg.label)}</option>`).join("");
  sel.value = b.region;
  if (!sel.value) { b.region = REGIONS[0].id; sel.value = b.region; } // recover from a stale saved region
  segState("fhSeg", "fh", b.firstHome ? "yes" : "no");
  segState("pkSeg", "pk", b.propertyKind);

  // ---- First Home Guarantee card ----
  const f = sc.fhbg, fhbgCard = byId("fhbgCard");
  let fbody;
  if (f.eligible) {
    fbody = `Buy with a <b>5% deposit (${money(f.minDeposit)})</b> and pay <b>no LMI</b>${f.lmiSaved > 0 ? ` — saving ~${money(f.lmiSaved)}` : ""}.`;
  } else if (!f.firstHome) {
    fbody = `For first-home buyers only.`;
  } else {
    fbody = `${money(r.P)} is above the <b>${money(f.cap)}</b> cap for ${esc(sc.region.label)}.`;
  }
  fhbgCard.className = "scheme-card " + (f.eligible ? "ok" : "off");
  fhbgCard.innerHTML =
    `<div class="sc-head"><span class="sc-title">First Home Guarantee · 5% deposit</span><span class="sc-flag">${f.eligible ? "✓ eligible" : "—"}</span></div>
     <div class="sc-body">${fbody}</div>`;

  // ---- Help to Buy card ----
  const h = sc.htb, htbCard = byId("htbCard");
  let hbody;
  if (h.eligible) {
    hbody = `Government takes <b>${h.equityPct}% equity (${money(h.govEquity)})</b>; you put in <b>2% (${money(h.minDeposit)})</b> and borrow <b>${money(h.buyerLoan)}</b> (~${money(h.repayMonthly)}/mo).`;
  } else {
    const reasons = [];
    if (!h.firstHome) reasons.push("not for current home-owners");
    if (!h.underCap) reasons.push(`over the ${money(h.cap)} cap`);
    if (!h.underIncome) reasons.push(`over the ${money(h.incomeCap)} income cap`);
    hbody = `Shared-equity scheme${reasons.length ? ` — not eligible: ${reasons.join("; ")}.` : "."}`;
  }
  htbCard.className = "scheme-card " + (h.eligible ? "ok" : "off");
  htbCard.innerHTML =
    `<div class="sc-head"><span class="sc-title">Help to Buy · shared equity</span><span class="sc-flag">${h.eligible ? "✓ eligible" : "—"}</span></div>
     <div class="sc-body">${hbody}</div>`;

  // ---- summary chip (visible when collapsed) ----
  const chip = byId("schemesChip");
  if (f.eligible) { chip.textContent = "5% deposit · no LMI"; chip.className = "sec-chip good"; }
  else if (h.eligible) { chip.textContent = "Help to Buy eligible"; chip.className = "sec-chip good"; }
  else { chip.textContent = "no scheme match"; chip.className = "sec-chip"; }
}
