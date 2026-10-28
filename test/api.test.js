const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each run uses a throwaway database so real data is never touched.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campuspulse-test-'));
process.env.DB_PATH = path.join(dir, 'test.sqlite');
const { app, db } = require('../server.js');

let server, baseUrl, auth;

async function call(method, url, body, token = auth) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const reg = await call('POST', '/api/register', { name: 'Ada Student', email: 'ada@uni.edu', password: 'secret1' }, null);
  assert.equal(reg.status, 200);
  auth = reg.body.token;
});

test.after(() => {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth: duplicate email, bad password, protected routes', async () => {
  assert.equal((await call('POST', '/api/register', { name: 'A', email: 'ADA@uni.edu', password: 'secret1' }, null)).status, 400);
  assert.equal((await call('POST', '/api/login', { email: 'ada@uni.edu', password: 'nope' }, null)).status, 401);
  assert.equal((await call('GET', '/api/reminders', undefined, null)).status, 401);
  const login = await call('POST', '/api/login', { email: 'Ada@Uni.edu', password: 'secret1' }, null);
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
});

test('reminder validation', async () => {
  const bad = [
    {},
    { title: 'x', due_date: '2026-02-30', due_time: '10:00' },
    { title: 'x', due_date: '2026-11-02', due_time: '25:00' },
    { title: 'x', due_date: '2026-11-02', due_time: '10:00', priority: 'Urgent' },
    { title: 'x', due_date: '2026-11-02', due_time: '10:00', category: 'Party' },
    { title: 'x', due_date: '2026-11-02', due_time: '10:00', recurrence: 'weekly', recur_until: '2026-10-01' },
    { title: 'x'.repeat(121), due_date: '2026-11-02', due_time: '10:00' }
  ];
  for (const body of bad) {
    const res = await call('POST', '/api/reminders', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.error);
  }
  const malformed = await fetch(baseUrl + '/api/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: '{oops' });
  assert.equal(malformed.status, 400);
});

test('create, read, edit, duplicate protection, delete', async () => {
  const created = await call('POST', '/api/reminders', { title: 'Essay draft', subject: 'ENG 101', category: 'Assignment', due_date: '2030-03-10', due_time: '23:59', priority: 'High', est_minutes: 180 });
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.equal(created.body.reminder.category, 'Assignment');
  assert.ok(created.body.reminder.created_at);

  const dup = await call('POST', '/api/reminders', { title: 'essay DRAFT', due_date: '2030-03-10', due_time: '23:59' });
  assert.equal(dup.status, 409);

  const edited = await call('PUT', `/api/reminders/${id}`, { due_date: '2030-03-11' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.reminder.due_date, '2030-03-11');
  assert.equal(edited.body.reminder.title, 'Essay draft', 'partial updates keep other fields');
  assert.equal(edited.body.reminder.est_minutes, 180);

  assert.equal((await call('PUT', `/api/reminders/${id}`, { due_time: 'noon' })).status, 400);
  assert.equal((await call('GET', '/api/reminders/999999')).status, 404);
  assert.equal((await call('PUT', '/api/reminders/999999/complete')).status, 404);
  assert.equal((await call('GET', '/api/reminders/abc')).status, 400);

  assert.equal((await call('DELETE', `/api/reminders/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/api/reminders/${id}`)).status, 404);
});

test('users cannot see each other\'s reminders', async () => {
  const other = await call('POST', '/api/register', { name: 'Bob', email: 'bob@uni.edu', password: 'secret2' }, null);
  const mine = await call('POST', '/api/reminders', { title: 'Private', due_date: '2030-01-01', due_time: '10:00' });
  assert.equal((await call('GET', `/api/reminders/${mine.body.id}`, undefined, other.body.token)).status, 404);
  assert.equal((await call('DELETE', `/api/reminders/${mine.body.id}`, undefined, other.body.token)).status, 404);
  const list = await call('GET', '/api/reminders', undefined, other.body.token);
  assert.equal(list.body.length, 0);
});

test('completing a recurring task advances it; the last occurrence completes it', async () => {
  const res = await call('POST', '/api/reminders', {
    title: 'Weekly quiz', category: 'Assignment', due_date: '2030-01-07', due_time: '09:00',
    recurrence: 'weekly', recur_days: '1,3', recur_until: '2030-01-09'
  });
  const id = res.body.id;
  assert.equal(res.body.reminder.recur_days, '1,3');
  const first = await call('PUT', `/api/reminders/${id}/complete`);
  assert.equal(first.body.advanced, true);
  assert.equal(first.body.next_date, '2030-01-09');
  assert.equal(first.body.reminder.status, 'Pending');
  const second = await call('PUT', `/api/reminders/${id}/complete`);
  assert.equal(second.body.advanced, false);
  assert.equal(second.body.reminder.status, 'Completed');
  assert.ok(second.body.reminder.completed_at);
  const reopened = await call('PUT', `/api/reminders/${id}/reopen`);
  assert.equal(reopened.body.reminder.status, 'Pending');
});

test('skip moves a recurring item forward; classes cannot be completed', async () => {
  const cls = await call('POST', '/api/reminders', { title: 'Calculus lecture', category: 'Class', due_date: '2030-01-07', due_time: '10:00', duration_minutes: 90, recurrence: 'weekly' });
  assert.equal(cls.body.reminder.recur_days, '1', 'weekly defaults to the start date\'s weekday');
  assert.equal((await call('PUT', `/api/reminders/${cls.body.id}/complete`)).status, 400);
  const skipped = await call('PUT', `/api/reminders/${cls.body.id}/skip`);
  assert.equal(skipped.body.next_date, '2030-01-14');
});

test('bulk create is atomic and skips duplicates', async () => {
  const task = await call('POST', '/api/reminders', { title: 'Chem exam', category: 'Exam', due_date: '2030-05-20', due_time: '09:00' });
  const items = [
    { title: 'Study: Chem exam', category: 'Study', due_date: '2030-05-18', due_time: '17:00', duration_minutes: 60, linked_id: task.body.id },
    { title: 'Study: Chem exam', category: 'Study', due_date: '2030-05-19', due_time: '17:00', duration_minutes: 60, linked_id: task.body.id }
  ];
  const first = await call('POST', '/api/reminders/bulk', { items });
  assert.equal(first.body.created, 2);
  const again = await call('POST', '/api/reminders/bulk', { items });
  assert.equal(again.body.created, 0);
  assert.equal(again.body.skipped, 2);

  const before = (await call('GET', '/api/reminders')).body.length;
  const bad = await call('POST', '/api/reminders/bulk', { items: [{ title: 'ok', due_date: '2030-06-01', due_time: '10:00' }, { title: 'broken' }] });
  assert.equal(bad.status, 400);
  assert.equal((await call('GET', '/api/reminders')).body.length, before, 'nothing created when one item is invalid');

  // Deleting the exam unlinks its sessions instead of leaving dangling ids.
  await call('DELETE', `/api/reminders/${task.body.id}`);
  const sessions = (await call('GET', '/api/reminders')).body.filter((r) => r.title === 'Study: Chem exam');
  assert.ok(sessions.every((s) => s.linked_id === null));
});

test('settings validate and persist', async () => {
  const defaults = await call('GET', '/api/settings');
  assert.equal(defaults.body.study.sessionMinutes, 60);
  const bad = await call('PUT', '/api/settings', { study: Object.assign({}, defaults.body.study, { weekdayStart: '22:00', weekdayEnd: '20:00' }) });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', '/api/settings', { study: Object.assign({}, defaults.body.study, { sessionMinutes: 45, studyDays: [1, 2, 3] }) });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/settings')).body.study.sessionMinutes, 45);
});

