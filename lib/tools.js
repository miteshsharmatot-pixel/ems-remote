import { z } from "zod";
import { TASK_TYPE_LABELS, fillTasks, submitTasks } from "./ems.js";
import { findProjects, dayTasks, addTasks, editTask, copyTasks, taskReport, template, attendance, tracker, bugs, myProjects } from "./fast.js";
import { getLeaveOptions, getMyLeaves, prepareLeave, submitLeave, discardLeave } from "./leave.js";
import { deleteUser } from "./db.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const withImage = (buf, t) => {
  const content = [{ type: "text", text: t }];
  if (buf) content.push({ type: "image", data: buf.toString("base64"), mimeType: "image/png" });
  return { content };
};
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });
const safe = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail(e); } };
const short = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const dayLine = (r) => `${r.project}|${r.type}|${r.dur}|${r.status}${r.id ? " #" + r.id : ""}${r.locked ? " (locked)" : ""} ${short(r.desc)}`;

const dateField = z.string().optional().describe("YYYY-MM-DD, MM/DD/YYYY, 'today' (default) or 'yesterday'.");

const taskSchema = z.object({
  project: z.string().describe("Project name, e.g. 'MyBuddy AI'"),
  projectId: z.string().optional().describe("Exact project id if known"),
  taskType: z.string().describe(`One of: ${TASK_TYPE_LABELS.join(", ")} (short names like dev, meeting, kt, bug, qa also work).`),
  description: z.string(),
  duration: z.string().describe("'02:00', '2h', '1h30m' or '1.5'"),
  estimatedDuration: z.string().optional().describe("Defaults to duration"),
  status: z.string().optional().describe("'completed' (default), 'pending' or 'in progress'"),
});

function formatAdd(r) {
  const L = [];
  if (r.preview) L.push("Preview (nothing saved):", ...r.preview);
  else if (r.saved) L.push(`Saved ${r.saved} task(s).${r.verified ? "" : " WARNING: could not confirm all rows in EMS - check the day list."}`);
  else L.push("Nothing saved.");
  if (r.issues?.length) L.push("Fix these and retry:", ...r.issues);
  if (r.skipped?.length) L.push("Skipped:", ...r.skipped);
  if (r.warnings?.length) L.push("Warnings:", ...r.warnings);
  if (r.day) L.push(`Day total ${r.day.total}:`, ...r.day.rows.map((x) => `${x.project}|${x.type}|${x.dur}|${x.status}${x.id ? " #" + x.id : ""} ${short(x.desc, 50)}`));
  return text(L.join("\n"));
}

// Old browser-driven path, only used if EMS changes its form so the fast path no longer recognises it.
async function addViaBrowser(userId, date, tasks) {
  const r = await fillTasks(userId, date, tasks);
  const lines = [`(fallback mode) Filled ${r.filled.length} row(s).`];
  if (r.skippedNoProject?.length) lines.push(`No project match: ${r.skippedNoProject.map((s) => `"${s.requestedProject}"`).join(", ")}`);
  if (r.warnings?.length) lines.push(...r.warnings.map((w) => `Warning (row ${w.row}): ${w.problem}`));
  if (!r.filled.length || r.skippedNoProject?.length || r.warnings?.length) return withImage(r.screenshot, lines.join("\n") + "\nNot submitted.");
  const s = await submitTasks(userId, date);
  lines.push(s.message ? `Submitted. EMS said: ${s.message}` : "Save clicked; no confirmation message shown.");
  return withImage(s.screenshot, lines.join("\n"));
}

