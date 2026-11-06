import { getAuthenticatedPage, withJob } from "./browser.js";

// Task types as shown in the EMS dropdown (matched by visible TEXT in the page, so ids don't matter).
export const TASK_TYPE_LABELS = [
  "Administrative", "Bug Fix", "Communication/Meeting", "Data Migration/DB Updates",
  "Development", "Knowledge Transfer (KT)", "Requirement Analysis", "RnD", "Testing",
];
const TASK_TYPE_ID_ALIASES = {
  "8": "Administrative",
  "4": "Bug Fix",
  "1": "Communication/Meeting",
  "6": "Data Migration/DB Updates",
  "3": "Development",
  "137": "Knowledge Transfer (KT)",
  "2": "Requirement Analysis",
  "5": "RnD",
  "7": "Testing",
};
const TASK_TYPE_ALIASES = {
  development: "Development", dev: "Development", coding: "Development", feature: "Development", implementation: "Development",
  "bug fix": "Bug Fix", bug: "Bug Fix", bugfix: "Bug Fix", fix: "Bug Fix", defect: "Bug Fix", "bug fixing": "Bug Fix",
  meeting: "Communication/Meeting", "communication/meeting": "Communication/Meeting", communication: "Communication/Meeting",
  standup: "Communication/Meeting", call: "Communication/Meeting", demo: "Communication/Meeting", interview: "Communication/Meeting",
  rnd: "RnD", "r&d": "RnD", research: "RnD", learning: "RnD",
  kt: "Knowledge Transfer (KT)", "knowledge transfer": "Knowledge Transfer (KT)", training: "Knowledge Transfer (KT)",
  mentoring: "Knowledge Transfer (KT)", "code review": "Knowledge Transfer (KT)",
  admin: "Administrative", administrative: "Administrative", planning: "Administrative", reports: "Administrative",
  testing: "Testing", test: "Testing", qa: "Testing", "test cases": "Testing",
  "requirement analysis": "Requirement Analysis", requirements: "Requirement Analysis", requirement: "Requirement Analysis",
  analysis: "Requirement Analysis", estimation: "Requirement Analysis", brd: "Requirement Analysis",
  "data migration": "Data Migration/DB Updates", migration: "Data Migration/DB Updates", database: "Data Migration/DB Updates",
  db: "Data Migration/DB Updates", "db updates": "Data Migration/DB Updates",
};
/** Returns { label, raw, guessed } - label is matched against the dropdown's visible text inside the page. */
export function resolveTaskType(input) {
  const raw = input == null ? "" : String(input).trim();
  const low = raw.toLowerCase();
  const exact = TASK_TYPE_LABELS.find((l) => l.toLowerCase() === low);
  if (exact) return { label: exact, raw, guessed: false };
  if (TASK_TYPE_ID_ALIASES[raw]) return { label: TASK_TYPE_ID_ALIASES[raw], raw, guessed: false };
  if (TASK_TYPE_ALIASES[low]) return { label: TASK_TYPE_ALIASES[low], raw, guessed: false };
  const partial = TASK_TYPE_LABELS.find((l) => low && l.toLowerCase().includes(low));
  if (partial) return { label: partial, raw, guessed: false };
  return { label: /^\d+$/.test(raw) ? "" : "Development", raw, guessed: !/^\d+$/.test(raw) };
}

const STATUS_ALIASES = {
  completed: "Completed", complete: "Completed", done: "Completed", finished: "Completed",
  pending: "Pending", "in progress": "In Progress", inprogress: "In Progress", wip: "In Progress",
};
export function resolveStatus(input) {
  const raw = input == null || input === "" ? "completed" : String(input).trim();
  return { label: STATUS_ALIASES[raw.toLowerCase()] || raw, raw };
}

const pad = (n) => String(n).padStart(2, "0");
export function normalizeDuration(input) {
  if (input == null || input === "") return "00:00";
  const raw = String(input).trim().toLowerCase();
  let m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return `${pad(m[1])}:${m[2]}`;
  m = raw.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(\d+)?\s*m?(?:in)?$/);
  if (m) {
    const whole = Math.floor(parseFloat(m[1]));
    const total = Math.round((parseFloat(m[1]) - whole) * 60) + (m[2] ? parseInt(m[2], 10) : 0);
    return `${pad(whole + Math.floor(total / 60))}:${pad(total % 60)}`;
  }
  m = raw.match(/^(\d+)\s*m(?:in(?:utes?)?)?$/);
  if (m) { const t = parseInt(m[1], 10); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; }
  m = raw.match(/^(\d+(?:\.\d+)?)$/);
  if (m) { const t = Math.round(parseFloat(m[1]) * 60); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; }
  return "00:00";
}

