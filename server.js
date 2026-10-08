const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
`);

const insertUser = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)');
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
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

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'student-reminder-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(__dirname));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = insertUser.run(name.trim(), email.trim().toLowerCase(), hash);
    req.session.userId = Number(result.lastInsertRowid);
    req.session.userName = name.trim();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Email already exists' });
  }
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = findUserByEmail.get(email.trim().toLowerCase());
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid email or password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/user', (req, res) => {
  if (req.session.userId) {
    res.json({ id: req.session.userId, name: req.session.userName });
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

app.post('/api/reminders', requireAuth, (req, res) => {
  const { title, description, subject, due_date, due_time, priority } = req.body;
  if (!title || !due_date || !due_time) {
    return res.status(400).json({ error: 'Title, due date, and due time are required' });
  }
  const result = insertReminder.run(
    req.session.userId,
    title.trim(),
    description || null,
    subject || null,
    due_date,
    due_time,
    priority || 'Medium'
  );
  res.json({ id: Number(result.lastInsertRowid) });
});

app.get('/api/reminders', requireAuth, (req, res) => {
  const reminders = getRemindersByUser.all(req.session.userId);
  res.json(reminders);
});

app.get('/api/reminders/:id', requireAuth, (req, res) => {
  const reminder = getReminderById.get(req.params.id, req.session.userId);
  if (!reminder) return res.status(404).json({ error: 'Not found' });
  res.json(reminder);
});

app.put('/api/reminders/:id', requireAuth, (req, res) => {
  const existing = getReminderById.get(req.params.id, req.session.userId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { title, description, subject, due_date, due_time, priority } = req.body;
  updateReminder.run(
    title || existing.title,
    description !== undefined ? description : existing.description,
    subject !== undefined ? subject : existing.subject,
    due_date || existing.due_date,
    due_time || existing.due_time,
    priority || existing.priority,
    req.params.id,
    req.session.userId
  );
  res.json({ success: true });
});

app.put('/api/reminders/:id/complete', requireAuth, (req, res) => {
  completeReminder.run('Completed', req.params.id, req.session.userId);
  res.json({ success: true });
});

app.put('/api/reminders/:id/reopen', requireAuth, (req, res) => {
  completeReminder.run('Pending', req.params.id, req.session.userId);
  res.json({ success: true });
});

app.delete('/api/reminders/:id', requireAuth, (req, res) => {
  deleteReminder.run(req.params.id, req.session.userId);
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
