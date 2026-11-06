import { apiRequest, parseHtml } from "./browser.js";
import { EMS_BASE_URL } from "./config.js";
import { resolveTaskType, resolveStatus, normalizeDuration, addEditUrl } from "./ems.js";
import { getTemplates, setTemplate, removeTemplate } from "./db.js";

// All EMS access here is plain HTTP with the user's session cookies (no page load, no screenshots).
// HTML is parsed with the self-contained DOM functions below (they run inside parseHtml).

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mins = (s) => { const m = /^(\d+):(\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : 0; };
const hhmm = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const dmyToIso = (s) => { const [d, m, y] = s.split("/"); return `${y}-${m}-${d}`; };

export function parseDate(input) {
  const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  if (input == null || input === "" || input === "today") return today();
  if (input === "yesterday") { const d = today(); d.setDate(d.getDate() - 1); return d; }
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) return new Date(+m[1], m[2] - 1, +m[3]);
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input); // MM/DD/YYYY, same as ems.js
  if (m) return new Date(+m[3], m[1] - 1, +m[2]);
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new Error(`Could not parse date: ${input}`);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ---------------------------------------------------------------- DOM parsers
const parseTasks = (d) => {
  const txt = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const out = [];
  let date = "";
  for (const tr of d.querySelectorAll("table tbody tr")) {
    const c = [...tr.children];
    const first = txt(c[0]);
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(first)) { date = first; continue; }
    if (c.length < 9) continue;
    const del = tr.querySelector("a[href*='/Task/Delete/']");
    out.push({
      date, id: del ? del.getAttribute("href").split("/").pop() : "", project: first, type: txt(c[2]), desc: txt(c[3]),
      est: txt(c[4]), dur: txt(c[5]), bill: txt(c[6]), status: txt(c[7]), approval: txt(c[8]),
    });
  }
  return out;
};

const parseForm = (d) => {
  const f = [...d.forms].find((x) => /\/Task\/AddEdit/i.test(x.getAttribute("action") || "") && x.querySelector("[name^='Tasks[']"));
  if (!f) return null;
  const fields = [];
  for (const el of f.elements) {
    const t = (el.type || "").toLowerCase();
    if (!el.name || el.disabled || ["submit", "button", "image", "reset", "file"].includes(t)) continue;
    if ((t === "checkbox" || t === "radio") && !el.checked) continue;
    if (el.tagName === "SELECT") { const o = el.selectedOptions[0] || el.options[0]; fields.push([el.name, o ? o.value : ""]); }
    else fields.push([el.name, el.value]);
  }
  const opts = (n) => { const s = f.querySelector(`select[name$='.${n}']`); return s ? [...s.options].map((o) => ({ text: o.text.trim(), value: o.value })) : []; };
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const g = (n) => f.querySelector(`[name="Tasks[${i}].${n}"]`);
    const dur = g("Duration"), desc = g("Description"), proj = g("ProjectName");
    if (!dur && !desc && !proj) break;
    const sel = (n) => { const s = g(n); return s && s.selectedOptions[0] ? s.selectedOptions[0].text.trim() : ""; };
    rows.push({
      i, id: (g("ProjectTaskId") || {}).value || "", project: proj ? proj.value : "", desc: desc ? desc.value.trim() : "",
      dur: dur ? dur.value : "", est: (g("EstimatedTime") || {}).value || "", type: sel("TaskTypeId"), status: sel("TaskStatus"),
      locked: !!((dur && dur.disabled) || (desc && desc.disabled)),
    });
  }
  return { action: f.getAttribute("action"), fields, rows, types: opts("TaskTypeId"), statuses: opts("TaskStatus") };
};

const parseErrors = (d) =>
  [...d.querySelectorAll(".validation-summary-errors li, .field-validation-error, .alert-danger, .toast-message")]
    .map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5);

