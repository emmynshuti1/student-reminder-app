const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const db = new DatabaseSync(path.join(__dirname, 'database.sqlite'));

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
`);

const insertUser = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)');
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserById = db.prepare('SELECT id, name, email FROM users WHERE id = ?');
const insertReminder = db.prepare(`
  INSERT INTO reminders (user_id, title, description, subject, due_date, due_time, priority)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getRemindersByUser = db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_date, due_time');
const getReminderById = db.prepare('SELECT * FROM reminders WHERE id = ? AND user_id = ?');
const updateReminder = db.prepare(`
  UPDATE reminders SET title = ?, description = ?, subject = ?, due_date = ?, due_time = ?, priority = ?
  WHERE id = ? AND user_id = ?
`);
const completeReminder = db.prepare('UPDATE reminders SET status = ? WHERE id = ? AND user_id = ?');
const deleteReminder = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?');
const insertToken = db.prepare('INSERT INTO tokens (token, user_id, created_at) VALUES (?, ?, ?)');
const findToken = db.prepare('SELECT * FROM tokens WHERE token = ?');
const deleteToken = db.prepare('DELETE FROM tokens WHERE token = ?');
const deleteTokensForUser = db.prepare('DELETE FROM tokens WHERE user_id = ?');

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
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'student-reminder-secret-key',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
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
    const row = findToken.get(header.slice(7).trim());
    if (row) {
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
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

function loginPayload(user, token) {
  return { success: true, token, user: { id: user.id, name: user.name, email: user.email } };
}

app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = insertUser.run(String(name).trim(), String(email).trim().toLowerCase(), hash);
    const user = findUserById.get(Number(result.lastInsertRowid));
    req.session.userId = user.id;
    req.session.userName = user.name;
    const token = issueToken(user.id);
    res.json(loginPayload(user, token));
  } catch (err) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const userRow = findUserByEmail.get(String(email).trim().toLowerCase());
  if (userRow && bcrypt.compareSync(password, userRow.password)) {
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
  const { title, description, subject, due_date, due_time, priority } = req.body || {};
  if (!title || !due_date || !due_time) {
    return res.status(400).json({ error: 'Title, due date, and due time are required' });
  }
  const result = insertReminder.run(
    req.user.id,
    String(title).trim(),
    description || null,
    subject || null,
    due_date,
    due_time,
    priority || 'Medium'
  );
  res.json({ id: Number(result.lastInsertRowid), success: true });
});

app.get('/api/reminders', requireAuth, (req, res) => {
  res.json(getRemindersByUser.all(req.user.id));
});

app.get('/api/reminders/:id', requireAuth, (req, res) => {
  const reminder = getReminderById.get(req.params.id, req.user.id);
  if (!reminder) return res.status(404).json({ error: 'Not found' });
  res.json(reminder);
});

app.put('/api/reminders/:id', requireAuth, (req, res) => {
  const existing = getReminderById.get(req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { title, description, subject, due_date, due_time, priority } = req.body || {};
  updateReminder.run(
    title || existing.title,
    description !== undefined ? description : existing.description,
    subject !== undefined ? subject : existing.subject,
    due_date || existing.due_date,
    due_time || existing.due_time,
    priority || existing.priority,
    req.params.id,
    req.user.id
  );
  res.json({ success: true });
});

app.put('/api/reminders/:id/complete', requireAuth, (req, res) => {
  completeReminder.run('Completed', req.params.id, req.user.id);
  res.json({ success: true });
});

app.put('/api/reminders/:id/reopen', requireAuth, (req, res) => {
  completeReminder.run('Pending', req.params.id, req.user.id);
  res.json({ success: true });
});

app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  deleteReminder.run(req.params.id, req.user.id);
  res.json({ success: true });
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
