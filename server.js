const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const Schedule = require('./public/lib/schedule.js');

// The built-in SQLite module needs Node.js 22.5+. Fail with a clear message
// instead of a raw stack trace when the app is started on an older Node.
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error('');
  console.error('CampusPulse requires Node.js 22.5 or newer (it uses the built-in SQLite module).');
  console.error('Please upgrade Node.js (https://nodejs.org) and run "npm start" again.');
  console.error('');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.sqlite');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    subject TEXT,
    due_date TEXT NOT NULL,
    due_time TEXT NOT NULL,
    priority TEXT DEFAULT 'Medium',
    status TEXT DEFAULT 'Pending',
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS notification_log (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    title TEXT,
    body TEXT,
    reminder_id INTEGER,
    fired_at TEXT NOT NULL,
    missed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, key)
  );
`);

// Columns added after the original release. Migration is additive only
// (ALTER TABLE ADD COLUMN), and the database is snapshotted first.
const NEW_REMINDER_COLUMNS = {
  category: "TEXT NOT NULL DEFAULT 'Other'",
  duration_minutes: 'INTEGER NOT NULL DEFAULT 0',
  location: 'TEXT',
  remind_before: 'INTEGER NOT NULL DEFAULT 15',
  recurrence: "TEXT NOT NULL DEFAULT 'none'",
  recur_interval: 'INTEGER NOT NULL DEFAULT 1',
  recur_days: 'TEXT',
  recur_until: 'TEXT',
  est_minutes: 'INTEGER NOT NULL DEFAULT 0',
  linked_id: 'INTEGER',
  completed_at: 'TEXT',
  created_at: 'TEXT',
  updated_at: 'TEXT'
};

function migrate() {
  const existing = new Set(db.prepare('PRAGMA table_info(reminders)').all().map((c) => c.name));
  const missing = Object.keys(NEW_REMINDER_COLUMNS).filter((c) => !existing.has(c));
  if (!missing.length) return;
  const hasData = db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n > 0;
  if (hasData && DB_PATH !== ':memory:') {
    const backup = `${DB_PATH}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Database backed up to ${backup} before upgrading the schema.`);
  }
  db.exec('BEGIN');
  try {
    for (const col of missing) db.exec(`ALTER TABLE reminders ADD COLUMN ${col} ${NEW_REMINDER_COLUMNS[col]}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
migrate();
db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, due_date)');
db.prepare('DELETE FROM tokens WHERE created_at < ?').run(Date.now() - TOKEN_TTL_MS);
db.prepare('DELETE FROM notification_log WHERE fired_at < ?').run(new Date(Date.now() - 60 * 864e5).toISOString());

const REMINDER_FIELDS = [
  'title', 'description', 'subject', 'category', 'due_date', 'due_time', 'priority',
  'duration_minutes', 'location', 'remind_before', 'recurrence', 'recur_interval',
  'recur_days', 'recur_until', 'est_minutes', 'linked_id'
];