/** Registers all tools, bound to the authenticated user (never taken from tool arguments). */
export function registerTools(server, userId) {
  server.registerTool("ems_search_projects", {
    title: "Search EMS projects",
    description: "Find exact EMS project names/ids.",
    inputSchema: { query: z.string() },
  }, safe(async ({ query }) => text((await findProjects(userId, query)).map((p) => `${p.id} ${p.name}`).join("\n") || "No match.")));

  server.registerTool("ems_get_day_tasks", {
    title: "Tasks entered for a date",
    description: "Rows already on the Add Tasks page for a date (with task ids).",
    inputSchema: { date: dateField },
  }, safe(async ({ date }) => {
    const r = await dayTasks(userId, date);
    return text(r.rows.length ? `${r.date}:\n${r.rows.map(dayLine).join("\n")}` : `${r.date}: no tasks entered.`);
  }));

  server.registerTool("ems_fill_tasks", {
    title: "Add tasks to EMS",
    description: "Adds tasks for a date and saves them immediately (no confirmation; do not call anything after). Existing rows and exact duplicates are left alone. Nothing is saved if a project is unmatched/ambiguous or a type/status is unknown. preview=true shows what would be saved.",
    inputSchema: { date: dateField, tasks: z.array(taskSchema).min(1).max(15), preview: z.boolean().optional() },
  }, safe(async ({ date, tasks, preview }) => {
    try { return formatAdd(await addTasks(userId, date, tasks, preview)); }
    catch (e) { if (String(e.message).startsWith("FAST_UNAVAILABLE")) return addViaBrowser(userId, date, tasks); throw e; }
  }));

  server.registerTool("ems_edit_task", {
    title: "Edit or delete a task",
    description: "Edit (give date + changed fields) or delete (delete=true) one task by its id (#id from ems_get_day_tasks / ems_task_report). Approved tasks are locked; only pending ones can be changed or deleted.",
    inputSchema: {
      taskId: z.string(), date: dateField.describe("Date of the task; required when editing"),
      delete: z.boolean().optional(),
      project: z.string().optional(), taskType: z.string().optional(), description: z.string().optional(),
      duration: z.string().optional(), estimatedDuration: z.string().optional(), status: z.string().optional(),
    },
  }, safe(async ({ delete: remove, ...a }) => text(await editTask(userId, { ...a, remove }))));

  server.registerTool("ems_copy_tasks", {
    title: "Copy tasks from one day to another",
    description: "Copies all tasks of fromDate (e.g. 'yesterday') to toDate (default today) and saves. Duplicates are skipped. preview=true to only show.",
    inputSchema: { fromDate: z.string(), toDate: dateField, preview: z.boolean().optional() },
  }, safe(async ({ fromDate, toDate, preview }) => formatAdd(await copyTasks(userId, fromDate, toDate, preview))));

  server.registerTool("ems_task_report", {
    title: "Task report",
    description: "view=list (tasks), missing (working days under minHours, skipping weekends/holidays) or projects (hours per project, per week). Default range: this month to today.",
    inputSchema: {
      view: z.enum(["list", "missing", "projects"]).optional(), from: dateField, to: dateField,
      minHours: z.number().optional().describe("For missing; default 8"),
    },
  }, safe(async (a) => text(await taskReport(userId, a))));

  server.registerTool("ems_template", {
    title: "Task templates",
    description: "Reusable task sets. save (name + tasks[] or fromDate to copy a day), list, apply (name + date; saves like ems_fill_tasks), delete.",
    inputSchema: {
      action: z.enum(["save", "list", "apply", "delete"]), name: z.string().optional(),
      tasks: z.array(taskSchema).optional(), fromDate: z.string().optional(), date: dateField, preview: z.boolean().optional(),
    },
  }, safe(async (a) => {
    const r = await template(userId, a);
    return typeof r === "string" ? text(r) : formatAdd(r);
  }));

  server.registerTool("ems_attendance", {
    title: "Attendance register",
    description: "My attendance for a month: present/absent days and totals. Not hours worked.",
    inputSchema: { month: z.string().optional().describe("YYYY-MM, default current month") },
  }, safe(async ({ month }) => text(await attendance(userId, month))));

  server.registerTool("ems_tracker", {
    title: "Time tracker",
    description: "Tracker for a day: start/end/total, active/idle/locked, reasons, top apps, and time left to reach the daily target (default 9:30) with the expected finish time.",
    inputSchema: { date: dateField, targetHours: z.number().optional().describe("Default 9.5") },
  }, safe(async ({ date, targetHours }) => text(await tracker(userId, date, targetHours))));

  server.registerTool("ems_bugs", {
    title: "Bugs",
    description: "Bugs from the Bugs page (date, project, status, creator -> assignee).",
    inputSchema: { status: z.string().optional(), keyword: z.string().optional() },
  }, safe(async (a) => text(await bugs(userId, a))));

  server.registerTool("ems_my_projects", {
    title: "My projects",
    description: "My projects with status, BDE/TL/PM/QA and last task date.",
    inputSchema: { keyword: z.string().optional() },
  }, safe(async ({ keyword }) => text(await myProjects(userId, keyword))));

  // ================= LEAVE =================
  server.registerTool("ems_get_leave_balance", {
    title: "Leave balance and recent leaves",
    description: "Reads the My Leaves page: remaining balances (Casual, Sick, Special), days already taken this year per leave type, how many requests are still undecided, and the recent leave requests (dates, half days, reason, status, manager/HR approval).",
    inputSchema: {
      year: z.number().int().optional().describe("Year for the 'days taken' totals (default: current year)"),
      status: z.string().optional().describe("Only list leaves whose status contains this text, e.g. 'Approved', 'Rejected', 'Pending'"),
      limit: z.number().int().min(1).max(50).optional().describe("How many leaves to list (default 15, newest first)"),
    },
  }, safe(async ({ year, status, limit }) => ({ content: [{ type: "text", text: JSON.stringify(await getMyLeaves(userId, { year, status, limit: limit ?? 15 }), null, 2) }] })));

  server.registerTool("ems_get_leave_options", {
    title: "Leave form options",
    description: "Lists the approvers and leave types available to this user on the Request Leave form (leave type labels include the remaining balance, e.g. 'Sick Leave(0.5)').",
    inputSchema: {},
  }, safe(async () => ({ content: [{ type: "text", text: JSON.stringify(await getLeaveOptions(userId), null, 2) }] })));

  server.registerTool("ems_prepare_leave", {
    title: "Create and submit a leave request",
    description: "Validates and fills the Request Leave form, then submits it automatically without asking for confirmation. Requires the user's specific reason (max 100 chars; EMS rejects 'Personal', 'Work at home' etc.) and 10-digit contact number; never invent missing details. Reports validation errors without submitting.",
    inputSchema: {
      startDate: z.string().describe("Leave start date, YYYY-MM-DD"),
      endDate: z.string().optional().describe("Leave end date, YYYY-MM-DD (defaults to start date)"),
      halfDayOnStart: z.boolean().optional().describe("Half day on the start date"),
      halfDayOnEnd: z.boolean().optional().describe("Half day on the end date"),
      leaveType: z.string().describe("Leave type, e.g. 'Casual Leave', 'Sick Leave', 'LWP' (see ems_get_leave_options)"),
      approver: z.string().describe("Approver name as shown in the dropdown, e.g. 'Sunny Marthak'"),
      reason: z.string().describe("Specific reason, max 100 characters"),
      contactNumber: z.string().describe("10-digit contact number during leave"),
    },
  }, safe(async (a) => {
    const r = await prepareLeave(userId, a);
    const s = r.summary;
    const submitted = await submitLeave(userId);
    if (!submitted.saved) {
      return withImage(submitted.screenshot,
        `Leave request was not submitted because EMS reported errors:\n- ${submitted.errors.join("\n- ")}\n` +
        `Request details: ${s.from} to ${s.to}, ${s.leaveType}, approver ${s.approver}.`);
    }
    return withImage(submitted.screenshot,
      `Leave request submitted to the approver.\nFrom: ${s.from}\nTo: ${s.to}\nType: ${s.leaveType}\nApprover: ${s.approver}` +
      `${submitted.message ? `\nPage response: ${submitted.message}` : "\nEMS showed no explicit confirmation message; verify the request in My Leaves."}`);
  }));

  server.registerTool("ems_submit_leave", {
    title: "Submit the prepared leave request to the approver",
    description: "Legacy helper to submit an already prepared leave request. Normal ems_prepare_leave calls submit automatically; do not call this after it.",
    inputSchema: {},
  }, safe(async () => {
    const r = await submitLeave(userId);
    if (!r.saved) return withImage(r.screenshot, `NOT saved - the form reported errors:\n- ${r.errors.join("\n- ")}\nThe form is still open; fix the problem by calling ems_prepare_leave again.`);
    return withImage(r.screenshot, `Leave request submitted to the approver.${r.message ? " Page said: " + r.message : ""}\nFinal page: ${r.finalUrl}\nVerify with ems_get_leave_balance.`);
  }));

  server.registerTool("ems_discard_leave", {
    title: "Discard the unsaved leave form",
    description: "Closes the prepared leave form without sending anything.",
    inputSchema: {},
  }, safe(async () => { await discardLeave(userId); return { content: [{ type: "text", text: "Discarded. Nothing was sent." }] }; }));

  server.registerTool("ems_forget_me", {
    title: "Delete my stored EMS credentials",
    description: "Permanently deletes this user's stored EMS credentials, saved session and access tokens from the server. They will need to reconnect the connector to use it again.",
    inputSchema: {},
  }, safe(async () => { deleteUser(userId); return { content: [{ type: "text", text: "Your stored EMS credentials and session were deleted. Reconnect the connector to use it again." }] }; }));
}
