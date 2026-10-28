const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/lib/schedule.js');

const base = { id: 1, status: 'Pending', priority: 'Medium', category: 'Assignment', due_time: '09:00', duration_minutes: 0, remind_before: 15 };
const r = (over) => Object.assign({}, base, over);

test('date validation rejects impossible dates and times', () => {
  assert.equal(S.isValidDate('2026-02-29'), false);
  assert.equal(S.isValidDate('2028-02-29'), true);
  assert.equal(S.isValidDate('2026-13-01'), false);
  assert.equal(S.isValidTime('24:00'), false);
  assert.equal(S.isValidTime('23:59'), true);
});

test('non-recurring reminder occurs once', () => {
  assert.deepEqual(S.occurrenceDates(r({ due_date: '2026-11-03' }), '2026-11-01', '2026-11-30'), ['2026-11-03']);
  assert.deepEqual(S.occurrenceDates(r({ due_date: '2026-12-03' }), '2026-11-01', '2026-11-30'), []);
});

test('daily and every-N-days recurrence', () => {
  const daily = r({ due_date: '2026-11-01', recurrence: 'daily' });
  assert.deepEqual(S.occurrenceDates(daily, '2026-11-05', '2026-11-07'), ['2026-11-05', '2026-11-06', '2026-11-07']);
  const every3 = r({ due_date: '2026-11-01', recurrence: 'interval', recur_interval: 3 });
  assert.deepEqual(S.occurrenceDates(every3, '2026-11-02', '2026-11-12'), ['2026-11-04', '2026-11-07', '2026-11-10']);
});

test('weekly recurrence on chosen days, every 2 weeks, with end date', () => {
  // 2026-11-02 is a Monday.
  const mwf = r({ due_date: '2026-11-02', recurrence: 'weekly', recur_days: '1,3,5' });
  assert.deepEqual(S.occurrenceDates(mwf, '2026-11-01', '2026-11-08'), ['2026-11-02', '2026-11-04', '2026-11-06']);
  const fortnightly = r({ due_date: '2026-11-02', recurrence: 'weekly', recur_days: '1', recur_interval: 2 });
  assert.deepEqual(S.occurrenceDates(fortnightly, '2026-11-01', '2026-11-30'), ['2026-11-02', '2026-11-16', '2026-11-30']);
  const ending = r({ due_date: '2026-11-02', recurrence: 'weekly', recur_days: '1', recur_until: '2026-11-10' });
  assert.deepEqual(S.occurrenceDates(ending, '2026-11-01', '2026-12-31'), ['2026-11-02', '2026-11-09']);
});

test('weekdays recurrence skips weekends', () => {
  const wk = r({ due_date: '2026-11-06', recurrence: 'weekdays' }); // Friday
  assert.deepEqual(S.occurrenceDates(wk, '2026-11-06', '2026-11-10'), ['2026-11-06', '2026-11-09', '2026-11-10']);
});