const insertUser = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)');
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserById = db.prepare('SELECT id, name, email FROM users WHERE id = ?');
const insertReminder = db.prepare(`
  INSERT INTO reminders (user_id, ${REMINDER_FIELDS.join(', ')}, status, created_at, updated_at)
  VALUES (?, ${REMINDER_FIELDS.map(() => '?').join(', ')}, 'Pending', ?, ?)
`);
const getRemindersByUser = db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_date, due_time');
const getReminderById = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?');
const updateReminder = db.prepare(`
  UPDATE reminders SET ${REMINDER_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ?
  WHERE id = ? AND user_id = ?
`);
const findDuplicate = db.prepare(`
  SELECT id FROM reminders
  WHERE user_id = ? AND lower(title) = lower(?) AND due_date = ? AND due_time = ? AND status = 'Pending' AND id != ?
  LIMIT 1
`);
const findAnyDuplicate = db.prepare(`
  SELECT id FROM reminders WHERE user_id = ? AND lower(title) = lower(?) AND due_date = ? AND due_time = ? LIMIT 1
`);
const setStatus = db.prepare('UPDATE reminders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?');
const advanceReminder = db.prepare('UPDATE reminders SET due_date = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?');
const deleteReminder = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?');
const unlinkSessions = db.prepare('UPDATE reminders SET linked_id = NULL WHERE linked_id = ? AND user_id = ?');
const insertToken = db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)');
const findToken = db.prepare('SELECT * FROM tokens WHERE token = ?');
const deleteToken = db.prepare('DELETE FROM tokens WHERE token = ?');
const getSettings = db.prepare('SELECT data FROM user_settings WHERE user_id = ?');
const upsertSettings = db.prepare(`
  INSERT INTO user_settings (user_id, data) VALUES (?, ?)
  ON CONFLICT(user_id) DO UPDATE SET data = excluded.data
`);
const claimNotification = db.prepare(`
  INSERT OR IGNORE INTO notification_log (user_id, key, title, body, reminder_id, fired_at, missed)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const recentNotifications = db.prepare(`
  SELECT key, title, body, reminder_id, fired_at, missed FROM notification_log
  WHERE user_id = ? ORDER BY fired_at DESC LIMIT 30
`);

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

class ValidationError extends Error {}

function str(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidationError(`${label} is invalid`);
  const s = String(value).trim();
  if (required && !s) throw new ValidationError(`${label} is required`);
  if (s.length > max) throw new ValidationError(`${label} must be at most ${max} characters`);
  return s || null;
}

function int(value, min, max, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} must be a whole number between ${min} and ${max}`);
  return n;
}

// Normalise and validate a full reminder. `base` supplies values for fields
// that the request omitted (used for partial updates).
function validateReminder(input, base = {}) {
  const src = Object.assign({}, base, input || {});
  const r = {};
  r.title = str(src.title, 120, 'Title', { required: true });
  r.description = str(src.description, 2000, 'Notes');
  r.subject = str(src.subject, 60, 'Subject');
  r.location = str(src.location, 80, 'Location');
  r.category = src.category || 'Assignment';
  if (!Schedule.CATEGORIES.includes(r.category)) throw new ValidationError('Category is invalid');
  r.priority = src.priority || 'Medium';
  if (!Schedule.PRIORITIES.includes(r.priority)) throw new ValidationError('Priority must be High, Medium, or Low');
  r.due_date = String(src.due_date || '');
  if (!Schedule.isValidDate(r.due_date)) throw new ValidationError('A valid date is required');
  r.due_time = String(src.due_time || '').slice(0, 5);
  if (!Schedule.isValidTime(r.due_time)) throw new ValidationError('A valid time (HH:MM) is required');
  r.duration_minutes = int(src.duration_minutes, 0, 24 * 60, 'Duration', 0);
  r.remind_before = int(src.remind_before, -1, 14 * 24 * 60, 'Reminder lead time', 15);
  r.est_minutes = int(src.est_minutes, 0, 200 * 60, 'Estimated effort', 0);
  r.recurrence = src.recurrence || 'none';
  if (!Schedule.RECURRENCES.includes(r.recurrence)) throw new ValidationError('Repeat option is invalid');
  r.recur_interval = int(src.recur_interval, 1, 365, 'Repeat interval', 1);
  r.recur_days = null;
  r.recur_until = null;
  if (r.recurrence === 'weekly') {
    const days = Schedule.parseDays(src.recur_days);
    r.recur_days = (days.length ? [...new Set(days)].sort() : [Schedule.weekday(r.due_date)]).join(',');
  }
  if (r.recurrence !== 'none') {
    if (src.recur_until) {
      if (!Schedule.isValidDate(src.recur_until)) throw new ValidationError('Repeat-until date is invalid');
      if (src.recur_until < r.due_date) throw new ValidationError('Repeat-until date must be on or after the start date');
      r.recur_until = src.recur_until;
    }
  } else {
    r.recur_interval = 1;
  }
  r.linked_id = src.linked_id ? int(src.linked_id, 1, Number.MAX_SAFE_INTEGER, 'Linked task', null) : null;
  return r;
}

