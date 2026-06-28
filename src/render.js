import { S, FREQ_LABEL, FREQ_TITLE } from "./state.js";
import { solve, amortize, estimateBorrowingPower, estimateLMI } from "./finance.js";
import { money, pct, nf0, moneyInput, compact, esc, fmtDuration } from "./format.js";
import { byId, anim, setNum, segState, lockSVG } from "./dom.js";
import { saveStateSoon } from "./persist.js";

/* ============================ Render ============================ */
let activeEdit = null; // key currently being typed in
let lastRepayMode = null; // tracks hero figure semantics to avoid cross-meaning tweens

// events.js sets the field being typed in so render() won't reformat it mid-edit.
export function setActiveEdit(v) { activeEdit = v; }

export function render() {
  const r = solve();
  const est = estimateBorrowingPower();
  // Amortise ONCE (reflecting any extra repayment) and share across stats + chart;
  // baseline (no extra) drives the "you'd save" comparisons.
  const am = amortize(r.L, S.rate, S.termYears, r.p, S.extra);
  const amBase = S.extra > 0 ? amortize(r.L, S.rate, S.termYears, r.p, 0) : am;

  /* rate control — reflect state unless you're mid-edit in the field */
  if (document.activeElement !== byId("rate")) byId("rate").value = S.rate.toFixed(2);

  /* collapsed-section headline figures (glanceable when a section is folded) */
  byId("rH").textContent = pct(S.rate, 2);
  byId("fH").textContent = money(r.L);

  /* money fields — lock styling for all four; simple inputs for three (deposit is a sources card) */
  const vals = { property: r.P, loan: r.L, repayment: S.repayment };
  ["property", "deposit", "loan", "repayment"].forEach((key) => {
    const field = document.querySelector(`.field[data-key="${key}"]`);
    const locked = S.locked.includes(key);
    field.classList.toggle("locked", locked);
    field.classList.toggle("solved", !locked);
    const lockBtn = field.querySelector(".lock");
    lockBtn.innerHTML = lockSVG(locked);
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
  setNum(byId("heroRepay"), r.rActual, money);
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
  setNum(byId("heroAV"), repayMode ? r.L : r.P, money);
  setNum(byId("heroBV"), repayMode ? r.P : r.L, money);

  const badge = byId("lvrBadge");
  badge.textContent = "LVR " + pct(r.lvr, 1);
  // complete class strings per branch (no fragment concat) so the build-time class minifier can see them
  badge.className = r.lvr <= 0 ? "lvr-badge neutral" : r.lvr > 90 ? "lvr-badge bad" : r.lvr > 80 ? "lvr-badge warn" : "lvr-badge ok";

  /* mini sticky repayment bar (shown once the hero scrolls away) — repayment figure only */
  byId("mbLabel").textContent = FREQ_TITLE[S.freq] + " repay";
  byId("mbVal").textContent = money(r.rActual);

  /* stat grid + first-repayment split + extra repayments + chart + borrowing power */
  renderStats(r, am, amBase);
  renderFirstPay(r);
  renderExtra(r, am, amBase);
  renderChart(r, am);
  renderEstimator(r, est);

  saveStateSoon(); // persist inputs (debounced) so they survive a refresh
}

/* Lightweight update for income edits (salary / bonus / extra lines / HECS / applicant count).
   Income only feeds the borrowing-power estimate — never the loan, amortisation, chart,
   schedule, LMI or scheme eligibility — so update just the estimator and skip the heavy
   repaints (re-amortising per keystroke produced byte-identical output). */
export function renderIncomeArea() {
  const r = solve();
  const est = estimateBorrowingPower();
  renderEstimator(r, est);
  saveStateSoon();
}

function renderStats(r, am, amBase) {
  const lmi = estimateLMI(r.L, r.P);
  let lmiStat;
  if (lmi.premium > 0) {
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
  byId("statGrid").innerHTML = stats.map((s) => {
    const t = s.tone ? " " + s.tone : ""; // tone (ok/warn/accent) is data-driven; kept out of class minification
    return `<div class="stat${t}"><div class="k">${s.k}</div><div class="v">${s.v}</div><div class="note">${s.note}</div></div>`;
  }).join("");
}

/* Extra-repayments panel (req 10): default $0; reflects how much faster you'd be debt-free
   and how much interest you'd save by paying extra on top of each scheduled repayment. */
function renderExtra(r, am, amBase) {
  byId("extraFreq").textContent = "/" + FREQ_LABEL[S.freq];
  const out = byId("extraResult");
  if (!(r.L > 0)) { out.innerHTML = `No loan to pay down at these settings.`; return; }
  if (!(S.extra > 0)) { out.innerHTML = ""; return; }
  const saved = amBase.totalInterest - am.totalInterest;
  const sooner = S.termYears - am.payoffYears;
  out.innerHTML =
    `Paying <b>${money(S.extra)}/${FREQ_LABEL[S.freq]}</b> extra clears your loan` +
    (sooner > 0.04 ? ` <b class="good">${fmtDuration(sooner)} sooner</b>` : ``) +
    (saved > 1 ? ` and saves <b class="good">${money(saved)}</b> in interest.` : `.`);
}

/* First-repayment split — how much of payment #1 is interest (your cost of borrowing, to
   weigh against rent) vs principal (equity you build). Early payments are mostly interest. */
function renderFirstPay(r) {
  const sub = byId("firstPaySub"), fp = byId("firstPay");
  if (!(r.L > 0 && r.rActual > 0)) {
    sub.textContent = "";
    fp.innerHTML = `<div class="fp-note">No loan to split at these settings.</div>`;
    return;
  }
  const firstInt = r.L * (S.rate / 100 / r.p);
  const firstPrin = Math.max(0, r.rActual - firstInt);
  const intPct = Math.round((firstInt / r.rActual) * 100);
  sub.textContent = `· ${money(r.rActual)} per ${FREQ_LABEL[S.freq]}`;
  fp.innerHTML =
    `<div class="split-bar"><div class="seg-p" style="width:${100 - intPct}%"></div><div class="seg-i" style="width:${intPct}%"></div></div>
     <div class="split-legend">
       <div class="li"><span class="sw p"></span> Principal <b>${money(firstPrin)}</b></div>
       <div class="li"><span class="sw i"></span> Interest <b>${money(firstInt)}</b></div>
       <div class="li" style="margin-left:auto"><b>${intPct}%</b> to interest</div>
     </div>`;
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
    const xy = `${X(pt.yr).toFixed(1)} ${Y(pt.bal).toFixed(1)} `;
    line += (idx === 0 ? "M " : "L ") + xy; area += "L " + xy;
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
/* Shared funding-row component. The deposit-source rows and the per-applicant extra-income
   rows are the same control (name + $ amount + optional delete), so they share one markup
   builder and one .src-* style set. They're disambiguated at the event layer by their
   container (#depSources vs #bpIncomes), not by class name — see events.js. */
export const srcRow = ({ data, name, amount, namePh, nameAria, amtAria, del }) => `
    <div class="src-row" ${data}>
      <input class="src-name" ${data} value="${esc(name)}" placeholder="${namePh}" aria-label="${nameAria}" />
      <div class="src-amt-wrap"><span class="src-cur">$</span><input class="src-amt" ${data} inputmode="numeric" value="${moneyInput(amount)}" placeholder="0" aria-label="${amtAria}" /></div>
      ${del ? `<button type="button" class="src-del" ${data} aria-label="${del}">&times;</button>` : ``}
    </div>`;

export function renderSources() {
  const multi = S.depositSources.length > 1;
  byId("depSources").innerHTML = S.depositSources.map((s, i) => srcRow({
    data: `data-idx="${i}"`,
    name: s.name, amount: s.amount,
    namePh: "Source (e.g. Savings)",
    nameAria: `Funding source ${i + 1} name`,
    amtAria: `${esc(s.name) || "Source " + (i + 1)} amount`,
    del: multi ? `Remove ${esc(s.name) || "source " + (i + 1)}` : null,
  })).join("");
}

/* Build per-applicant income blocks: a Salary + Bonus box (the common case), optional
   extra income lines (rental / other), and a HECS/HELP toggle. Rebuilt only on init /
   add / remove / applicant change so typing never loses the caret. */
export function renderIncomes() {
  const e = S.estimator;
  let html = "";
  for (let a = 0; a < e.applicants; a++) {
    const inc = e.incomes[a] || {};
    const extra = inc.extra || [];
    const title = e.applicants > 1 ? `Applicant ${a + 1}` : "Your income";
    const extraHtml = extra.map((row, i) => srcRow({
      data: `data-app="${a}" data-idx="${i}"`,
      name: row.label, amount: row.amount,
      namePh: "e.g. Rental /yr",
      nameAria: `Other income ${i + 1} label`,
      amtAria: `Other income ${i + 1} amount per year`,
      del: `Remove other income ${i + 1}`,
    })).join("");
    html += `<div class="bp-applicant">
      <div class="bp-app-title">${title}</div>
      <div class="inc-primary">
        <div class="bp-field">
          <label class="mini-label" for="inc-salary-${a}">Salary /yr</label>
          <div class="bp-in"><span class="bp-cur">$</span><input id="inc-salary-${a}" class="bp-num inc-main" data-app="${a}" data-field="salary" inputmode="numeric" value="${moneyInput(inc.salary)}" placeholder="0" /></div>
        </div>
        <div class="bp-field">
          <label class="mini-label" for="inc-bonus-${a}">Bonus /yr</label>
          <div class="bp-in"><span class="bp-cur">$</span><input id="inc-bonus-${a}" class="bp-num inc-main" data-app="${a}" data-field="bonus" inputmode="numeric" value="${moneyInput(inc.bonus)}" placeholder="0" /></div>
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
  const failed = est.bound === "fail";   // surplus ≤ 0 → can't service any loan (power 0): the worst case
  const noLoan = needLoan <= 0;           // deposit already covers the property — borrowing power is moot
  const shortBy = needLoan - est.power;
  const short = !failed && !noLoan && est.power < needLoan - 1;

  byId("bpAssessNote").textContent = pct(est.assessmentRate, 2);
  byId("bpHemHint").textContent = est.hemBinds && hasIncome ? `HEM floor ${money(est.hem)}/mo applies` : "";
  const result = byId("bpResult");

  // empty state — no income entered yet. Show $0 as the starting figure and move the
  // call-to-action into the section note; the result panel stays hidden until there's income.
  if (!hasIncome) {
    byId("bpHead").textContent = "$0";
    byId("bpFlag").hidden = true;
    byId("bpFlag").className = "bp-sum-flag";
    byId("bpApply").disabled = true;
    byId("bpNote").textContent = "Add your income below to estimate the maximum a bank is likely to lend.";
    result.hidden = true;
    result.classList.remove("fail", "short");
    result.innerHTML = "";
    return;
  }

  // income entered — show the descriptor note and the result panel with the real computed
  // power (on a shortfall that's the genuine serviceable figure, never a misleading $0, req 3).
  byId("bpNote").textContent = "How much a lender might lend, at the assessment rate below.";
  result.hidden = false;
  byId("bpHead").textContent = money(est.power);

  // summary flag (visible even when collapsed) — must agree with the result panel below.
  // fail (can't service anything) reads red just like a shortfall; "no loan needed" is the
  // moot case (deposit covers the property) so it's neutral, never a green "covers" claim.
  const flag = byId("bpFlag");
  flag.hidden = false;
  if (noLoan) { flag.textContent = "no loan needed"; flag.className = "bp-sum-flag neutral"; }
  else if (failed || short) { flag.textContent = `short ${money(shortBy)}`; flag.className = "bp-sum-flag short"; }
  else { flag.textContent = "covers your loan"; flag.className = "bp-sum-flag ok"; }

  // result panel severity — fail and short both read red (the unaffordable cases); fail is
  // the more severe so it owns the strongest treatment. They're mutually exclusive by definition.
  result.classList.toggle("fail", failed);
  result.classList.toggle("short", short);
  let verdict = "";
  if (!noLoan && !failed) {
    verdict = short
      ? `<div class="bp-r-verdict short">You're short by about <b>${money(shortBy)}</b>.</div>`
      : `<div class="bp-r-verdict ok">Comfortably covers the <b>${money(needLoan)}</b> loan you're planning — <b>${money(-shortBy)}</b> of headroom.</div>`;
  }
  const detailRows = [
    ["Net income", `${money(est.netMonthly)}/mo`],
    ["Living expenses", `−${money(est.expensesMonthly)}/mo`],
    ["Debt commitments", `−${money(est.commitments - est.hecsMonthly)}/mo`],
    ...(est.hecsMonthly > 0 ? [["HECS/HELP repay", `−${money(est.hecsMonthly)}/mo`]] : []),
    ["Monthly surplus", `${money(est.surplus)}/mo`],
    [`Serviced @ ${pct(est.assessmentRate, 2)}`, money(est.serviceLoan)],
    ["Max ~6× your income", money(est.dtiLoan)],
  ];
  result.innerHTML = `
    <div class="bp-r-head">
      <span class="bp-r-cap">Estimated borrowing power</span>
      <span class="bp-r-val">${money(est.power)}</span>
    </div>
    ${verdict}
    <div class="bp-r-rows">${detailRows.map(([k, v]) => `<div class="bp-r-row"><span>${k}</span><span>${v}</span></div>`).join("")}</div>`;
  byId("bpApply").disabled = !(est.power > 0);
}