const parseTable = (d, needle) => {
  const txt = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const t = [...d.querySelectorAll("table")].find((x) => (x.querySelector("thead") || x).textContent.includes(needle));
  if (!t) return null;
  const head = [...t.querySelectorAll("thead th")].map(txt);
  const rows = [...t.querySelectorAll("tbody tr")].map((tr) => ({
    cells: [...tr.children].map(txt),
    first: (() => {
      const c0 = tr.children[0];
      if (!c0) return "";
      const tn = [...c0.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      return tn ? tn.textContent.replace(/\s+/g, " ").trim() : txt(c0.querySelector("a") || c0);
    })(),
    link: (tr.querySelector("a[href*='/']:not([href^='#']):not([href^='javascript'])") || { getAttribute: () => "" }).getAttribute("href"),
  }));
  return { head, rows, month: txt(d.querySelector("#currentMonthDate")) };
};

// ---------------------------------------------------------------- projects
const projCache = new Map();
export async function findProjects(userId, term) {
  const key = `${userId}|${(term || "").toLowerCase()}`;
  const hit = projCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.list;
  const r = await apiRequest(userId, "GET", `/Task/Projects?term=${encodeURIComponent(term || "")}`, {
    headers: { Accept: "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
  });
  if (r.status() !== 200) throw new Error(`Project search failed: HTTP ${r.status()}`);
  const list = (await r.json()).map((p) => ({ id: String(p.id ?? p.value ?? p.ProjectId ?? ""), name: p.label ?? p.name ?? p.text ?? p.ProjectName ?? "" }));
  projCache.set(key, { at: Date.now(), list });
  return list;
}

async function resolveProject(userId, t) {
  if (t.projectId) return { id: String(t.projectId), name: t.project || "" };
  if (!t.project) return { error: "no project given" };
  const list = await findProjects(userId, t.project);
  const q = t.project.toLowerCase();
  const exact = list.find((p) => p.name.toLowerCase() === q);
  if (exact) return exact;
  if (list.length === 1) return list[0];
  return { error: list.length ? `ambiguous, use one of: ${list.slice(0, 6).map((p) => p.name).join(" | ")}` : "not found" };
}

// ---------------------------------------------------------------- task list / reports
export async function getTasks(userId, from, to) {
  const page = async (p) => {
    const q = new URLSearchParams({ pageNumber: p, keyword: "", taskStartDate: iso(from), taskEndDate: iso(to) });
    const rows = await parseHtml(await (await apiRequest(userId, "GET", `/Task?${q}`)).text(), parseTasks);
    return { rows, groups: new Set(rows.map((x) => x.date)).size };
  };
  // a page holds 10 date groups and a range has at most one group per day -> fetch every needed page at once
  const days = Math.round((to - from) / 864e5) + 1;
  const first = Math.min(8, Math.max(1, Math.ceil(days / 10)));
  const pages = await Promise.all(Array.from({ length: first }, (_, i) => page(i + 1)));
  while (pages.length < 8 && pages[pages.length - 1].groups >= 10) pages.push(await page(pages.length + 1));
  const seen = new Set();
  const out = [];
  for (const { rows } of pages) {
    const fresh = [...new Set(rows.map((x) => x.date))].filter((x) => !seen.has(x));
    fresh.forEach((x) => seen.add(x));
    out.push(...rows.filter((x) => fresh.includes(x.date)));
  }
  return out.map((r) => ({ ...r, iso: dmyToIso(r.date) }));
}

const short = (s, n = 100) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const rowLine = (r) => `${r.iso ? r.iso + " " : ""}${r.project}|${r.type}|${r.dur}|${r.status}${r.approval ? "|" + r.approval : ""}${r.id ? " #" + r.id : ""} ${short(r.desc)}`;

const parseHolidays = (d) => {
  const out = [];
  const t = d.querySelector("table");
  for (const td of t ? t.querySelectorAll("td") : []) {
    const s = td.textContent.trim();
    if (/^\d{2}-[A-Za-z]+-\d{4}$/.test(s)) out.push([s, td.nextElementSibling ? td.nextElementSibling.textContent.trim() : ""]);
  }
  return out;
};
let holidayCache = null;
async function holidays(userId) {
  if (holidayCache && Date.now() - holidayCache.at < 12 * 3600 * 1000) return holidayCache.map;
  const map = new Map();
  try {
    const r = await apiRequest(userId, "GET", "/Home/Holiday");
    for (const [s, name] of await parseHtml(await r.text(), parseHolidays)) {
      const [dd, mon, yy] = s.split("-");
      const d = new Date(`${mon} ${dd}, ${yy} 00:00:00`);
      if (!isNaN(d)) map.set(iso(d), name);
    }
  } catch { /* holidays are optional */ }
  holidayCache = { at: Date.now(), map };
  return map;
}

export async function taskReport(userId, { view = "list", from, to, minHours = 8 }) {
  const end = to ? parseDate(to) : parseDate("today");
  const start = from ? parseDate(from) : new Date(end.getFullYear(), end.getMonth(), 1);
  const rows = await getTasks(userId, start, end);
  const total = rows.reduce((s, r) => s + mins(r.dur), 0);
  const head = `${iso(start)}..${iso(end)}: ${rows.length} tasks, ${hhmm(total)} total`;
  if (view === "list") return [head, ...rows.map(rowLine)].join("\n");

  if (view === "missing") {
    const byDay = new Map();
    for (const r of rows) byDay.set(r.iso, (byDay.get(r.iso) || 0) + mins(r.dur));
    const hol = await holidays(userId);
    const bad = [];
    const last = end < parseDate("today") ? end : parseDate("today");
    for (let d = new Date(start); d <= last; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 || d.getDay() === 6 || hol.has(iso(d))) continue; // weekends and company holidays
      const m = byDay.get(iso(d)) || 0;
      if (m < minHours * 60) bad.push(`${iso(d)} ${d.toDateString().slice(0, 3)} ${m ? hhmm(m) : "MISSING"}`);
    }
    return [head, bad.length ? `Working days under ${minHours}h:\n${bad.join("\n")}` : `All working days have at least ${minHours}h.`].join("\n");
  }

  const proj = new Map();
  for (const r of rows) {
    const d = parseDate(r.iso); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday of that week
    const p = proj.get(r.project) || { total: 0, weeks: new Map() };
    p.total += mins(r.dur);
    p.weeks.set(iso(d), (p.weeks.get(iso(d)) || 0) + mins(r.dur));
    proj.set(r.project, p);
  }
  const lines = [...proj].sort((a, b) => b[1].total - a[1].total)
    .map(([n, p]) => `${n}: ${hhmm(p.total)} | week of ${[...p.weeks].sort().map(([w, m]) => `${w.slice(5)}=${hhmm(m)}`).join(" ")}`);
  return [head, ...lines].join("\n");
}

// ---------------------------------------------------------------- task form (add / edit / delete)
export async function loadForm(userId, date) {
  const r = await apiRequest(userId, "GET", addEditUrl(iso(date)));
  if (r.status() !== 200) throw new Error(`EMS task form unavailable (HTTP ${r.status()})`);
  const form = await parseHtml(await r.text(), parseForm);
  if (!form) throw new Error("FAST_UNAVAILABLE: task form not found in page");
  return form;
}

// EMS pre-fills the project on blank rows, so a project alone does not make a row "used"
const occupied = (r) => (r.dur && r.dur !== "00:00") || r.desc;
export const NEW_ROW_DEFAULTS = { CreatedBy: "", ProjectTaskId: "0", TechId: "1", Sprint: "0" };

export function setRow(fields, i, vals) {
  for (const [k, v] of Object.entries(vals)) {
    const name = `Tasks[${i}].${k}`;
    const f = fields.find((x) => x[0] === name);
    if (f) f[1] = v; else fields.push([name, v]);
  }
}

function pick(opts, label, raw) {
  const l = (label || "").toLowerCase();
  return opts.find((o) => o.text.toLowerCase() === l) || opts.find((o) => o.value === raw) || (l && opts.find((o) => o.text.toLowerCase().includes(l))) || null;
}

async function postForm(userId, date, form) {
  const r = await apiRequest(userId, "POST", form.action || "/Task/AddEdit", {
    data: new URLSearchParams(form.fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: EMS_BASE_URL + addEditUrl(iso(date)) },
  });
  if (r.status() >= 300 && r.status() < 400) return { ok: true };
  return { ok: false, status: r.status(), errors: await parseHtml(await r.text(), parseErrors) };
}

async function dayAfter(userId, date) {
  const rows = await getTasks(userId, date, date);
  return { rows, total: hhmm(rows.reduce((s, r) => s + mins(r.dur), 0)) };
}

export async function dayTasks(userId, dateInput) {
  const date = parseDate(dateInput);
  const f = await loadForm(userId, date);
  return { date: iso(date), rows: f.rows.filter(occupied) };
}

/** Add tasks to a day by POSTing the form directly. Nothing is saved if any task has an issue. */
export async function addTasks(userId, dateInput, tasks, preview = false) {
  const date = parseDate(dateInput);
  // form download and project lookups run in parallel
  const [form, ...projects] = await Promise.all([loadForm(userId, date), ...tasks.map((t) => resolveProject(userId, t))]);
  const existing = form.rows.filter(occupied);
  const issues = [], warnings = [], skipped = [], plan = [];

  tasks.forEach((t, n) => {
    const p = projects[n];
    const label = t.project || `task ${n + 1}`;
    if (p.error) return issues.push(`${label}: ${p.error}`);
    const type = resolveTaskType(t.taskType), status = resolveStatus(t.status);
    const typeOpt = pick(form.types, type.label, type.raw), statusOpt = pick(form.statuses, status.label, status.raw);
    if (!typeOpt) issues.push(`${label}: task type "${type.raw}" not found`);
    else if (type.guessed) issues.push(`${label}: task type "${type.raw}" not recognised (would use "${type.label}")`);
    if (!statusOpt) issues.push(`${label}: status "${status.raw}" not found`);
    const duration = normalizeDuration(t.duration), desc = t.description || "Work completed as planned";
    if (duration === "00:00") warnings.push(`${label}: duration is 00:00`);
    if (existing.some((e) => e.project.toLowerCase() === p.name.toLowerCase() && e.desc === desc.trim() && e.dur === duration))
      return skipped.push(`${p.name}: "${short(desc, 40)}" already entered`);
    if (typeOpt && statusOpt) plan.push({ p, typeOpt, statusOpt, duration, est: normalizeDuration(t.estimatedDuration ?? t.duration), desc });
  });
  if (issues.length) return { saved: 0, issues, warnings, skipped };

  const free = form.rows.filter((r) => !occupied(r)).map((r) => r.i);
  let next = form.rows.length;
  const fields = form.fields.map((f) => [...f]);
  for (const x of plan) {
    const i = free.length ? free.shift() : next++;
    if (i >= 15) return { saved: 0, issues: ["More than 15 task rows for one day"], warnings, skipped };
    setRow(fields, i, {
      ...(i >= form.rows.length ? NEW_ROW_DEFAULTS : {}),
      EstimatedTime: x.est, ProjectId: x.p.id, ProjectName: x.p.name, TaskTypeId: x.typeOpt.value,
      Description: x.desc, Duration: x.duration, TaskStatus: x.statusOpt.value,
    });
  }
  if (!plan.length) return { saved: 0, issues: [], warnings, skipped };
  if (preview) return { saved: 0, preview: plan.map((x) => `${x.p.name}|${x.typeOpt.text}|${x.duration}|${x.statusOpt.text} ${short(x.desc)}`), warnings, skipped };

  const res = await postForm(userId, date, { ...form, fields });
  if (!res.ok) return { saved: 0, issues: [`EMS rejected the form (HTTP ${res.status}): ${res.errors.join("; ") || "no message"}`], warnings, skipped };
  const day = await dayAfter(userId, date);
  const verified = day.rows.length >= existing.length + plan.length;
  return { saved: plan.length, warnings, skipped, day, verified };
}

export async function editTask(userId, { taskId, date, remove, ...ch }) {
  if (!/^\d+$/.test(String(taskId))) throw new Error("taskId must be the numeric id shown after # in the task list");
  const id = String(taskId);

  if (remove) {
    // only entries that have a delete link in the user's own recent list can be removed
    let found = false;
    for (let p = 1; p <= 3 && !found; p++) {
      const r = await apiRequest(userId, "GET", `/Task?pageNumber=${p}`);
      found = (await parseHtml(await r.text(), parseTasks)).some((x) => x.id === id);
    }
    if (!found) throw new Error(`Task #${id} not found among your deletable (pending) tasks in the last few pages.`);
    const r = await apiRequest(userId, "GET", `/Task/Delete/${id}`);
    if (r.status() >= 400) throw new Error(`EMS refused the delete (HTTP ${r.status()})`);
    return `Deleted task #${id}.`;
  }

  if (!date) throw new Error("date is required to edit a task");
  const d = parseDate(date);
  const form = await loadForm(userId, d);
  const row = form.rows.find((r) => r.id === id);
  if (!row) throw new Error(`Task #${id} not found on ${iso(d)}.`);
  if (row.locked) throw new Error(`Task #${id} is locked (already approved) and cannot be edited.`);
  const set = {};
  if (ch.project) {
    const p = await resolveProject(userId, { project: ch.project });
    if (p.error) throw new Error(`${ch.project}: ${p.error}`);
    set.ProjectId = p.id; set.ProjectName = p.name;
  }
  if (ch.taskType) { const t = resolveTaskType(ch.taskType); const o = pick(form.types, t.label, t.raw); if (!o) throw new Error(`task type "${ch.taskType}" not found`); set.TaskTypeId = o.value; }
  if (ch.status) { const s = resolveStatus(ch.status); const o = pick(form.statuses, s.label, s.raw); if (!o) throw new Error(`status "${ch.status}" not found`); set.TaskStatus = o.value; }
  if (ch.description) set.Description = ch.description;
  if (ch.duration) set.Duration = normalizeDuration(ch.duration);
  if (ch.estimatedDuration) set.EstimatedTime = normalizeDuration(ch.estimatedDuration);
  if (!Object.keys(set).length) throw new Error("Nothing to change: give at least one field.");
  const fields = form.fields.map((f) => [...f]);
  setRow(fields, row.i, set);
  const res = await postForm(userId, d, { ...form, fields });
  if (!res.ok) throw new Error(`EMS rejected the edit (HTTP ${res.status}): ${res.errors.join("; ") || "no message"}`);
  const day = await dayAfter(userId, d);
  return `Updated task #${id}. ${iso(d)} now ${day.total}:\n${day.rows.map(rowLine).join("\n")}`;
}

export async function copyTasks(userId, fromDate, toDate, preview) {
  const from = parseDate(fromDate);
  const rows = (await getTasks(userId, from, from)).filter((r) => r.project);
  if (!rows.length) throw new Error(`No tasks found on ${iso(from)}.`);
  const tasks = rows.map((r) => ({ project: r.project, taskType: r.type, description: r.desc, duration: r.dur, estimatedDuration: r.est || r.dur, status: r.status }));
  return addTasks(userId, toDate || "today", tasks, preview);
}

// ---------------------------------------------------------------- templates
export async function template(userId, a) {
  const all = getTemplates(userId);
  if (a.action === "list")
    return Object.keys(all).length ? Object.entries(all).map(([n, t]) => `${n}: ${t.map((x) => `${x.project}|${x.taskType}|${x.duration}`).join("; ")}`).join("\n") : "No templates saved.";
  if (!a.name) throw new Error("name is required");
  if (a.action === "delete") return removeTemplate(userId, a.name) ? `Deleted template "${a.name}".` : `No template "${a.name}".`;
  if (a.action === "save") {
    let tasks = a.tasks;
    if (!tasks?.length && a.fromDate) {
      const d = parseDate(a.fromDate);
      tasks = (await getTasks(userId, d, d)).filter((r) => r.project)
        .map((r) => ({ project: r.project, taskType: r.type, description: r.desc, duration: r.dur, estimatedDuration: r.est || r.dur, status: r.status }));
    }
    if (!tasks?.length) throw new Error("give tasks[] or fromDate to build the template from");
    setTemplate(userId, a.name, tasks);
    return `Saved template "${a.name}" (${tasks.length} task${tasks.length > 1 ? "s" : ""}).`;
  }
  if (a.action === "apply") {
    if (!all[a.name]) throw new Error(`No template "${a.name}".`);
    return addTasks(userId, a.date || "today", all[a.name], a.preview);
  }
  throw new Error("action must be save, list, apply or delete");
}

// ---------------------------------------------------------------- attendance / bugs / projects
export async function attendance(userId, month) {
  const base = month && /^\d{4}-\d{2}$/.test(month) ? `${month}-01` : iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const r = await apiRequest(userId, "GET", `/Attendance/Register?monthDate=${base}&company=0`);
  const t = await parseHtml(await r.text(), parseTable, "User Name");
  if (!t || !t.rows.length) return `No attendance data for ${base.slice(0, 7)}.`;
  const c = t.rows[0].cells;
  const days = t.head.slice(1, -2), marks = c.slice(1, -2);
  const by = {};
  marks.forEach((m, i) => { if (m) (by[m] ||= []).push(days[i]); });
  const tp = c[c.length - 2], ta = c[c.length - 1];
  return [`${c[0]} ${base.slice(0, 7)}: present(TP)=${tp} absent(TA)=${ta}`,
    ...Object.entries(by).map(([m, d]) => `${m} (${d.length}): days ${d.join(",")}`),
    "Only the register's own codes are shown; hours worked are not on this page (use ems_task_report)."].join("\n");
}

const parseTracker = (d) => {
  const tx = (e) => (e ? e.textContent.replace(/\s+/g, " ").trim() : "");
  const body = tx(d.body);
  const g = (k) => { const m = new RegExp(k + "\\s*([0-9]{1,2}:[0-9]{2}(?: [AP]M)?)").exec(body); return m ? m[1] : ""; };
  const table = (h) => { const t = [...d.querySelectorAll("table")].find((x) => tx(x.querySelector("th")) === h); return t ? [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map(tx)) : []; };
  return { start: g("Start:"), end: g("End:"), total: g("Total Time:"), status: table("Status"), software: table("Software"), reasons: table("Time") };
};
const toMin12 = (s) => { const m = /^(\d+):(\d{2}) ([AP]M)$/.exec(s); return m ? ((+m[1] % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + +m[2] : null; };
const fmt12 = (n) => { n = ((n % 1440) + 1440) % 1440; const h = Math.floor(n / 60); return `${h % 12 || 12}:${pad(n % 60)} ${h >= 12 ? "PM" : "AM"}`; };

export async function tracker(userId, dateInput, targetHours = 9.5) {
  const date = parseDate(dateInput);
  const r = await apiRequest(userId, "POST", "/UserTracker", {
    data: new URLSearchParams({ startDate: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}` }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const t = await parseHtml(await r.text(), parseTracker);
  if (!t.total) return `${iso(date)}: no tracker data.`;
  const total = mins(t.total), target = Math.round(targetHours * 60);
  const st = t.status.map((x) => `${x[0]} ${x[1]}`).join(", ");
  const L = [`${iso(date)} tracker: start ${t.start}, end ${t.end}, total ${t.total} (${st})`];
  if (total >= target) L.push(`Target ${hhmm(target)} reached (+${hhmm(total - target)}).`);
  else {
    const left = target - total, end = toMin12(t.end);
    const isToday = iso(date) === iso(new Date());
    L.push(`Target ${hhmm(target)}: ${hhmm(left)} left${isToday && end != null ? ` -> reached at about ${fmt12(end + left)} if the tracker keeps running (total ≈ time since start)` : ""}.`);
  }
  const reasons = t.reasons.filter((x) => x[0] !== "Total Duration" && x.length >= 3);
  if (reasons.length) L.push(`Reasons (${t.reasons.find((x) => x[0] === "Total Duration")?.[1] || "?"}; not added to the total above, check whether they count): ${reasons.map((x) => `${x[1]} ${x[2]}`).join("; ")}`);
  L.push(`Top apps: ${t.software.filter((x) => x.length >= 2).sort((a, b) => mins(b[1]) - mins(a[1])).slice(0, 5).map((x) => `${x[0]} ${x[1]}`).join(", ")}`);
  return L.join("\n");
}

export async function bugs(userId, { status, keyword } = {}) {
  const r = await apiRequest(userId, "GET", "/ProjectBug");
  const t = await parseHtml(await r.text(), parseTable, "Assigned To");
  const rows = (t?.rows || []).filter((x) => x.cells.length > 3)
    .filter((x) => !status || x.cells[4].toLowerCase().includes(status.toLowerCase()))
    .filter((x) => !keyword || x.cells[3].toLowerCase().includes(keyword.toLowerCase()));
  if (!rows.length) return "No bugs found.";
  return rows.map((x) => `${x.cells[1]}|${x.cells[2]}|${x.cells[4]}|by ${x.cells[5]}→${x.cells[6]} ${short(x.cells[3], 120)} ${x.link || ""}`).join("\n");
}

export async function myProjects(userId, keyword) {
  const r = await apiRequest(userId, "GET", "/Project/MyProject");
  const t = await parseHtml(await r.text(), parseTable, "Proj. Name");
  const rows = (t?.rows || []).filter((x) => x.cells.length > 5 && (!keyword || x.cells[0].toLowerCase().includes(keyword.toLowerCase())));
  if (!rows.length) return "No projects found.";
  return rows.map((x) => `${x.first}|${x.cells[5]}|BDE ${x.cells[1]}|TL ${x.cells[2]}|PM ${x.cells[3]}|QA ${x.cells[4]}|last task ${x.cells[7]}|month ${x.cells[9] || ""}`).join("\n");
}