function reminderValues(r) {
  return REMINDER_FIELDS.map((f) => (r[f] === undefined ? null : r[f]));
}

function createReminder(userId, data) {
  const r = validateReminder(data);
  if (findDuplicate.get(userId, r.title, r.due_date, r.due_time, -1)) {
    const err = new ValidationError('You already have a pending reminder with this title at that date and time.');
    err.status = 409;
    throw err;
  }
  const now = new Date().toISOString();
  const result = insertReminder.run(userId, ...reminderValues(r), now, now);
  return getReminderById.get(Number(result.lastInsertRowid), userId);
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  return id;
}

function sendError(res, err) {
  if (err instanceof ValidationError) return res.status(err.status || 400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '2mb' }));
// secure: 'auto' marks the cookie Secure only when the request is HTTPS
// (honouring X-Forwarded-Proto behind a proxy) and leaves it a plain cookie
// over plain HTTP. With a hard-coded secure: true, express-session never sends
// the cookie at all on non-HTTPS requests, which silently breaks login on
// http://localhost:3000 and behind proxies that do not forward the proto.
app.use(session({
  secret: process.env.SESSION_SECRET || 'student-reminder-secret-key',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  insertToken.run(token, userId, Date.now());
  return token;
}

function currentUser(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const value = header.slice(7).trim();
    const row = findToken.get(value);
    if (row && Date.now() - row.created_at > TOKEN_TTL_MS) {
      deleteToken.run(value);
    } else if (row) {
      const user = findUserById.get(row.user_id);
      if (user) return user;
    }
  }
  if (req.session && req.session.userId) {
    const user = findUserById.get(req.session.userId);
    if (user) return user;
  }
  return null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  req.user = user;
  next();
}

function loginPayload(user, token) {
  return { success: true, token, user: { id: user.id, name: user.name, email: user.email } };
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (String(name).trim().length > 80) {
    return res.status(400).json({ error: 'Name must be at most 80 characters' });
  }
  try {
    const hash = bcrypt.hashSync(String(password), 10);
    const result = insertUser.run(String(name).trim(), String(email).trim().toLowerCase(), hash);
    const user = findUserById.get(Number(result.lastInsertRowid));
    req.session.userId = user.id;
    req.session.userName = user.name;
    const token = issueToken(user.id);
    res.json(loginPayload(user, token));
  } catch (err) {
    if (err && /UNIQUE/i.test(String(err.message))) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const userRow = findUserByEmail.get(String(email).trim().toLowerCase());
  if (userRow && bcrypt.compareSync(String(password), userRow.password)) {
    const user = { id: userRow.id, name: userRow.name, email: userRow.email };
    req.session.userId = user.id;
    req.session.userName = user.name;
    const token = issueToken(user.id);
    res.json(loginPayload(user, token));
  } else {
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

app.post('/api/logout', (req, res) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    deleteToken.run(header.slice(7).trim());
  }
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/user', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email });
});

app.post('/api/reminders', requireAuth, (req, res) => {
  try {
    const reminder = createReminder(req.user.id, req.body);
    res.json({ id: reminder.id, success: true, reminder });
  } catch (err) {
    sendError(res, err);
  }
});

// Create several reminders at once (used by the study planner). All-or-nothing;
// items identical to an existing pending reminder are skipped, not duplicated.
app.post('/api/reminders/bulk', requireAuth, (req, res) => {
  const items = req.body && req.body.items;
  if (!Array.isArray(items) || !items.length || items.length > 200) {
    return res.status(400).json({ error: 'Provide between 1 and 200 items' });
  }
  try {
    const result = transaction(() => {
      const created = [];
      let skipped = 0;
      for (const item of items) {
        try {
          created.push(createReminder(req.user.id, item));
        } catch (err) {
          if (err.status === 409) skipped++;
          else throw err;
        }
      }
      return { created, skipped };
    });
    res.json({ success: true, created: result.created.length, skipped: result.skipped, reminders: result.created });
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/reminders', requireAuth, (req, res) => {
  res.json(getRemindersByUser.all(req.user.id));
});

app.get('/api/reminders/:id', requireAuth, (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const reminder = getReminderById.get(id, req.user.id);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
  res.json(reminder);
});

app.put('/api/reminders/:id', requireAuth, (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const existing = getReminderById.get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Reminder not found' });
  try {
    const r = validateReminder(req.body, existing);
    if (r.linked_id === id) r.linked_id = null;
    if (existing.status === 'Pending' && findDuplicate.get(req.user.id, r.title, r.due_date, r.due_time, id)) {
      return res.status(409).json({ error: 'You already have a pending reminder with this title at that date and time.' });
    }
    updateReminder.run(...reminderValues(r), new Date().toISOString(), id, req.user.id);
    res.json({ success: true, reminder: getReminderById.get(id, req.user.id) });
  } catch (err) {
    sendError(res, err);
  }
});

// Completing a recurring task moves it to its next occurrence; the series
// only becomes "Completed" after its last occurrence.
app.put('/api/reminders/:id/complete', requireAuth, (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const existing = getReminderById.get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Reminder not found' });
  if (!Schedule.isCompletable(existing)) return res.status(400).json({ error: 'Classes are timetable entries and cannot be completed' });
  const now = new Date().toISOString();
  const next = existing.status === 'Pending' ? Schedule.nextOccurrence(existing) : null;
  if (next) {
    advanceReminder.run(next, now, now, id, req.user.id);
    return res.json({ success: true, advanced: true, next_date: next, reminder: getReminderById.get(id, req.user.id) });
  }
  setStatus.run('Completed', now, now, id, req.user.id);
  res.json({ success: true, advanced: false, reminder: getReminderById.get(id, req.user.id) });
});

// Skip the current occurrence of a recurring item without marking it done.
app.put('/api/reminders/:id/skip', requireAuth, (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const existing = getReminderById.get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Reminder not found' });
  const next = Schedule.nextOccurrence(existing);
  if (!next) return res.status(400).json({ error: 'There is no later occurrence to skip to' });
  advanceReminder.run(next, existing.completed_at, new Date().toISOString(), id, req.user.id);
  res.json({ success: true, next_date: next, reminder: getReminderById.get(id, req.user.id) });
});

app.put('/api/reminders/:id/reopen', requireAuth, (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const existing = getReminderById.get(id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Reminder not found' });
  setStatus.run('Pending', null, new Date().toISOString(), id, req.user.id);
  res.json({ success: true, reminder: getReminderById.get(id, req.user.id) });
});

app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  const result = transaction(() => {
    unlinkSessions.run(id, req.user.id);
    return deleteReminder.run(id, req.user.id);
  });
  if (!result.changes) return res.status(404).json({ error: 'Reminder not found' });
  res.json({ success: true });
});

function readSettings(userId) {
  const row = getSettings.get(userId);
  let data = {};
  try { data = row ? JSON.parse(row.data) : {}; } catch (_) {}
  return { study: Object.assign({}, Schedule.DEFAULT_STUDY_PREFS, data.study || {}) };
}

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(readSettings(req.user.id));
});