test('monthly recurrence clamps to the last day of short months', () => {
  const m = r({ due_date: '2026-01-31', recurrence: 'monthly' });
  assert.deepEqual(S.occurrenceDates(m, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('recurrence keeps wall-clock time across a DST change', () => {
  const w = r({ due_date: '2026-10-19', recurrence: 'weekly', recur_days: '1', due_time: '09:00' });
  for (const o of S.occurrences(w, '2026-10-19', '2026-11-30')) {
    assert.equal(o.start.getHours(), 9);
    assert.equal(o.start.getMinutes(), 0);
  }
});

test('nextOccurrence advances recurring tasks and ends after the last one', () => {
  assert.equal(S.nextOccurrence(r({ due_date: '2026-11-02', recurrence: 'weekly', recur_days: '1,4' })), '2026-11-05');
  assert.equal(S.nextOccurrence(r({ due_date: '2026-11-02', recurrence: 'daily', recur_until: '2026-11-02' })), null);
  assert.equal(S.nextOccurrence(r({ due_date: '2026-11-02' })), null);
});

test('overdue and urgency', () => {
  const now = new Date(2026, 10, 2, 12, 0);
  assert.equal(S.isOverdue(r({ due_date: '2026-11-02', due_time: '11:00' }), now), true);
  assert.equal(S.isOverdue(r({ due_date: '2026-11-02', due_time: '11:00', category: 'Class' }), now), false);
  assert.equal(S.isOverdue(r({ due_date: '2026-11-02', due_time: '11:00', status: 'Completed' }), now), false);
  const soonExam = S.urgency(r({ due_date: '2026-11-03', due_time: '09:00', category: 'Exam', priority: 'High' }), now);
  const farLow = S.urgency(r({ due_date: '2026-11-30', priority: 'Low' }), now);
  assert.equal(soonExam.level, 'critical');
  assert.equal(farLow.level, 'normal');
  assert.ok(soonExam.score > farLow.score);
});

test('conflict detection finds overlapping timed blocks only', () => {
  const a = r({ id: 1, title: 'Physics', category: 'Class', due_date: '2026-11-02', due_time: '09:00', duration_minutes: 90 });
  const b = r({ id: 2, title: 'Lab', category: 'Class', due_date: '2026-11-02', due_time: '10:00', duration_minutes: 60 });
  const c = r({ id: 3, title: 'Essay', due_date: '2026-11-02', due_time: '10:00' }); // deadline, no duration
  const d = r({ id: 4, title: 'Gym', category: 'Personal', due_date: '2026-11-02', due_time: '10:30', duration_minutes: 30 }); // touches end of a, overlaps b
  const occ = S.expandAll([a, b, c, d], '2026-11-02', '2026-11-02');
  const pairs = S.findConflicts(occ).map(([x, y]) => [x.reminder.id, y.reminder.id].sort().join('-'));
  assert.deepEqual(pairs.sort(), ['1-2', '2-4']);
  const hits = S.conflictsFor({ due_date: '2026-11-02', due_time: '08:30', duration_minutes: 60, recurrence: 'none' }, [a, b, c]);
  assert.deepEqual(hits.map((h) => h.other.reminder.id), [1]);
});

test('planner spreads sessions before the deadline and around classes', () => {
  const now = new Date(2026, 10, 2, 8, 0); // Monday morning
  const essay = r({ id: 10, title: 'Essay', due_date: '2026-11-05', due_time: '23:59', est_minutes: 180, priority: 'High' });
  const lecture = r({ id: 11, title: 'Evening lecture', category: 'Class', due_date: '2026-11-02', due_time: '16:00', duration_minutes: 120, recurrence: 'weekly', recur_days: '1,2,3,4,5' });
  const prefs = Object.assign({}, S.DEFAULT_STUDY_PREFS, { weekdayStart: '16:00', weekdayEnd: '21:00', sessionMinutes: 60, breakMinutes: 15 });
  const plan = S.planStudy([essay, lecture], prefs, now, 14);
  assert.equal(plan.sessions.length, 3);
  const days = plan.sessions.map((s) => s.date);
  assert.equal(new Set(days).size, 3, 'one session per day, spread out');
  for (const s of plan.sessions) {
    assert.ok(s.date <= '2026-11-05');
    assert.ok(S.minutesOf(s.time) >= 18 * 60 + 15, `session ${s.time} must start after the lecture + break`);
  }
  assert.equal(plan.tasks[0].shortfall, 0);
});

test('planner counts already-scheduled sessions and reports shortfall', () => {
  const now = new Date(2026, 10, 2, 8, 0);
  const exam = r({ id: 20, title: 'Exam', category: 'Exam', due_date: '2026-11-03', due_time: '09:00', est_minutes: 600 });
  const existing = r({ id: 21, title: 'Study: Exam', category: 'Study', linked_id: 20, due_date: '2026-11-02', due_time: '16:00', duration_minutes: 60 });
  const plan = S.planStudy([exam, existing], S.DEFAULT_STUDY_PREFS, now, 14);
  const t = plan.tasks.find((x) => x.id === 20);
  assert.equal(t.alreadyPlanned, 60);
  assert.ok(t.shortfall > 0, 'only one evening is available before the exam');
});

test('dueNotifications respects lead time, completion, creation time and opt-out', () => {
  const now = new Date(2026, 10, 2, 8, 50);
  const cls = r({ id: 30, category: 'Class', due_date: '2026-11-02', due_time: '09:00', remind_before: 15 });
  const later = r({ id: 31, due_date: '2026-11-02', due_time: '12:00', remind_before: 15 });
  const done = r({ id: 32, due_date: '2026-11-02', due_time: '09:00', status: 'Completed' });
  const off = r({ id: 33, due_date: '2026-11-02', due_time: '09:00', remind_before: -1 });
  // Created after its 08:45 alert time but before it is due: alert immediately.
  const fresh = r({ id: 34, due_date: '2026-11-02', due_time: '09:00', created_at: new Date(2026, 10, 2, 8, 49).toISOString() });
  // Already in the past when created: never alert.
  const backdated = r({ id: 35, due_date: '2026-11-02', due_time: '08:00', remind_before: 0, created_at: new Date(2026, 10, 2, 8, 30).toISOString() });
  const events = S.dueNotifications([cls, later, done, off, fresh, backdated], now);
  assert.deepEqual(events.map((e) => e.occurrence.reminder.id).sort(), [30, 34]);
  assert.equal(events.find((e) => e.occurrence.reminder.id === 30).key, '30@2026-11-02T09:00#15');
  assert.equal(events.find((e) => e.occurrence.reminder.id === 34).fireAt.getMinutes(), 49);
});

test('insights flag overdue items, clashes and unprepared exams', () => {
  const now = new Date(2026, 10, 2, 12, 0);
  const list = [
    r({ id: 1, title: 'Late lab report', due_date: '2026-11-01' }),
    r({ id: 2, title: 'Math', category: 'Class', due_date: '2026-11-03', due_time: '10:00', duration_minutes: 60 }),
    r({ id: 3, title: 'Chem', category: 'Class', due_date: '2026-11-03', due_time: '10:30', duration_minutes: 60 }),
    r({ id: 4, title: 'Biology final', category: 'Exam', due_date: '2026-11-05', due_time: '09:00' })
  ];
  const types = S.insights(list, now).map((i) => i.type);
  assert.ok(types.includes('overdue'));
  assert.ok(types.includes('conflict'));
  assert.ok(types.includes('prep'));
});
