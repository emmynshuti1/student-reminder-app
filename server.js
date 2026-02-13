const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const sqlite = require('node:sqlite');
const path = require('path');

const app = express();
const PORT = 3000;

// Open SQLite database (creates file if not exists)
const db = new sqlite.DatabaseSync('./database.sqlite');

// Create tables
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

// Prepare statements for better performance & security
const insertUser = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)');
const findUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const insertReminder = db.prepare(`
  INSERT INTO reminders (user_id, title, description, subject, due_date, due_time, priority)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getRemindersByUser = db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_date, due_time');
const completeReminder = db.prepare('UPDATE reminders SET status = ? WHERE id = ? AND user_id = ?');
const deleteReminder = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?');

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));

// ---------- API ROUTES ----------
app.post('/api/register', (req, res) => {
    const { name, email, password } = req.body;
    const hash = bcrypt.hashSync(password, 10);
    try {
        insertUser.run(name, email, hash);
        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Email already exists' });
    }
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = findUserByEmail.get(email);
    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.userId = user.id;
        req.session.userName = user.name;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid email or password' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/user', (req, res) => {
    if (req.session.userId) {
        res.json({ id: req.session.userId, name: req.session.userName });
    } else {
        res.status(401).json({ error: 'Not logged in' });
    }
});

app.post('/api/reminders', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const { title, description, subject, due_date, due_time, priority } = req.body;
    const result = insertReminder.run(
        req.session.userId,
        title,
        description || null,
        subject,
        due_date,
        due_time,
        priority || 'Medium'
    );
    res.json({ id: result.lastInsertRowid });
});

app.get('/api/reminders', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    const reminders = getRemindersByUser.all(req.session.userId);
    res.json(reminders);
});

app.put('/api/reminders/:id/complete', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    completeReminder.run('Completed', req.params.id, req.session.userId);
    res.json({ success: true });
});

app.delete('/api/reminders/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
    deleteReminder.run(req.params.id, req.session.userId);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});

const port = process.env.PORT || 3000;
app.listen(3000, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});