app.put('/api/settings', requireAuth, (req, res) => {
  const study = (req.body && req.body.study) || {};
  try {
    const s = {};
    for (const key of ['weekdayStart', 'weekdayEnd', 'weekendStart', 'weekendEnd']) {
      if (!Schedule.isValidTime(study[key])) throw new ValidationError('Study hours must be valid times');
    }
    if (study.weekdayStart >= study.weekdayEnd || study.weekendStart >= study.weekendEnd) {
      throw new ValidationError('Study hours must end after they start');
    }
    Object.assign(s, {
      weekdayStart: study.weekdayStart,
      weekdayEnd: study.weekdayEnd,
      weekendStart: study.weekendStart,
      weekendEnd: study.weekendEnd,
      sessionMinutes: int(study.sessionMinutes, 15, 240, 'Session length', 60),
      maxMinutesPerDay: int(study.maxMinutesPerDay, 15, 720, 'Daily study limit', 180),
      breakMinutes: int(study.breakMinutes, 0, 120, 'Break length', 15),
      studyDays: Schedule.parseDays(study.studyDays)
    });
    if (!s.studyDays.length) throw new ValidationError('Choose at least one study day');
    upsertSettings.run(req.user.id, JSON.stringify({ study: s }));
    res.json(readSettings(req.user.id));
  } catch (err) {
    sendError(res, err);
  }
});

