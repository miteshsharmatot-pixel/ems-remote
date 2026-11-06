import { getAuthenticatedPage, withJob } from "./browser.js";

const pad = (n) => String(n).padStart(2, "0");

/** Accepts YYYY-MM-DD, DD/MM/YYYY ; returns DD/MM/YYYY (the EMS leave form format) and a Date. */
export function parseLeaveDate(input) {
  let y, m, d;
  let mt = String(input ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mt) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else if ((mt = String(input ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else throw new Error(`Invalid date "${input}". Use YYYY-MM-DD.`);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) throw new Error(`Invalid date "${input}".`);
  return { text: `${pad(d)}/${pad(m)}/${y}`, date: dt };
}

// EMS states: generic reasons like 'Personal', 'Personal Reason' or 'Work at home' are rejected.
const GENERIC_REASONS = [/^personal( reasons?| work)?$/i, /^work(ing)? (at|from) home$/i, /^wfh$/i];
export function validateReason(reason) {
  const r = String(reason ?? "").trim();
  if (!r) return "A reason is required.";
  if (r.length > 100) return `Reason is ${r.length} characters; EMS allows at most 100. Shorten it.`;
  if (r.length < 4 || GENERIC_REASONS.some((rx) => rx.test(r)))
    return `"${r}" is too generic - EMS rejects reasons like 'Personal' or 'Work at home'. Ask the user for a specific reason.`;
  return null;
}
export function validateContact(num) {
  return /^\d{10}$/.test(String(num ?? "").trim()) ? null : "Contact number must be exactly 10 digits.";
}

// ---- read-only helpers ----------------------------------------------------------------
export const getLeaveOptions = (userId) =>
  withJob(async () => {
    const page = await getAuthenticatedPage(userId);
    try {
      await page.goto("/Leave/Create", { waitUntil: "domcontentloaded" });
      return await page.evaluate(() => {
        const opts = (id) => [...(document.querySelector(id)?.options || [])].filter((o) => o.value).map((o) => ({ id: o.value, label: o.text.replace(/\s+/g, " ").trim() }));
        return { approvers: opts("#ApproverId"), leaveTypes: opts("#LeaveMasterId") };
      });
    } finally { await page.close(); }
  });

/**
 * Runs INSIDE the page (also unit-testable with jsdom). Matched to the real /Leave markup:
 * balances in ul#sparks, rows in #leave-list table, full reason in the <a data-original-title> tooltip,
 * a "*" next to a date marks a half day on that date.
 */
export function extractLeavesFromDocument() {
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const balances = {};
  document.querySelectorAll("#sparks li h5").forEach((h5) => {
    const span = h5.querySelector("span");
    if (!span) return;
    const label = clean(h5.textContent.replace(span.textContent, ""));
    balances[label] = parseFloat(span.textContent);
  });
  const rows = [];
  document.querySelectorAll("#leave-list table tbody tr").forEach((tr) => {
    const td = [...tr.querySelectorAll("td")];
    if (td.length < 10) return;
    const dm = clean(td[1].innerText || td[1].textContent).match(/(\d{2}\/\d{2}\/\d{4})(\*?)\s*-\s*(\d{2}\/\d{2}\/\d{4})(\*?)/);
    if (!dm) return;
    const approval = (cell) => ({
      name: clean(cell.textContent),
      approved: !!cell.querySelector(".greenButton"),
      rejected: !!cell.querySelector(".redButton"),
    });
    const a = td[4].querySelector("a");
    rows.push({
      from: dm[1], to: dm[3], halfDayOnStart: dm[2] === "*", halfDayOnEnd: dm[4] === "*",
      day: clean(td[2].textContent), days: parseFloat(td[3].textContent),
      reason: clean((a && a.getAttribute("data-original-title")) || td[4].textContent),
      leaveType: clean(td[5].textContent), status: clean(td[6].textContent),
      manager: approval(td[7]), adminHr: approval(td[8]), createdOn: clean(td[9].textContent),
    });
  });
  const info = clean(document.querySelector("#dt_basic_info")?.textContent);
  const pages = document.querySelectorAll(".pagination li").length;
  return { balances, rows, info, pages };
}

const toDate = (dmy) => { const [d, m, y] = dmy.split("/").map(Number); return new Date(y, m - 1, d); };

/** Post-processing shared by the tool and tests. */
export function summarizeLeaves(raw, { year, status, limit = 15 } = {}) {
  const yr = year ?? new Date().getFullYear();
  const usedByType = {};
  let pendingCount = 0;
  for (const r of raw.rows) {
    if (/pending|waiting|applied/i.test(r.status) || !/approved|reject|cancel/i.test(r.status)) pendingCount++;
    if (/approved/i.test(r.status) && toDate(r.from).getFullYear() === yr)
      usedByType[r.leaveType] = Math.round(((usedByType[r.leaveType] || 0) + r.days) * 10) / 10;
  }
  let list = raw.rows;
  if (status) list = list.filter((r) => r.status.toLowerCase().includes(status.toLowerCase()));
  list = list.slice(0, limit).map((r) => ({
    from: r.from + (r.halfDayOnStart ? " (half day)" : ""),
    to: r.to + (r.halfDayOnEnd ? " (half day)" : ""),
    days: r.days, leaveType: r.leaveType, status: r.status, reason: r.reason,
    manager: `${r.manager.name}${r.manager.approved ? " (approved)" : r.manager.rejected ? " (rejected)" : ""}`,
    adminHr: `${r.adminHr.name}${r.adminHr.approved ? " (approved)" : r.adminHr.rejected ? " (rejected)" : ""}`,
    requestedOn: r.createdOn,
  }));
  return {
    remainingBalance: raw.balances,
    [`daysTakenIn${yr}_approved`]: usedByType,
    requestsNotYetDecided: pendingCount,
    tableInfo: raw.info, pagesAvailable: raw.pages,
    leaves: list,
  };
}

export const getMyLeaves = (userId, opts = {}) =>
  withJob(async () => {
    const page = await getAuthenticatedPage(userId);
    try {
      await page.goto("/Leave", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#leave-list, #sparks", { timeout: 10000 }).catch(() => {});
      const raw = await page.evaluate(extractLeavesFromDocument);
      return summarizeLeaves(raw, opts);
    } finally { await page.close(); }
  });

// ---- fill (no save) -> user confirms -> submit --------------------------------------------
const open = new Map(); // userId -> { page, summary, timer }
const TTL = 20 * 60 * 1000;
function drop(userId) {
  const e = open.get(userId);
  if (e) { clearTimeout(e.timer); open.delete(userId); }
  return e;
}

export const prepareLeave = (userId, a) =>
  withJob(async () => {
    const start = parseLeaveDate(a.startDate);
    const end = parseLeaveDate(a.endDate ?? a.startDate);
    if (end.date < start.date) throw new Error("End date is before start date.");
    const reasonErr = validateReason(a.reason); if (reasonErr) throw new Error(reasonErr);
    const contactErr = validateContact(a.contactNumber); if (contactErr) throw new Error(contactErr);

    const old = drop(userId); if (old) await old.page.close().catch(() => {});
    const page = await getAuthenticatedPage(userId);
    await page.goto("/Leave/Create", { waitUntil: "domcontentloaded" });

    const res = await page.evaluate(({ startText, endText, halfStart, halfEnd, approver, leaveType }) => {
      const pickText = (sel, wanted) => {
        if (!sel) return null;
        const w = (wanted || "").toLowerCase().replace(/\s+/g, " ").trim();
        const opts = [...sel.options].filter((o) => o.value);
        const norm = (o) => o.text.replace(/\s+/g, " ").trim().toLowerCase();
        return opts.find((o) => norm(o) === w) || opts.find((o) => w && (norm(o).includes(w) || w.includes(norm(o).replace(/\(.*\)/, "").trim()))) || null;
      };
      const ap = pickText(document.querySelector("#ApproverId"), approver);
      const lt = pickText(document.querySelector("#LeaveMasterId"), leaveType);
      return {
        approver: ap ? { id: ap.value, label: ap.text.replace(/\s+/g, " ").trim() } : null,
        leaveType: lt ? { id: lt.value, label: lt.text.replace(/\s+/g, " ").trim() } : null,
        approverOptions: [...document.querySelectorAll("#ApproverId option")].filter((o) => o.value).map((o) => o.text.replace(/\s+/g, " ").trim()),
        leaveTypeOptions: [...document.querySelectorAll("#LeaveMasterId option")].filter((o) => o.value).map((o) => o.text.trim()),
      };
    }, { startText: start.text, endText: end.text, halfStart: !!a.halfDayOnStart, halfEnd: !!a.halfDayOnEnd, approver: a.approver, leaveType: a.leaveType });

    if (!res.approver) { await page.close(); throw new Error(`Approver "${a.approver}" not found. Available: ${res.approverOptions.join(", ")}`); }
    if (!res.leaveType) { await page.close(); throw new Error(`Leave type "${a.leaveType}" not found. Available: ${res.leaveTypeOptions.join(", ")}`); }

    await page.selectOption("#ApproverId", res.approver.id);
    await page.selectOption("#LeaveMasterId", res.leaveType.id);
    // dates: set value + fire events so the datepicker/validation notice the change
    for (const [sel, val] of [["#LeaveStart", start.text], ["#LeaveEnd", end.text]]) {
      await page.evaluate(({ sel, val }) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, { sel, val });
    }
    await page.setChecked("#HalfDayOnStartDate", !!a.halfDayOnStart);
    await page.setChecked("#HalfDayOnEndDate", !!a.halfDayOnEnd);
    await page.fill("#Reason", a.reason.trim());
    await page.fill("#ContactNumber", String(a.contactNumber).trim());

    // approximate requested days (Mon-Fri) vs balance shown in the dropdown label, e.g. "Casual Leave(1.5)"
    let requested = 0;
    for (let d = new Date(start.date); d <= end.date; d.setDate(d.getDate() + 1)) if (d.getDay() !== 0 && d.getDay() !== 6) requested++;
    if (a.halfDayOnStart) requested -= 0.5;
    if (a.halfDayOnEnd && end.text !== start.text) requested -= 0.5;
    const bal = res.leaveType.label.match(/\(([\d.]+)\)/);
    const balanceWarning = bal && requested > parseFloat(bal[1])
      ? `Requested about ${requested} weekday(s) but "${res.leaveType.label}" shows only ${bal[1]} remaining - EMS may reject it or the user may prefer LWP.` : null;

    const summary = {
      from: start.text + (a.halfDayOnStart ? " (half day)" : ""),
      to: end.text + (a.halfDayOnEnd ? " (half day)" : ""),
      leaveType: res.leaveType.label, approver: res.approver.label,
      reason: a.reason.trim(), contactNumber: String(a.contactNumber).trim(),
      approxWeekdays: requested, balanceWarning,
    };
    const timer = setTimeout(() => { page.close().catch(() => {}); open.delete(userId); }, TTL);
    timer.unref();
    open.set(userId, { page, summary, timer });
    return { summary, screenshot: await page.screenshot({ fullPage: true }) };
  });

export const submitLeave = (userId) =>
  withJob(async () => {
    const e = open.get(userId);
    if (!e || e.page.isClosed()) throw new Error("No prepared leave request (it may have expired after 20 min). Call ems_prepare_leave again.");
    const { page, summary } = e;
    await page.locator("button.btntype, button:has-text('Save Changes')").first().click();
    await page.waitForTimeout(2500);
    const errors = await page.locator(".field-validation-error, .validation-summary-errors, .alert-danger").allInnerTexts().catch(() => []);
    const message = await page.locator(".toast-message, .alert-success, .alert-info").first().innerText().catch(() => null);
    const screenshot = await page.screenshot({ fullPage: true });
    const stillOnForm = /\/Leave\/Create/i.test(page.url());
    const failed = errors.map((x) => x.trim()).filter(Boolean);
    if (failed.length && stillOnForm) {
      // keep the page open so the user can fix & retry
      return { saved: false, errors: failed, summary, screenshot };
    }
    const finalUrl = page.url();
    drop(userId);
    await page.close().catch(() => {});
    return { saved: true, message: message?.trim() || null, finalUrl, summary, screenshot };
  });

export const discardLeave = async (userId) => {
  const e = drop(userId);
  if (e) await e.page.close().catch(() => {});
};
