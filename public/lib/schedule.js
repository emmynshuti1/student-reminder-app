// Scheduling engine shared by the browser (window.Schedule) and the server /
// tests (require). Pure functions only — no DOM, no network.
//
// Times are stored as local wall-clock values ("2026-11-03" + "09:00") and are
// interpreted in the device's time zone. Recurrence is computed on calendar
// dates rather than by adding milliseconds, so a 09:00 weekly class stays at
// 09:00 across daylight-saving changes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Schedule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORIES = ['Assignment', 'Exam', 'Project', 'Class', 'Study', 'Personal', 'Other'];
  const PRIORITIES = ['High', 'Medium', 'Low'];
  const RECURRENCES = ['none', 'daily', 'weekdays', 'weekly', 'monthly', 'interval'];
  // Categories that represent something you have to finish before a moment.
  const DEADLINE_CATEGORIES = ['Assignment', 'Exam', 'Project'];
  // Default effort (minutes) used by the planner when no estimate is given.
  const DEFAULT_EFFORT = { Exam: 240, Project: 300, Assignment: 120 };
  const DEFAULT_STUDY_PREFS = {
    weekdayStart: '16:00',
    weekdayEnd: '21:00',
    weekendStart: '10:00',
    weekendEnd: '18:00',
    sessionMinutes: 60,
    maxMinutesPerDay: 180,
    breakMinutes: 15,
    studyDays: [0, 1, 2, 3, 4, 5, 6]
  };

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  // ---------- date-only helpers (Y-M-D strings, timezone independent) ----------

  function isValidDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function isValidTime(s) {
    return typeof s === 'string' && TIME_RE.test(s);
  }

  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function fmtYmd(utcMs) {
    const d = new Date(utcMs);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function addDays(ymdStr, n) {
    return fmtYmd(parseYmd(ymdStr) + n * 86400000);
  }

  function dayDiff(a, b) {
    return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  }

  function weekday(ymdStr) {
    return new Date(parseYmd(ymdStr)).getUTCDay();
  }

  function addMonthsClamped(ymdStr, n, dayOfMonth) {
    const [y, m] = ymdStr.split('-').map(Number);
    const total = (m - 1) + n;
    const ny = y + Math.floor(total / 12);
    const nm = ((total % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return `${ny}-${pad(nm + 1)}-${pad(Math.min(dayOfMonth, lastDay))}`;
  }

  // Local-time helpers (device time zone).
  function ymd(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function hm(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function toDate(dateStr, timeStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = String(timeStr || '00:00').slice(0, 5).split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  }

  function fmtDate(date) {
    return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function fmtTime(date) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function minutesOf(timeStr) {
    const [h, m] = String(timeStr).slice(0, 5).split(':').map(Number);
    return h * 60 + m;
  }

  function timeOf(minutes) {
    return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  }

  // ---------- reminders ----------

  function parseDays(value) {
    if (Array.isArray(value)) return value.map(Number).filter((n) => n >= 0 && n <= 6);
    if (!value) return [];
    return String(value).split(',').filter((x) => x !== '').map(Number).filter((n) => n >= 0 && n <= 6);
  }

  function isRecurring(r) {
    return !!r.recurrence && r.recurrence !== 'none';
  }

  // Classes are timetable entries: they are never "done" or overdue.
  function isCompletable(r) {
    return r.category !== 'Class';
  }

  function isDeadline(r) {
    return DEADLINE_CATEGORIES.includes(r.category);
  }

  function isOverdue(r, now) {
    if (r.status !== 'Pending' || !isCompletable(r)) return false;
    return toDate(r.due_date, r.due_time) < (now || new Date());
  }

  // Expand a reminder into concrete dates between fromYmd and toYmd inclusive.
  function occurrenceDates(r, fromYmd, toYmd) {
    const anchor = r.due_date;
    const until = r.recur_until && isValidDate(r.recur_until) ? r.recur_until : null;
    const end = until && until < toYmd ? until : toYmd;
    const out = [];
    if (!isRecurring(r)) {
      if (anchor >= fromYmd && anchor <= toYmd) out.push(anchor);
      return out;
    }
    if (end < anchor) return out;
    const interval = Math.max(1, Number(r.recur_interval) || 1);
    const start = fromYmd > anchor ? fromYmd : anchor;
    const LIMIT = 2000;

    if (r.recurrence === 'daily' || r.recurrence === 'interval') {
      const step = interval;
      const offset = dayDiff(anchor, start);
      let k = Math.ceil(offset / step);
      for (let i = 0; i < LIMIT; i++, k++) {
        const d = addDays(anchor, k * step);
        if (d > end) break;
        out.push(d);
      }
    } else if (r.recurrence === 'weekdays') {
      let d = start;
      for (let i = 0; i < LIMIT && d <= end; i++, d = addDays(d, 1)) {
        const wd = weekday(d);
        if (wd >= 1 && wd <= 5) out.push(d);
      }
    } else if (r.recurrence === 'weekly') {
      let days = parseDays(r.recur_days);
      if (!days.length) days = [weekday(anchor)];
      const anchorWeekStart = addDays(anchor, -weekday(anchor));
      let d = start;
      for (let i = 0; i < LIMIT && d <= end; i++, d = addDays(d, 1)) {
        if (!days.includes(weekday(d))) continue;
        const weekIndex = Math.floor(dayDiff(anchorWeekStart, d) / 7);
        if (weekIndex % interval === 0) out.push(d);
      }
    } else if (r.recurrence === 'monthly') {
      const dom = Number(anchor.slice(8, 10));
      for (let k = 0; k < LIMIT; k += interval) {
        const d = addMonthsClamped(anchor, k, dom);
        if (d > end) break;
        if (d >= start) out.push(d);
      }
    }
    return out;
  }

  function occurrences(r, fromYmd, toYmd) {
    const duration = Math.max(0, Number(r.duration_minutes) || 0);
    return occurrenceDates(r, fromYmd, toYmd).map((date) => {
      const start = toDate(date, r.due_time);
      return {
        key: `${r.id}@${date}T${String(r.due_time).slice(0, 5)}`,
        reminder: r,
        date,
        time: String(r.due_time).slice(0, 5),
        start,
        end: new Date(start.getTime() + duration * 60000),
        duration
      };
    });
  }

  function expandAll(reminders, fromYmd, toYmd, opts) {
    const includeCompleted = opts && opts.includeCompleted;
    const all = [];
    for (const r of reminders) {
      if (!includeCompleted && r.status === 'Completed') continue;
      all.push(...occurrences(r, fromYmd, toYmd));
    }
    return all.sort((a, b) => a.start - b.start);
  }

  // The occurrence a recurring task moves to once the current one is done.
  function nextOccurrence(r) {
    if (!isRecurring(r)) return null;
    const from = addDays(r.due_date, 1);
    const dates = occurrenceDates(r, from, addDays(from, 800));
    return dates.length ? dates[0] : null;
  }

  // ---------- intelligence ----------

  function hoursUntil(r, now) {
    return (toDate(r.due_date, r.due_time) - now) / 3600000;
  }

  // Higher score = needs attention sooner. Simple, explainable weights.
  function urgency(r, now) {
    now = now || new Date();
    if (r.status === 'Completed' || !isCompletable(r)) return { score: 0, level: 'none', label: '' };
    const h = hoursUntil(r, now);
    let score = { High: 30, Medium: 20, Low: 10 }[r.priority] || 20;
    score += { Exam: 15, Project: 8, Assignment: 5 }[r.category] || 0;
    let label;
    if (h < 0) { score += 60; label = 'Overdue'; }
    else if (h <= 24) { score += 40; label = h < 1 ? `Due in ${Math.max(1, Math.round(h * 60))} min` : `Due in ${Math.round(h)} h`; }
    else if (h <= 72) { score += 25; label = `Due in ${Math.ceil(h / 24)} days`; }
    else if (h <= 168) { score += 10; label = `Due in ${Math.ceil(h / 24)} days`; }
    else label = `Due in ${Math.ceil(h / 24)} days`;
    const level = score >= 80 ? 'critical' : score >= 55 ? 'high' : 'normal';
    return { score, level, label };
  }

  // Overlapping time blocks (items that have a duration).
  function findConflicts(occs) {
    const blocks = occs.filter((o) => o.duration > 0).sort((a, b) => a.start - b.start);
    const conflicts = [];
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[j].start >= blocks[i].end) break;
        if (blocks[i].reminder.id === blocks[j].reminder.id) continue;
        conflicts.push([blocks[i], blocks[j]]);
      }
    }
    return conflicts;
  }

  // Conflicts a proposed (unsaved) reminder would create, for form warnings.
  function conflictsFor(candidate, reminders, now) {
    if (!(Number(candidate.duration_minutes) > 0) || !isValidDate(candidate.due_date) || !isValidTime(candidate.due_time)) return [];
    const from = candidate.due_date;
    const to = isRecurring(candidate) ? addDays(from, 90) : from;
    const mine = occurrences(Object.assign({}, candidate, { id: '__candidate' }), from, to);
    const others = expandAll(reminders.filter((r) => String(r.id) !== String(candidate.id)), from, to);
    const hits = [];
    const seen = new Set();
    for (const a of mine) {
      for (const b of others) {
        if (b.duration > 0 && a.start < b.end && b.start < a.end && !seen.has(b.reminder.id)) {
          seen.add(b.reminder.id);
          hits.push({ mine: a, other: b });
        }
      }
    }
    return hits;
  }

  function effortFor(r) {
    const est = Number(r.est_minutes) || 0;
    if (est > 0) return { minutes: est, estimated: false };
    return { minutes: DEFAULT_EFFORT[r.category] || 60, estimated: true };
  }

  // Minutes of study already scheduled for each deadline (linked sessions).
  function plannedMinutesByTask(reminders) {
    const map = {};
    for (const r of reminders) {
      if (r.category === 'Study' && r.linked_id) {
        map[r.linked_id] = (map[r.linked_id] || 0) + (Number(r.duration_minutes) || 0);
      }
    }
    return map;
  }

  function insights(reminders, now) {
    now = now || new Date();
    const today = ymd(now);
    const horizon = addDays(today, 14);
    const occs = expandAll(reminders, today, horizon);
    const out = [];

    const overdue = reminders.filter((r) => isOverdue(r, now));
    if (overdue.length) {
      out.push({
        type: 'overdue', severity: 'critical',
        title: `${overdue.length} overdue ${overdue.length === 1 ? 'item' : 'items'}`,
        detail: 'Finish them, or reschedule to a realistic time so your plan stays accurate.',
        ids: overdue.map((r) => r.id)
      });
    }

    // One insight per clashing pair, even when a weekly clash repeats.
    const clashes = new Map();
    for (const [a, b] of findConflicts(occs.filter((o) => o.end > now))) {
      const pair = [a.reminder.id, b.reminder.id].sort().join('|');
      if (clashes.has(pair)) { clashes.get(pair).count++; continue; }
      clashes.set(pair, { a, b, count: 1 });
    }
    for (const { a, b, count } of clashes.values()) {
      out.push({
        type: 'conflict', severity: 'high',
        title: `Clash: ${a.reminder.title} ↔ ${b.reminder.title}`,
        detail: `${fmtDate(a.start)}, ${fmtTime(a.start)}–${fmtTime(a.end)} overlaps ${fmtTime(b.start)}–${fmtTime(b.end)}` +
          (count > 1 ? ` (and ${count - 1} more time${count > 2 ? 's' : ''} in the next 2 weeks).` : '.'),
        ids: [a.reminder.id, b.reminder.id]
      });
    }

    const planned = plannedMinutesByTask(reminders);
    for (const r of reminders) {
      if (r.status !== 'Pending' || !isDeadline(r) || isOverdue(r, now)) continue;
      const days = dayDiff(today, r.due_date);
      if (r.category === 'Exam' && days <= 7 && !planned[r.id]) {
        out.push({
          type: 'prep', severity: days <= 3 ? 'high' : 'normal',
          title: `${r.title} is in ${days === 0 ? 'less than a day' : days + (days === 1 ? ' day' : ' days')}`,
          detail: 'No study sessions are scheduled for it yet. The Planner can suggest some.',
          ids: [r.id], action: 'planner'
        });
      } else if (r.priority === 'High' && hoursUntil(r, now) <= 48) {
        out.push({
          type: 'urgent', severity: 'high',
          title: `${r.title} is due ${hoursUntil(r, now) <= 24 ? 'within 24 hours' : 'within 2 days'}`,
          detail: 'High priority — consider working on it next.',
          ids: [r.id]
        });
      }
    }

    const perDay = {};
    for (const o of occs) {
      if (isDeadline(o.reminder)) (perDay[o.date] = perDay[o.date] || []).push(o);
    }
    for (const [date, list] of Object.entries(perDay)) {
      if (list.length >= 3) {
        out.push({
          type: 'heavy', severity: 'normal',
          title: `Heavy day: ${list.length} deadlines on ${fmtDate(toDate(date, '12:00'))}`,
          detail: 'Start some of these earlier to spread the load.',
          ids: list.map((o) => o.reminder.id), action: 'planner'
        });
      }
    }

    const rank = { critical: 0, high: 1, normal: 2 };
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  }

  // ---------- study planner ----------

  // Suggest study sessions for upcoming deadlines inside the student's free
  // time. Earliest deadline first; at most one session per task per day so the
  // work is spread out instead of crammed into the last evening.
  function planStudy(reminders, prefs, now, horizonDays) {
    prefs = Object.assign({}, DEFAULT_STUDY_PREFS, prefs || {});
    now = now || new Date();
    horizonDays = horizonDays || 14;
    const today = ymd(now);
    const lastDay = addDays(today, horizonDays);
    const session = Math.max(15, Number(prefs.sessionMinutes) || 60);
    const gap = Math.max(0, Number(prefs.breakMinutes) || 0);
    const maxPerDay = Math.max(session, Number(prefs.maxMinutesPerDay) || 180);
    const studyDays = parseDays(prefs.studyDays);

    const planned = plannedMinutesByTask(reminders);
    const tasks = reminders
      .filter((r) => r.status === 'Pending' && isDeadline(r) && !isOverdue(r, now) && r.due_date <= lastDay)
      .map((r) => {
        const effort = effortFor(r);
        return {
          reminder: r,
          due: toDate(r.due_date, r.due_time),
          effort: effort.minutes,
          estimated: effort.estimated,
          planned: planned[r.id] || 0,
          remaining: Math.max(0, effort.minutes - (planned[r.id] || 0)),
          sessions: []
        };
      })
      .sort((a, b) => a.due - b.due || PRIORITIES.indexOf(a.reminder.priority) - PRIORITIES.indexOf(b.reminder.priority));

    // Busy time = every timed block (classes, existing study sessions, exams…).
    const busy = expandAll(reminders, today, lastDay).filter((o) => o.duration > 0);

    const days = [];
    for (let d = today; d <= lastDay; d = addDays(d, 1)) {
      const wd = weekday(d);
      if (!studyDays.includes(wd)) continue;
      const weekend = wd === 0 || wd === 6;
      let startMin = minutesOf(weekend ? prefs.weekendStart : prefs.weekdayStart);
      const endMin = minutesOf(weekend ? prefs.weekendEnd : prefs.weekdayEnd);
      if (d === today) {
        const nowMin = now.getHours() * 60 + now.getMinutes();
        startMin = Math.max(startMin, Math.ceil((nowMin + 10) / 15) * 15);
      }
      if (endMin - startMin < session) continue;
      const blocks = busy
        .filter((o) => o.date === d || (o.start < toDate(d, '23:59') && o.end > toDate(d, '00:00')))
        .map((o) => [
          Math.max(0, (o.start - toDate(d, '00:00')) / 60000 - gap),
          Math.min(24 * 60, (o.end - toDate(d, '00:00')) / 60000 + gap)
        ]);
      days.push({ date: d, startMin, endMin, used: 0, blocks });
    }

    function findSlot(day, deadline) {
      for (let t = day.startMin; t + session <= day.endMin; t += 15) {
        const s = t, e = t + session;
        if (toDate(day.date, timeOf(s)).getTime() + session * 60000 > deadline.getTime()) return null;
        if (day.blocks.some(([bs, be]) => s < be && bs < e)) continue;
        return s;
      }
      return null;
    }

    const suggestions = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const day of days) {
        for (const task of tasks) {
          if (task.remaining <= 0) continue;
          if (day.used + session > maxPerDay) break;
          if (task.sessions.some((s) => s.date === day.date)) continue;
          const slot = findSlot(day, task.due);
          if (slot === null) continue;
          const len = Math.min(session, Math.max(task.remaining, 30));
          const s = { taskId: task.reminder.id, title: `Study: ${task.reminder.title}`, subject: task.reminder.subject || '', date: day.date, time: timeOf(slot), duration: len };
          task.sessions.push(s);
          suggestions.push(s);
          task.remaining -= len;
          day.used += len;
          day.blocks.push([slot - gap, slot + len + gap]);
          progress = true;
        }
      }
    }

    suggestions.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const summary = tasks.map((t) => ({
      id: t.reminder.id,
      title: t.reminder.title,
      category: t.reminder.category,
      subject: t.reminder.subject,
      due: t.due,
      effort: t.effort,
      estimated: t.estimated,
      alreadyPlanned: t.planned,
      newlyPlanned: t.sessions.reduce((s, x) => s + x.duration, 0),
      shortfall: t.remaining
    }));
    return { sessions: suggestions, tasks: summary };
  }

  // ---------- notifications ----------

  // Notification moments for pending items: start - remind_before. Returns
  // events whose fire time is within [now - lookbackMs, now].
  function dueNotifications(reminders, now, lookbackMs) {
    now = now || new Date();
    lookbackMs = lookbackMs || 24 * 3600000;
    const from = ymd(new Date(now.getTime() - lookbackMs));
    const to = addDays(ymd(now), 8);
    const events = [];
    for (const o of expandAll(reminders, from, to)) {
      const r = o.reminder;
      const lead = Math.max(0, Number(r.remind_before) || 0);
      if (r.remind_before === null || r.remind_before === -1) continue;
      let fireAt = new Date(o.start.getTime() - lead * 60000);
      if (r.created_at) {
        const created = new Date(r.created_at);
        // Never alert about moments that had already passed when the item was
        // created; if only the lead time had passed, alert right away instead.
        if (o.start < created) continue;
        if (fireAt < created) fireAt = created;
      }
      if (fireAt > now || now - fireAt > lookbackMs) continue;
      events.push({ key: `${o.key}#${lead}`, occurrence: o, fireAt, lead });
    }
    return events;
  }

  return {
    CATEGORIES, PRIORITIES, RECURRENCES, DEADLINE_CATEGORIES, DEFAULT_STUDY_PREFS,
    isValidDate, isValidTime, addDays, dayDiff, weekday, ymd, hm, toDate, minutesOf, timeOf, parseDays,
    isRecurring, isCompletable, isDeadline, isOverdue,
    occurrenceDates, occurrences, expandAll, nextOccurrence,
    urgency, findConflicts, conflictsFor, insights, effortFor, plannedMinutesByTask, planStudy,
    dueNotifications
  };
});