// Notification de-duplication across tabs, devices, and restarts: the first
// client to claim a notification key gets to show it.
app.post('/api/notifications/claim', requireAuth, (req, res) => {
  const { key, title, body, reminder_id, missed } = req.body || {};
  if (typeof key !== 'string' || !key || key.length > 200) return res.status(400).json({ error: 'Invalid key' });
  const result = claimNotification.run(
    req.user.id, key,
    String(title || '').slice(0, 200), String(body || '').slice(0, 300),
    Number.isInteger(reminder_id) ? reminder_id : null,
    new Date().toISOString(), missed ? 1 : 0
  );
  res.json({ claimed: result.changes === 1 });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  res.json(recentNotifications.all(req.user.id));
});

app.get('/api/export', requireAuth, (req, res) => {
  const reminders = getRemindersByUser.all(req.user.id);
  res.setHeader('Content-Disposition', `attachment; filename="campuspulse-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: 'CampusPulse', version: 2, exported_at: new Date().toISOString(), settings: readSettings(req.user.id), reminders });
});

// Import a backup. Existing data is never overwritten; duplicates are skipped.
app.post('/api/import', requireAuth, (req, res) => {
  const items = req.body && req.body.reminders;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'This file is not a CampusPulse backup' });
  if (items.length > 5000) return res.status(400).json({ error: 'Backup is too large' });
  try {
    const result = transaction(() => {
      const idMap = {};
      let created = 0, skipped = 0;
      const now = new Date().toISOString();
      for (const item of items) {
        const data = Object.assign({}, item, { linked_id: null });
        if (item && findAnyDuplicate.get(req.user.id, String(item.title || ''), String(item.due_date || ''), String(item.due_time || '').slice(0, 5))) {
          skipped++;
          continue;
        }
        let row;
        try {
          row = createReminder(req.user.id, data);
        } catch (err) {
          if (err.status === 409) { skipped++; continue; }
          throw new ValidationError(`Could not import "${item && item.title}": ${err.message}`);
        }
        created++;
        if (item.id) idMap[item.id] = { newId: row.id, linked: item.linked_id };
        if (item.status === 'Completed') setStatus.run('Completed', item.completed_at || now, now, row.id, req.user.id);
      }
      const relink = db.prepare('UPDATE reminders SET linked_id = ? WHERE id = ? AND user_id = ?');
      for (const { newId, linked } of Object.values(idMap)) {
        if (linked && idMap[linked]) relink.run(idMap[linked].newId, newId, req.user.id);
      }
      return { created, skipped };
    });
    res.json({ success: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// Malformed JSON and other unexpected errors return JSON, not an HTML stack.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`CampusPulse running at http://localhost:${PORT}`);
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the process using it, or start with: PORT=<other-port> npm start`);
      process.exit(1);
    }
    throw err;
  });
}

module.exports = { app, db };