test('notification claims are only granted once', async () => {
  const body = { key: '5@2030-01-01T09:00#15', title: 'Quiz', body: 'Starts soon' };
  assert.equal((await call('POST', '/api/notifications/claim', body)).body.claimed, true);
  assert.equal((await call('POST', '/api/notifications/claim', body)).body.claimed, false);
  const log = await call('GET', '/api/notifications');
  assert.equal(log.body[0].title, 'Quiz');
});

test('export then import round-trips without duplicating', async () => {
  const exported = await call('GET', '/api/export');
  assert.equal(exported.body.app, 'CampusPulse');
  const count = exported.body.reminders.length;
  assert.ok(count > 0);
  const reimport = await call('POST', '/api/import', { reminders: exported.body.reminders });
  assert.equal(reimport.body.created, 0);
  assert.equal(reimport.body.skipped, count);

  const fresh = await call('POST', '/api/register', { name: 'Cy', email: 'cy@uni.edu', password: 'secret3' }, null);
  const imported = await call('POST', '/api/import', { reminders: exported.body.reminders }, fresh.body.token);
  assert.equal(imported.body.created, count);
  const list = (await call('GET', '/api/reminders', undefined, fresh.body.token)).body;
  assert.equal(list.length, count);
  assert.equal(list.filter((r) => r.status === 'Completed').length, exported.body.reminders.filter((r) => r.status === 'Completed').length);
});
