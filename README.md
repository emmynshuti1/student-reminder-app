# CampusPulse — Student Reminder App

A student productivity web app for classes, assignments, exams, study sessions and deadlines.

## Features

- **Dashboard**: today's schedule (overdue items first), upcoming deadlines, the next reminders, recently completed work, and quick stats.
- **Smart insights**: flags overdue work, clashing classes or sessions, exams with no study planned, urgent high-priority deadlines, and days with 3 or more deadlines.
- **Reminders and tasks**: each item has a title, notes, subject, category (Assignment, Exam, Project, Class, Study, Personal, Other), priority, date and time, duration, location, estimated effort, and when to remind you. You can mark items done (with undo), reopen them, edit them, postpone them by a day, skip one occurrence of a repeating item, or delete them (with undo).
- **Recurring items**: daily, every weekday, weekly on chosen days (every N weeks), monthly, or every N days, with an optional end date. Completing a recurring task moves it to its next occurrence.
- **Timetable**: a weekly view of repeating classes and study blocks.
- **Calendar**: month, week and day views. Clashes are outlined, and clicking a time slot creates an item there.
- **Study planner**: suggests study sessions before each deadline. It uses your study hours, works around classes and existing sessions, schedules at most one session per task per day, and warns when the work won't fit. Add the suggestions to your calendar in one click.
- **Search and filters**: search by text, and filter by status, category, subject, priority or date range. Group results by date, subject, priority or category, or sort by urgency.
- **Notifications**: see [How notifications work](#how-notifications-work) below.
- **Data safety**:
  - Server-side validation and duplicate protection.
  - Database schema upgrades only add columns, and the database is backed up first.
  - JSON backup export and import (import skips duplicates).
- **Themes and layout**: light, dark or system theme, and a responsive layout with bottom navigation on phones.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000. This needs Node.js 22.5 or newer, because the app uses the built-in `node:sqlite` module.

Optional environment variables:

- `PORT`: the port to listen on (default 3000).
- `DB_PATH`: where the SQLite file is stored (default `./database.sqlite`).
- `SESSION_SECRET`: set this in any shared deployment.

## Test

```bash
npm test
```

This runs the unit tests for the scheduling engine (`public/lib/schedule.js`) and the API tests. The API tests use a temporary database, so your data is never touched.

## How notifications work

- CampusPulse checks your reminders every 30 seconds while the app is open in a browser tab. The tab can be in the background.
- If you allow browser notifications, you get a system notification. You always get an in-app alert.
- Each alert is recorded on the server. Reloading the page, restarting the server or opening a second tab never shows the same alert twice.
- Alerts that came due while the app was closed (up to 24 hours back) are listed under the bell as "missed" the next time you open it.
- **There are no alerts while the browser or tab is closed.** That would need Web Push with a service worker, which is not implemented.

## Times and time zones

Dates and times are stored as local wall-clock times ("Mon 09:00") and shown in your device's time zone. Recurrence is calculated on calendar dates, so a weekly 09:00 class stays at 09:00 across daylight-saving changes. If you travel to a different time zone, times are not converted: they keep showing as the local times you entered.

## Project layout

- `server.js`: Express API, SQLite schema and migration, validation.
- `public/index.html`, `public/style.css`, `public/app.js`: the single-page app.
- `public/lib/schedule.js`: recurrence, conflicts, urgency, the study planner and notification timing. The browser and the server share this file.
- `test/`: automated tests (`node:test`).

## Troubleshooting

- **Login and signup do nothing:** they need the server. Run `npm start` and open http://localhost:3000.
- **"Email already exists":** that email is already registered. Log in instead.
- **Passwords:** they must be at least 6 characters.
