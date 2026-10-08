# CampusPulse — Student Reminder App

A focused web app for students to track homework, exams, and study sessions.

## Features

- Register / login with hashed passwords (bcrypt)
- Create, edit, complete, reopen, and delete reminders
- Priority levels, due dates, search, and filters
- Dashboard stats: pending, overdue, due today, completed
- In-app toasts plus optional browser notifications

## Run

```bash
npm install
npm start
```

Open http://localhost:3000

Requires Node.js 22.5 or newer (the app uses the built-in `node:sqlite` module).

## Troubleshooting login / signup

- Login and signup need the server to be running — the pages talk to the API
  on the same origin. If a form does nothing or shows "Could not reach the
  CampusPulse server", run `npm start` and open http://localhost:3000
  (the HTML files in the repo root are not a standalone app).
- If signup says "Email already exists", that email is already registered —
  use the login form (or a different email).
- Passwords must be at least 6 characters.