export function toSelectedDateParam(dateInput) {
  let d;
  if (dateInput == null || dateInput === "" || dateInput === "today") d = new Date();
  else if (/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) { const [y, mo, da] = dateInput.split("-").map(Number); d = new Date(y, mo - 1, da); }
  else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateInput)) { const [mo, da, y] = dateInput.split("/").map(Number); d = new Date(y, mo - 1, da); }
  else d = new Date(dateInput);
  if (isNaN(d.getTime())) throw new Error(`Could not parse date: ${dateInput}`);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} 00:00:00`;
}
export const addEditUrl = (dateInput) => `/Task/AddEdit?selectedDate=${encodeURIComponent(toSelectedDateParam(dateInput))}`;

async function fetchProjects(page, term) {
  return page.evaluate(async (t) => {
    const res = await fetch(`/Task/Projects?term=${encodeURIComponent(t || "")}&_=${Date.now()}`, {
      credentials: "include",
      headers: { Accept: "application/json, text/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) throw new Error(`Project search failed: ${res.status}`);
    const data = await res.json();
    return data.map((p) => ({ id: String(p.id ?? p.value ?? p.ProjectId ?? ""), name: p.label ?? p.name ?? p.text ?? p.ProjectName ?? "" }));
  }, term);
}

// ---- browser fallback (used only if the fast HTTP path in fast.js can't read the form) ----
const openPages = new Map(); // `${userId}|${date}` -> { page, timer }
const OPEN_TTL_MS = 30 * 60 * 1000;
const keyOf = (userId, d) => `${userId}|${toSelectedDateParam(d)}`;

function track(key, page) {
  const old = openPages.get(key);
  if (old) clearTimeout(old.timer);
  const timer = setTimeout(() => { page.close().catch(() => {}); openPages.delete(key); }, OPEN_TTL_MS);
  timer.unref();
  openPages.set(key, { page, timer });
}
function release(key) {
  const e = openPages.get(key);
  if (e) { clearTimeout(e.timer); openPages.delete(key); }
}

export const fillTasks = (userId, dateInput, tasks) =>
  withJob(async () => {
    const key = keyOf(userId, dateInput);
    let page = openPages.get(key)?.page;
    if (!page || page.isClosed()) {
      page = await getAuthenticatedPage(userId);
      await page.goto(addEditUrl(dateInput), { waitUntil: "domcontentloaded" });
    }
    track(key, page);

    const resolved = [];
    for (const t of tasks) {
      let project = null;
      if (t.projectId) project = { id: String(t.projectId), name: t.project || "" };
      else if (t.project) {
        const results = await fetchProjects(page, t.project);
        project = results.find((r) => r.name.toLowerCase() === t.project.toLowerCase()) || results[0] || null;
      }
      resolved.push({
        duration: normalizeDuration(t.duration),
        estimatedDuration: normalizeDuration(t.estimatedDuration ?? t.duration),
        description: t.description || "Work completed as planned",
        taskType: resolveTaskType(t.taskType),
        status: resolveStatus(t.status),
        projectId: project?.id || null,
        projectName: project?.name || null,
        requestedProject: t.project || null,
      });
    }

    const result = await page.evaluate((tasksToFill) => {
      const existing = [];
      for (let i = 0; i < 15; i++) {
        const d = document.querySelector(`#Tasks_${i}__Duration`);
        const t = document.querySelector(`#Tasks_${i}__Description`);
        const p = document.querySelector(`#Tasks_${i}__ProjectName`);
        if (d && t && d.value && d.value !== "00:00" && (t.value.trim() || (p && p.value.trim()))) existing.push(i);
      }
      const filled = [], skippedNoProject = [], warnings = [];
      let ti = 0;
      for (let r = 0; r < 15 && ti < tasksToFill.length; r++) {
        if (existing.includes(r)) continue;
        const task = tasksToFill[ti++];
        if (!task.projectId || !task.projectName) { skippedNoProject.push({ row: r, requestedProject: task.requestedProject }); continue; }
        const set = (n, v) => { const el = document.querySelector(`#Tasks_${r}__${n}`); if (el) el.value = v; };
        set("EstimatedTime", task.estimatedDuration);
        set("Duration", task.duration);
        const pick = (name, label, raw) => {
          const sel = document.querySelector(`#Tasks_${r}__${name}`);
          if (!sel) return false;
          const opts = [...sel.options];
          const l = (label || "").toLowerCase();
          const hit = opts.find((o) => o.text.trim().toLowerCase() === l) ||
                      opts.find((o) => o.value === raw) ||
                      (l && opts.find((o) => o.text.trim().toLowerCase().includes(l)));
          if (!hit) return false;
          sel.value = hit.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        if (!pick("TaskTypeId", task.taskType.label, task.taskType.raw)) warnings.push({ row: r, problem: `Task type "${task.taskType.raw}" not found in dropdown` });
        else if (task.taskType.guessed) warnings.push({ row: r, problem: `Task type "${task.taskType.raw}" not recognised - used "${task.taskType.label}"` });
        if (!pick("TaskStatus", task.status.label, task.status.raw)) warnings.push({ row: r, problem: `Status "${task.status.raw}" not found in dropdown` });
        set("Description", task.description);
        set("ProjectName", task.projectName);
        set("ProjectId", task.projectId);
        filled.push({ row: r, project: task.projectName, duration: task.duration });
      }
      return { filled, skippedExistingRows: existing, skippedNoProject, warnings };
    }, resolved);

    return { ...result, screenshot: await page.screenshot({ fullPage: true }) };
  });

export const submitTasks = (userId, dateInput) =>
  withJob(async () => {
    const key = keyOf(userId, dateInput);
    const page = openPages.get(key)?.page;
    if (!page || page.isClosed()) {
      throw new Error("No filled-but-unsubmitted form for that date (it may have expired after 30 min). Call ems_fill_tasks again, then ems_submit.");
    }
    await page.locator("button:has-text('Save'), button:has-text('Submit'), input[type='submit'], button[type='submit']").first().click();
    await page.waitForTimeout(1500);
    const message = await page
      .locator(".toast-message, .alert-success, .alert-danger, .validation-summary-errors")
      .first().innerText().catch(() => null);
    const screenshot = await page.screenshot({ fullPage: true });
    release(key);
    await page.close().catch(() => {});
    return { message: message?.trim() || null, screenshot };
  });
