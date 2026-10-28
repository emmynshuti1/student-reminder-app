/* CampusPulse front-end. Plain JS, no build step. Scheduling logic lives in
   /lib/schedule.js (window.Schedule) so it can be shared with the server. */
const S = window.Schedule;
const TOKEN_KEY = 'campuspulse_token';
const THEME_KEY = 'campuspulse_theme';
const SEEN_KEY = 'campuspulse_seen_notifs';
const BELL_SEEN_KEY = 'campuspulse_bell_seen';
const BANNER_KEY = 'campuspulse_banner_dismissed';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const VIEWS = {
  dashboard: 'Dashboard', tasks: 'Tasks', calendar: 'Calendar',
  timetable: 'Timetable', planner: 'Study planner', settings: 'Settings'
};

const state = {
  user: null,
  reminders: [],
  settings: { study: Object.assign({}, S.DEFAULT_STUDY_PREFS) },
  view: 'dashboard',
  calMode: 'week',
  calDate: S.ymd(new Date()),
  plan: null
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- storage

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (_) { /* storage unavailable (private mode) — not fatal */ }
  return null;
}

function token() { return store(TOKEN_KEY) || ''; }
function setToken(t) { store(TOKEN_KEY, t || null); }

// ---------------------------------------------------------------- api

async function api(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (token()) headers.Authorization = 'Bearer ' + token();
  let res;
  try {
    res = await fetch(path, Object.assign({}, options, { headers, credentials: 'include' }));
  } catch (networkErr) {
    throw new Error('Could not reach the CampusPulse server. Make sure it is running (npm start), then reload this page.');
  }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && state.user && !path.startsWith('/api/login')) {
    signedOut('Your session expired. Please log in again.');
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------- helpers

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function icon(name) {
  return `<svg class="ic"><use href="#i-${name}"/></svg>`;
}

function fmtTime(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtDay(dateStr, opts) {
  const today = S.ymd(new Date());
  if (dateStr === today) return 'Today';
  if (dateStr === S.addDays(today, 1)) return 'Tomorrow';
  if (dateStr === S.addDays(today, -1)) return 'Yesterday';
  const d = S.toDate(dateStr, '12:00');
  const o = Object.assign({ weekday: 'short', day: 'numeric', month: 'short' }, opts || {});
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString(undefined, o);
}

function fmtWhen(dateStr, timeStr) {
  return `${fmtDay(dateStr)}, ${fmtTime(S.toDate(dateStr, timeStr))}`;
}

function fmtDuration(mins) {
  mins = Number(mins) || 0;
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function fmtLead(mins) {
  if (mins === 0) return 'at the time';
  if (mins % 1440 === 0) return `${mins / 1440} day${mins === 1440 ? '' : 's'} before`;
  if (mins % 60 === 0) return `${mins / 60} h before`;
  return `${mins} min before`;
}

function recurrenceText(r) {
  const n = Number(r.recur_interval) || 1;
  let t;
  switch (r.recurrence) {
    case 'daily': t = 'Daily'; break;
    case 'weekdays': t = 'Weekdays'; break;
    case 'weekly': {
      const days = S.parseDays(r.recur_days);
      const names = WEEK_ORDER.filter((d) => days.includes(d)).map((d) => DOW[d]).join(', ');
      t = (n > 1 ? `Every ${n} weeks` : 'Weekly') + (names ? ` on ${names}` : '');
      break;
    }
    case 'monthly': t = n > 1 ? `Every ${n} months` : 'Monthly'; break;
    case 'interval': t = `Every ${n} days`; break;
    default: return '';
  }
  if (r.recur_until) t += ` until ${fmtDay(r.recur_until)}`;
  return t;
}

function byId(id) {
  return state.reminders.find((r) => String(r.id) === String(id));
}

function subjects() {
  return [...new Set(state.reminders.map((r) => (r.subject || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' error' : '');
  el.innerHTML = `<span>${escapeHtml(msg)}</span>`;
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action.label;
    b.onclick = () => { el.remove(); opts.action.run(); };
    el.appendChild(b);
  }
  if (opts.dismissible) {
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '✕';
    x.onclick = () => el.remove();
    el.appendChild(x);
  }
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.duration || (opts.action ? 7000 : 3500));
}

function empty(title, text) {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(text || '')}</div>`;
}

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  store(THEME_KEY, theme === 'system' ? null : theme);
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === (theme || 'system')));
  const dark = effectiveDark();
  $('themeBtn').innerHTML = `${icon(dark ? 'sun' : 'moon')}<span>${dark ? 'Light mode' : 'Dark mode'}</span>`;
}

function effectiveDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === 'dark';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// ---------------------------------------------------------------- pages / routing

function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $('page-' + name).classList.add('active');
}

function route() {
  if (!state.user) {
    showPage(location.hash === '#register' ? 'register' : 'login');
    return;
  }
  const m = location.hash.match(/^#\/(\w+)/);
  const view = m && VIEWS[m[1]] ? m[1] : 'dashboard';
  if (!m || !VIEWS[m[1]]) history.replaceState(null, '', '#/' + view);
  state.view = view;
  showPage('app');
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  $('viewTitle').textContent = view === 'dashboard' ? greeting() : VIEWS[view];
  render();
}

function greeting() {
  const h = new Date().getHours();
  const first = (state.user.name || '').split(' ')[0];
  return `${h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'}, ${first}`;
}

function render() {
  const view = state.view;
  try {
    renderNavBadge();
    if (view === 'dashboard') renderDashboard();
    else if (view === 'tasks') renderTasks();
    else if (view === 'calendar') renderCalendar();
    else if (view === 'timetable') renderTimetable();
    else if (view === 'planner') renderPlanner();
    else if (view === 'settings') renderSettings();
  } catch (err) {
    console.error(err);
    toast('Something went wrong while displaying this page.', { error: true });
  }
}

function renderNavBadge() {
  const n = state.reminders.filter((r) => S.isOverdue(r)).length;
  const b = $('navOverdue');
  b.hidden = !n;
  b.textContent = n;
}

// ---------------------------------------------------------------- auth

async function enterApp(user) {
  state.user = user;
  $('sideUser').textContent = user.name;
  $('accountLine').textContent = `Signed in as ${user.name} (${user.email}).`;
  if (!/^#\//.test(location.hash)) history.replaceState(null, '', '#/dashboard');
  showPage('app');
  await loadAll();
  route();
  updateBanner();
  checkNotifications();
  refreshBellDot();
}

function signedOut(message) {
  state.user = null;
  state.reminders = [];
  setToken('');
  if ($('reminderDialog').open) $('reminderDialog').close();
  history.replaceState(null, '', '#login');
  route();
  if (message) $('loginError').textContent = message;
}

async function loadAll() {
  const [reminders, settings] = await Promise.all([api('/api/reminders'), api('/api/settings')]);
  state.reminders = reminders;
  state.settings = settings;
}

async function reload() {
  try {
    state.reminders = await api('/api/reminders');
    state.plan = null;
    render();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function bindAuth() {
  async function submit(form, errEl, path, body) {
    const btn = form.querySelector('button[type="submit"]');
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const data = await api(path, { method: 'POST', body: JSON.stringify(body()) });
      setToken(data.token);
      form.reset();
      await enterApp(data.user);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('loginForm').onsubmit = (e) => {
    e.preventDefault();
    if (!$('loginEmail').value.trim() || !$('loginPassword').value) {
      $('loginError').textContent = 'Enter your email and password.';
      return;
    }
    submit(e.target, $('loginError'), '/api/login', () => ({ email: $('loginEmail').value, password: $('loginPassword').value }));
  };
  $('registerForm').onsubmit = (e) => {
    e.preventDefault();
    if (!$('regName').value.trim() || !$('regEmail').value.trim()) {
      $('regError').textContent = 'Name and email are required.';
      return;
    }
    if ($('regPassword').value.length < 6) {
      $('regError').textContent = 'Password must be at least 6 characters.';
      return;
    }
    submit(e.target, $('regError'), '/api/register', () => ({ name: $('regName').value, email: $('regEmail').value, password: $('regPassword').value }));
  };
  $('logoutBtn').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
    signedOut();
  };
}

// ---------------------------------------------------------------- reminder cards & actions

function card(r, opts = {}) {
  const now = new Date();
  const u = S.urgency(r, now);
  const done = r.status === 'Completed';
  const overdue = S.isOverdue(r, now);
  const completable = S.isCompletable(r);
  const rec = recurrenceText(r);
  const date = opts.date || r.due_date;
  const start = S.toDate(date, r.due_time);
  const timeText = r.duration_minutes > 0
    ? `${fmtDay(date)}, ${fmtTime(start)}–${fmtTime(new Date(start.getTime() + r.duration_minutes * 60000))}`
    : `${fmtDay(date)}, ${fmtTime(start)}`;
  const tags = [`<span class="tag cat">${escapeHtml(r.category)}</span>`];
  if (r.priority && completable) tags.push(`<span class="tag ${escapeHtml(r.priority)}">${escapeHtml(r.priority)}</span>`);
  if (!done && completable && (u.level === 'critical' || u.level === 'high')) {
    tags.push(`<span class="tag ${overdue ? 'overdue' : u.level}">${escapeHtml(u.label)}</span>`);
  }
  const actions = [];
  if (!done && completable) {
    actions.push(S.isRecurring(r)
      ? `<button class="icon-btn" data-act="skip" data-id="${r.id}" title="Skip this occurrence">${icon('skip')}</button>`
      : `<button class="icon-btn" data-act="postpone" data-id="${r.id}" title="Postpone one day">${icon('later')}</button>`);
  }
  actions.push(`<button class="icon-btn" data-act="edit" data-id="${r.id}" title="Edit">${icon('edit')}</button>`);
  actions.push(`<button class="icon-btn" data-act="del" data-id="${r.id}" title="Delete">${icon('trash')}</button>`);
  const check = completable
    ? `<button class="check ${done ? 'on' : ''}" data-act="${done ? 'reopen' : 'done'}" data-id="${r.id}" title="${done ? 'Mark as not done' : 'Mark as done'}" aria-label="${done ? 'Mark as not done' : 'Mark as done'}">${icon('check')}</button>`
    : '<span class="check-spacer"></span>';
  return `<div class="card cat-${escapeHtml(r.category)} ${done ? 'done' : ''} ${u.level === 'critical' && !done ? 'critical' : ''}">
    ${check}
    <div>
      <div class="card-title" data-act="edit" data-id="${r.id}">${escapeHtml(r.title)}</div>
      <div class="card-meta">
        ${tags.join('')}
        <span>${icon('clock')}${escapeHtml(timeText)}</span>
        ${r.subject ? `<span>${icon('book')}${escapeHtml(r.subject)}</span>` : ''}
        ${r.location ? `<span>${icon('pin')}${escapeHtml(r.location)}</span>` : ''}
        ${rec ? `<span>${icon('repeat')}${escapeHtml(rec)}</span>` : ''}
      </div>
      ${opts.notes && r.description ? `<div class="card-notes">${escapeHtml(r.description)}</div>` : ''}
    </div>
    <div class="card-actions">${actions.join('')}</div>
  </div>`;
}

async function runAction(act, id) {
  const r = byId(id);
  if (!r) return;
  try {
    if (act === 'edit') return openForm(r);
    if (act === 'done') {
      const res = await api(`/api/reminders/${id}/complete`, { method: 'PUT' });
      toast(res.advanced ? `Done! Next: ${fmtWhen(res.next_date, r.due_time)}` : `Completed “${r.title}”`, {
        action: res.advanced ? null : { label: 'Undo', run: () => runAction('reopen', id) }
      });
    } else if (act === 'reopen') {
      await api(`/api/reminders/${id}/reopen`, { method: 'PUT' });
    } else if (act === 'skip') {
      const res = await api(`/api/reminders/${id}/skip`, { method: 'PUT' });
      toast(`Skipped. Next: ${fmtWhen(res.next_date, r.due_time)}`);
    } else if (act === 'postpone') {
      const base = S.isOverdue(r) && r.due_date < S.ymd(new Date()) ? S.ymd(new Date()) : r.due_date;
      const next = S.addDays(base, 1);
      await api(`/api/reminders/${id}`, { method: 'PUT', body: JSON.stringify({ due_date: next }) });
      toast(`Moved to ${fmtWhen(next, r.due_time)}`, {
        action: { label: 'Undo', run: async () => { await api(`/api/reminders/${id}`, { method: 'PUT', body: JSON.stringify({ due_date: r.due_date }) }); reload(); } }
      });
    } else if (act === 'del') {
      if (!confirm(`Delete “${r.title}”${S.isRecurring(r) ? ' and all its repeats' : ''}?`)) return;
      await api(`/api/reminders/${id}`, { method: 'DELETE' });
      if ($('reminderDialog').open) $('reminderDialog').close();
      const copy = Object.assign({}, r);
      toast(`Deleted “${r.title}”`, {
        action: { label: 'Undo', run: async () => {
          try {
            const res = await api('/api/reminders', { method: 'POST', body: JSON.stringify(copy) });
            if (copy.status === 'Completed') await api(`/api/reminders/${res.id}/complete`, { method: 'PUT' });
            reload();
          } catch (err) { toast(err.message, { error: true }); }
        } }
      });
    }
    await reload();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  e.stopPropagation();
  runAction(el.dataset.act, el.dataset.id);
});

// ---------------------------------------------------------------- dashboard

function renderDashboard() {
  const now = new Date();
  const today = S.ymd(now);
  const rs = state.reminders;
  $('viewSubtitle').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('todayLabel').textContent = '';

  const overdue = rs.filter((r) => S.isOverdue(r, now));
  const todayDue = rs.filter((r) => r.status === 'Pending' && S.isCompletable(r) && r.due_date === today && !S.isOverdue(r, now));
  const week = rs.filter((r) => r.status === 'Pending' && S.isDeadline(r) && r.due_date > today && r.due_date <= S.addDays(today, 7));
  const weekAgo = new Date(now.getTime() - 7 * 864e5);
  const completedWeek = rs.filter((r) => r.completed_at && new Date(r.completed_at) >= weekAgo);
  const studyMins = S.expandAll(rs, today, S.addDays(today, 6)).filter((o) => o.reminder.category === 'Study').reduce((s, o) => s + o.duration, 0);
  $('stats').innerHTML = [
    ['Overdue', overdue.length, overdue.length ? 'danger' : '', '#/tasks?status=Overdue'],
    ['Due today', todayDue.length, '', '#/tasks?when=today'],
    ['Deadlines this week', week.length, '', '#/tasks?when=week'],
    ['Completed (7 days)', completedWeek.length, 'ok', '#/tasks?status=Completed'],
    ['Study planned (7 days)', fmtDuration(studyMins), '', '#/planner']
  ].map(([label, value, cls, href]) => `<button type="button" class="stat ${cls}" data-href="${href}"><strong>${escapeHtml(value)}</strong><span>${label}</span></button>`).join('');
  $('stats').querySelectorAll('.stat').forEach((b) => { b.onclick = () => navigate(b.dataset.href); });

  // Today's schedule: overdue first, then every occurrence today in time order.
  const occs = S.expandAll(rs, today, today, { includeCompleted: true });
  let html = '';
  if (overdue.length) {
    html += '<div class="group-title">Overdue</div>' + overdue.sort((a, b) => S.toDate(a.due_date, a.due_time) - S.toDate(b.due_date, b.due_time)).slice(0, 5).map((r) => card(r)).join('');
    if (overdue.length > 5) html += `<p class="small"><a href="#/tasks?status=Overdue">+${overdue.length - 5} more overdue</a></p>`;
  }
  if (occs.length) {
    html += (overdue.length ? '<div class="group-title">Schedule</div>' : '') + '<div class="timeline">' + occs.map((o) => {
      const r = o.reminder;
      const past = (o.duration ? o.end : o.start) < now;
      const current = o.duration && o.start <= now && o.end > now;
      return `<div class="tl-item ${past ? 'past' : ''} ${current ? 'now' : ''}">
        <div class="tl-time">${fmtTime(o.start)}${o.duration ? `<small>${fmtTime(o.end)}</small>` : '<small>due</small>'}</div>
        ${card(r, { date: o.date })}
      </div>`;
    }).join('') + '</div>';
  }
  $('todayList').innerHTML = html || empty('Nothing scheduled today', 'Enjoy the free time — or plan a study session.');

  $('insightList').innerHTML = renderInsights(S.insights(rs, now));

  const upcoming = rs
    .filter((r) => r.status === 'Pending' && S.isCompletable(r) && r.category !== 'Study' && !S.isOverdue(r, now) && r.due_date <= S.addDays(today, 14))
    .sort((a, b) => S.toDate(a.due_date, a.due_time) - S.toDate(b.due_date, b.due_time))
    .slice(0, 8);
  $('upcomingList').innerHTML = upcoming.length ? upcoming.map((r) => card(r)).join('') : empty('No deadlines in the next two weeks', 'Add assignments and exams to see them here.');

  const next = [];
  for (const o of S.expandAll(rs, today, S.addDays(today, 8))) {
    const lead = Number(o.reminder.remind_before);
    if (lead < 0) continue;
    const fireAt = new Date(o.start.getTime() - lead * 60000);
    if (fireAt > now) next.push({ o, fireAt });
  }
  next.sort((a, b) => a.fireAt - b.fireAt);
  $('nextReminders').innerHTML = next.length
    ? next.slice(0, 6).map(({ o, fireAt }) => `<div class="mini-row"><span><a data-act="edit" data-id="${o.reminder.id}">${escapeHtml(o.reminder.title)}</a></span><span>${escapeHtml(fmtWhen(S.ymd(fireAt), S.hm(fireAt)))}</span></div>`).join('')
      + `<p class="muted small" style="margin-top:8px">${notificationStatusText()}</p>`
    : empty('No reminders scheduled', 'Set “Remind me” when adding an item.');

  const done = rs.filter((r) => r.status === 'Completed').sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || ''))).slice(0, 6);
  $('doneList').innerHTML = done.length ? done.map((r) => card(r)).join('') : empty('Nothing completed yet', 'Tick off a task and it will show up here.');
}

function renderInsights(list) {
  if (!list.length) return empty('All clear', 'No clashes, overdue work or urgent deadlines. Nice!');
  const iconFor = { overdue: 'alert', conflict: 'alert', prep: 'spark', urgent: 'clock', heavy: 'calendar' };
  return list.slice(0, 7).map((i) => `<div class="insight ${i.severity}">
    ${icon(iconFor[i.type] || 'spark')}
    <div><strong>${escapeHtml(i.title)}</strong><p>${escapeHtml(i.detail)}</p>
    ${i.action === 'planner' ? '<a href="#/planner">Open planner →</a>' : i.type === 'overdue' ? '<a href="#/tasks?status=Overdue">Review overdue →</a>' : i.ids && i.ids[0] ? `<a data-act="edit" data-id="${i.ids[0]}">Open →</a>` : ''}</div>
  </div>`).join('');
}

function navigate(href) {
  location.hash = href.slice(1);
}

// ---------------------------------------------------------------- tasks

function applyQueryToFilters() {
  const q = (location.hash.split('?')[1] || '');
  if (!q) return;
  const params = new URLSearchParams(q);
  if (params.get('status')) $('filterStatus').value = params.get('status');
  if (params.get('when')) $('filterWhen').value = params.get('when');
  if (params.get('status') || params.get('when')) {
    $('filterCategory').value = 'all';
    $('filterSubject').value = 'all';
    $('filterPriority').value = 'all';
    $('search').value = '';
  }
  history.replaceState(null, '', '#/tasks');
}

function fillSelect(sel, values, allLabel) {
  const current = sel.value;
  sel.innerHTML = `<option value="all">${allLabel}</option>` + values.map((v) => `<option>${escapeHtml(v)}</option>`).join('');
  sel.value = values.includes(current) ? current : 'all';
}

function renderTasks() {
  fillSelect($('filterCategory'), S.CATEGORIES, 'All categories');
  fillSelect($('filterSubject'), subjects(), 'All subjects');
  applyQueryToFilters();
  const now = new Date();
  const today = S.ymd(now);
  const q = $('search').value.trim().toLowerCase();
  const status = $('filterStatus').value;
  const cat = $('filterCategory').value;
  const subj = $('filterSubject').value;
  const pri = $('filterPriority').value;
  const when = $('filterWhen').value;
  const group = $('groupBy').value;
  $('viewSubtitle').textContent = 'Assignments, exams, projects and everything else with a deadline.';

  let items = state.reminders.filter((r) => {
    if (cat === 'all' && r.category === 'Class' && status !== 'all') return false;
    if (cat !== 'all' && r.category !== cat) return false;
    if (subj !== 'all' && (r.subject || '') !== subj) return false;
    if (pri !== 'all' && r.priority !== pri) return false;
    if (status === 'open' && r.status !== 'Pending') return false;
    if (status === 'Completed' && r.status !== 'Completed') return false;
    if (status === 'Overdue' && !S.isOverdue(r, now)) return false;
    if (when === 'today' && r.due_date !== today) return false;
    if (when === 'week' && (r.due_date < today || r.due_date > S.addDays(today, 7))) return false;
    if (when === 'month' && (r.due_date < today || r.due_date > S.addDays(today, 30))) return false;
    if (when === 'past' && r.due_date >= today) return false;
    if (q && ![r.title, r.subject, r.description, r.location, r.category].some((f) => (f || '').toLowerCase().includes(q))) return false;
    return true;
  });
  const due = (r) => S.toDate(r.due_date, r.due_time);
  items.sort((a, b) => due(a) - due(b));
  $('resultCount').textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

  if (!items.length) {
    $('reminderList').innerHTML = state.reminders.length
      ? empty('No matches', 'Try a different search or clear some filters.')
      : empty('No reminders yet', 'Press “New” to add your first assignment, exam or class.');
    return;
  }

  let groups;
  if (group === 'urgency') {
    items.sort((a, b) => S.urgency(b, now).score - S.urgency(a, now).score || due(a) - due(b));
    groups = [['By urgency', items]];
  } else {
    const keyFn = {
      subject: (r) => r.subject || 'No subject',
      priority: (r) => r.priority,
      category: (r) => r.category,
      date: (r) => {
        if (r.status === 'Completed') return 'Completed';
        if (S.isOverdue(r, now)) return 'Overdue';
        if (r.due_date === today) return 'Today';
        if (r.due_date === S.addDays(today, 1)) return 'Tomorrow';
        if (r.due_date <= S.addDays(today, 7)) return 'Next 7 days';
        if (r.due_date < today) return 'Earlier';
        return 'Later';
      }
    }[group];
    const order = {
      date: ['Overdue', 'Today', 'Tomorrow', 'Next 7 days', 'Later', 'Earlier', 'Completed'],
      priority: S.PRIORITIES,
      category: S.CATEGORIES
    }[group];
    const map = new Map();
    for (const r of items) {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    groups = [...map.entries()].sort((a, b) => order ? order.indexOf(a[0]) - order.indexOf(b[0]) : a[0].localeCompare(b[0]));
  }
  $('reminderList').innerHTML = groups.map(([name, list]) =>
    `<div class="group-title">${escapeHtml(name)} · ${list.length}</div>` + list.map((r) => card(r, { notes: true })).join('')
  ).join('');
}

// ---------------------------------------------------------------- calendar

function mondayOf(dateStr) {
  const wd = S.weekday(dateStr);
  return S.addDays(dateStr, -((wd + 6) % 7));
}

function renderCalendar() {
  $('viewSubtitle').textContent = 'Classes, study sessions and deadlines at a glance. Click a time slot to add something.';
  document.querySelectorAll('#calMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.calMode));
  if (state.calMode === 'month') renderMonth();
  else renderWeek(state.calMode === 'day' ? 1 : 7);
}

function calShift(dir) {
  const d = state.calDate;
  if (state.calMode === 'day') state.calDate = S.addDays(d, dir);
  else if (state.calMode === 'week') state.calDate = S.addDays(d, 7 * dir);
  else {
    const [y, m] = d.split('-').map(Number);
    const nd = new Date(y, m - 1 + dir, 1);
    state.calDate = S.ymd(nd);
  }
  renderCalendar();
}

function renderMonth() {
  const [y, m] = state.calDate.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const start = mondayOf(first);
  const end = S.addDays(start, 41);
  const today = S.ymd(new Date());
  $('calLabel').textContent = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const occs = S.expandAll(state.reminders, start, end, { includeCompleted: true });
  const byDay = {};
  for (const o of occs) (byDay[o.date] = byDay[o.date] || []).push(o);
  let html = '<div class="month">' + WEEK_ORDER.map((d) => `<div class="dow">${DOW[d]}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = S.addDays(start, i);
    const list = byDay[d] || [];
    const cls = [d.slice(5, 7) !== first.slice(5, 7) ? 'other' : '', d === today ? 'today' : ''].join(' ');
    html += `<div class="mcell ${cls}" data-day="${d}"><span class="mday">${Number(d.slice(8))}</span>`
      + list.slice(0, 3).map((o) => chip(o)).join('')
      + (list.length > 3 ? `<div class="more">+${list.length - 3} more</div>` : '')
      + '</div>';
  }
  $('calendarBody').innerHTML = html + '</div>';
  $('calendarBody').querySelectorAll('.mcell').forEach((c) => {
    c.onclick = (e) => {
      if (e.target.closest('[data-act]')) return;
      state.calDate = c.dataset.day;
      state.calMode = 'day';
      renderCalendar();
    };
  });
}

function chip(o) {
  const r = o.reminder;
  return `<span class="chip cat-${escapeHtml(r.category)} ${r.status === 'Completed' ? 'done' : ''}" data-act="edit" data-id="${r.id}" title="${escapeHtml(r.title)} · ${fmtTime(o.start)}">${fmtTime(o.start)} ${escapeHtml(r.title)}</span>`;
}

const HOUR_PX = 48;

function renderWeek(cols) {
  const start = cols === 7 ? mondayOf(state.calDate) : state.calDate;
  const end = S.addDays(start, cols - 1);
  const now = new Date();
  const today = S.ymd(now);
  if (cols === 7) {
    $('calLabel').textContent = `${fmtDay(start, { weekday: undefined })} – ${S.toDate(end, '12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
  } else {
    $('calLabel').textContent = S.toDate(start, '12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  const occs = S.expandAll(state.reminders, start, end, { includeCompleted: true });
  const clashKeys = new Set();
  for (const [a, b] of S.findConflicts(occs.filter((o) => o.reminder.status !== 'Completed'))) { clashKeys.add(a.key); clashKeys.add(b.key); }

  let head = '<div class="wk-head"></div>';
  let body = '<div class="wk-hours">' + Array.from({ length: 24 }, (_, h) => `<div class="wk-hour">${h ? fmtTime(new Date(2000, 0, 1, h)) : ''}</div>`).join('') + '</div>';
  for (let i = 0; i < cols; i++) {
    const d = S.addDays(start, i);
    const dayOccs = occs.filter((o) => o.date === d);
    head += `<div class="wk-head ${d === today ? 'today' : ''}">${escapeHtml(S.toDate(d, '12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }))}</div>`;
    // Lay out overlapping blocks side by side.
    const blocks = dayOccs.map((o) => {
      let top = (o.start.getHours() * 60 + o.start.getMinutes()) / 60 * HOUR_PX;
      const height = o.duration ? Math.max(22, o.duration / 60 * HOUR_PX) : 22;
      top = Math.min(top, 24 * HOUR_PX - height);
      return { o, top, bottom: top + height, height };
    }).sort((a, b) => a.top - b.top);
    const lanesEnd = [];
    for (const b of blocks) {
      let lane = lanesEnd.findIndex((e) => e <= b.top);
      if (lane === -1) { lane = lanesEnd.length; lanesEnd.push(0); }
      lanesEnd[lane] = b.bottom;
      b.lane = lane;
    }
    const lanes = Math.max(1, lanesEnd.length);
    let col = `<div class="wk-col ${d === today ? 'today' : ''}" data-day="${d}" style="height:${24 * HOUR_PX}px">`;
    for (const b of blocks) {
      const r = b.o.reminder;
      const w = 100 / lanes;
      col += `<div class="ev cat-${escapeHtml(r.category)} ${b.o.duration ? '' : 'point'} ${clashKeys.has(b.o.key) ? 'clash' : ''}" data-act="edit" data-id="${r.id}"
        style="top:${b.top}px;height:${b.height}px;left:calc(${b.lane * w}% + 3px);right:auto;width:calc(${w}% - 6px);${r.status === 'Completed' ? 'opacity:.5;text-decoration:line-through' : ''}"
        title="${escapeHtml(r.title)}${clashKeys.has(b.o.key) ? ' — overlaps another item' : ''}">
        <strong>${escapeHtml(r.title)}</strong>${b.o.duration && b.height > 34 ? `${fmtTime(b.o.start)}–${fmtTime(b.o.end)}${r.location ? ' · ' + escapeHtml(r.location) : ''}` : ''}</div>`;
    }
    if (d === today) col += `<div class="now-line" style="top:${(now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_PX}px"></div>`;
    body += col + '</div>';
  }
  $('calendarBody').innerHTML = `<div class="week" id="weekScroll"><div class="week-grid" style="--cols:${cols}">${head}${body}</div></div>`;
  // Columns start in grid row 2; the hour labels column spans all rows.
  const grid = $('calendarBody').querySelector('.week-grid');
  grid.querySelectorAll('.wk-hours, .wk-col').forEach((el) => { el.style.gridRow = '2'; });
  grid.querySelectorAll('.wk-col').forEach((c) => {
    c.onclick = (e) => {
      if (e.target !== c) return;
      const y = e.offsetY;
      const mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor(y / HOUR_PX * 2) * 30));
      openForm(null, { due_date: c.dataset.day, due_time: S.timeOf(mins), category: 'Study', duration_minutes: 60 });
    };
  });
  const scroll = $('weekScroll');
  const focusHour = start <= today && today <= end ? Math.max(0, now.getHours() - 2) : 7;
  scroll.scrollTop = focusHour * HOUR_PX;
}

// ---------------------------------------------------------------- timetable

function renderTimetable() {
  $('viewSubtitle').textContent = 'Your repeating weekly schedule.';
  const today = S.ymd(new Date());
  const todayWd = S.weekday(today);
  const recurring = state.reminders.filter((r) =>
    S.isRecurring(r) && (r.category === 'Class' || r.category === 'Study' || r.duration_minutes > 0) &&
    (!r.recur_until || r.recur_until >= today));
  const byDay = {};
  const other = [];
  for (const r of recurring) {
    let days;
    if (r.recurrence === 'weekly') days = S.parseDays(r.recur_days);
    else if (r.recurrence === 'weekdays') days = [1, 2, 3, 4, 5];
    else if (r.recurrence === 'daily' && Number(r.recur_interval) === 1) days = [0, 1, 2, 3, 4, 5, 6];
    else { other.push(r); continue; }
    for (const d of days) (byDay[d] = byDay[d] || []).push(r);
  }
  const html = '<div class="tt">' + WEEK_ORDER.map((d) => {
    const list = (byDay[d] || []).sort((a, b) => a.due_time.localeCompare(b.due_time));
    return `<div class="tt-day ${d === todayWd ? 'today' : ''}"><h3>${DOW[d]}</h3>${list.length ? list.map((r) => {
      const start = S.toDate(today, r.due_time);
      const end = new Date(start.getTime() + (r.duration_minutes || 0) * 60000);
      return `<div class="tt-item cat-${escapeHtml(r.category)}" data-act="edit" data-id="${r.id}">
        <strong>${escapeHtml(r.title)}</strong>
        <span>${fmtTime(start)}${r.duration_minutes ? '–' + fmtTime(end) : ''}</span>
        ${r.location ? `<span>${escapeHtml(r.location)}</span>` : ''}
        ${Number(r.recur_interval) > 1 ? `<span>${escapeHtml(recurrenceText(r))}</span>` : ''}
      </div>`;
    }).join('') : '<div class="tt-empty">Free</div>'}</div>`;
  }).join('') + '</div>';
  const extra = other.length ? '<div class="group-title">Other repeating activities</div>' + other.map((r) => card(r)).join('') : '';
  $('timetableBody').innerHTML = recurring.length ? html + extra : empty('Your timetable is empty', 'Add your weekly classes once and CampusPulse will repeat them, warn you about clashes, and plan study time around them.');
}

// ---------------------------------------------------------------- planner

function renderPlanner() {
  $('viewSubtitle').textContent = 'Spread your work out before deadlines instead of cramming.';
  const horizon = Number($('planHorizon').value) || 14;
  const plan = S.planStudy(state.reminders, state.settings.study, new Date(), horizon);
  state.plan = plan;

  $('planTasks').innerHTML = plan.tasks.length ? plan.tasks.map((t) => {
    const total = Math.max(1, t.effort);
    const pct = (v) => Math.min(100, v / total * 100);
    const status = t.shortfall > 0
      ? `<span class="tag overdue">${fmtDuration(t.shortfall)} doesn't fit</span>`
      : t.newlyPlanned ? `<span class="tag Low">+${fmtDuration(t.newlyPlanned)} suggested</span>` : '<span class="tag Low">Fully planned</span>';
    return `<div class="plan-task">
      <div class="row"><div><strong data-act="edit" data-id="${t.id}" style="cursor:pointer">${escapeHtml(t.title)}</strong>
        <div class="card-meta"><span class="tag cat cat-${escapeHtml(t.category)}">${escapeHtml(t.category)}</span><span>${icon('clock')}Due ${escapeHtml(fmtWhen(S.ymd(t.due), S.hm(t.due)))}</span></div></div>
        <div>${status}</div></div>
      <div class="bar"><i class="done" style="width:${pct(t.alreadyPlanned)}%"></i><i class="new" style="width:${pct(t.newlyPlanned)}%"></i><i class="short" style="width:${pct(t.shortfall)}%"></i></div>
      <p class="muted small" style="margin-top:4px">Needs ${fmtDuration(t.effort)}${t.estimated ? ` (default estimate — <a data-act="edit" data-id="${t.id}">set your own</a>)` : ''} · ${fmtDuration(t.alreadyPlanned)} already scheduled</p>
    </div>`;
  }).join('') + (plan.tasks.some((t) => t.shortfall > 0)
    ? '<div class="warn">Some work doesn\'t fit before its deadline. Try longer study hours or more study days in Settings, or start now.</div>' : '')
    : empty('No upcoming deadlines', `Assignments, projects and exams due in the next ${horizon} days will appear here.`);

  if (!plan.sessions.length) {
    $('planSessions').innerHTML = empty(plan.tasks.length ? 'Nothing more to schedule' : 'No suggestions yet', plan.tasks.length ? 'Your upcoming deadlines already have enough study time, or there is no free time left in your study hours.' : '');
    $('acceptPlan').disabled = true;
    return;
  }
  let html = '';
  let lastDay = '';
  plan.sessions.forEach((s, i) => {
    if (s.date !== lastDay) { html += `<div class="plan-day">${escapeHtml(fmtDay(s.date, { weekday: 'long' }))}</div>`; lastDay = s.date; }
    const start = S.toDate(s.date, s.time);
    html += `<label class="plan-session"><input type="checkbox" data-idx="${i}" checked>
      <span><strong>${escapeHtml(s.title.replace(/^Study: /, ''))}</strong><br><span class="muted small">${escapeHtml(s.subject || '')}</span></span>
      <span class="muted small">${fmtTime(start)}–${fmtTime(new Date(start.getTime() + s.duration * 60000))}</span></label>`;
  });
  $('planSessions').innerHTML = html;
  $('acceptPlan').disabled = false;
}

async function acceptPlan() {
  const plan = state.plan;
  if (!plan) return;
  const picked = [...document.querySelectorAll('#planSessions input[type=checkbox]:checked')].map((c) => plan.sessions[Number(c.dataset.idx)]);
  if (!picked.length) return toast('Select at least one session.');
  const btn = $('acceptPlan');
  btn.disabled = true;
  try {
    const items = picked.map((s) => {
      const task = byId(s.taskId);
      return {
        title: s.title, subject: s.subject, category: 'Study', priority: task ? task.priority : 'Medium',
        due_date: s.date, due_time: s.time, duration_minutes: s.duration, remind_before: 10, linked_id: s.taskId,
        description: task ? `Study session for “${task.title}” (due ${fmtWhen(task.due_date, task.due_time)}).` : ''
      };
    });
    const res = await api('/api/reminders/bulk', { method: 'POST', body: JSON.stringify({ items }) });
    toast(`Added ${res.created} study session${res.created === 1 ? '' : 's'} to your calendar${res.skipped ? ` (${res.skipped} already existed)` : ''}.`);
    await reload();
  } catch (err) {
    toast(err.message, { error: true });
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- settings

function dayPicker(container, name, selected) {
  container.innerHTML = WEEK_ORDER.map((d) =>
    `<label><input type="checkbox" name="${name}" value="${d}" ${selected.includes(d) ? 'checked' : ''}>${DOW[d]}</label>`).join('');
}

function renderSettings() {
  $('viewSubtitle').textContent = 'Appearance, notifications, study preferences and backups.';
  applyTheme(store(THEME_KEY) || 'system');
  $('permState').textContent = notificationStatusText();
  $('permBtn').hidden = !('Notification' in window) || Notification.permission !== 'default';
  const s = state.settings.study;
  $('sWeekdayStart').value = s.weekdayStart;
  $('sWeekdayEnd').value = s.weekdayEnd;
  $('sWeekendStart').value = s.weekendStart;
  $('sWeekendEnd').value = s.weekendEnd;
  setSelect($('sSession'), s.sessionMinutes);
  setSelect($('sMax'), s.maxMinutesPerDay);
  setSelect($('sBreak'), s.breakMinutes);
  dayPicker($('sDays'), 'studyDay', S.parseDays(s.studyDays));
  $('studyError').textContent = '';
}

// Select a value, adding it as an option if it isn't one of the presets.
function setSelect(sel, value) {
  value = String(value);
  if (![...sel.options].some((o) => o.value === value)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = fmtDuration(Number(value));
    sel.appendChild(o);
  }
  sel.value = value;
}

function bindSettings() {
  $('themeSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) applyTheme(b.dataset.theme);
  };
  $('themeBtn').onclick = () => applyTheme(effectiveDark() ? 'light' : 'dark');
  $('permBtn').onclick = requestPermission;
  $('testNotif').onclick = () => {
    showNotification('Test notification', 'Notifications from CampusPulse are working.', null);
    if (!('Notification' in window) || Notification.permission !== 'granted') toast('Browser notifications are off, so alerts will appear inside the app like this one.');
  };
  $('studyForm').onsubmit = async (e) => {
    e.preventDefault();
    $('studyError').textContent = '';
    const study = {
      weekdayStart: $('sWeekdayStart').value, weekdayEnd: $('sWeekdayEnd').value,
      weekendStart: $('sWeekendStart').value, weekendEnd: $('sWeekendEnd').value,
      sessionMinutes: Number($('sSession').value), maxMinutesPerDay: Number($('sMax').value),
      breakMinutes: Number($('sBreak').value),
      studyDays: [...document.querySelectorAll('input[name=studyDay]:checked')].map((c) => Number(c.value))
    };
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ study }) });
      state.plan = null;
      toast('Study preferences saved');
    } catch (err) {
      $('studyError').textContent = err.message;
    }
  };
  $('exportBtn').onclick = async () => {
    try {
      const data = await api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `campuspulse-backup-${S.ymd(new Date())}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  $('importFile').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let data;
      try { data = JSON.parse(await file.text()); } catch (_) { throw new Error('That file is not valid JSON.'); }
      const res = await api('/api/import', { method: 'POST', body: JSON.stringify({ reminders: data.reminders }) });
      toast(`Imported ${res.created} item${res.created === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} duplicate${res.skipped === 1 ? '' : 's'}` : ''}.`);
      await reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}

// ---------------------------------------------------------------- reminder form

const CATEGORY_HINTS = {
  Assignment: { dateLabel: 'Due date', timeLabel: 'Due time', duration: false, effort: true, location: false },
  Exam: { dateLabel: 'Exam date', timeLabel: 'Start time', duration: true, effort: true, location: true, defaultDuration: 120 },
  Project: { dateLabel: 'Due date', timeLabel: 'Due time', duration: false, effort: true, location: false },
  Class: { dateLabel: 'First class', timeLabel: 'Start time', duration: true, effort: false, location: true, defaultDuration: 60 },
  Study: { dateLabel: 'Date', timeLabel: 'Start time', duration: true, effort: false, location: true, defaultDuration: 60 },
  Personal: { dateLabel: 'Date', timeLabel: 'Time', duration: true, effort: false, location: true },
  Other: { dateLabel: 'Date', timeLabel: 'Time', duration: true, effort: false, location: true }
};

let formCategory = 'Assignment';

function setCategory(cat, applyDefaults) {
  formCategory = cat;
  document.querySelectorAll('#categorySeg button').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
  const h = CATEGORY_HINTS[cat];
  $('dateLabel').textContent = h.dateLabel;
  $('timeLabel').textContent = h.timeLabel;
  $('durationField').hidden = !h.duration;
  $('effortField').hidden = !h.effort;
  $('locationField').hidden = !h.location;
  $('priority').closest('div').hidden = cat === 'Class';
  if (applyDefaults) {
    if (!h.duration) $('duration_minutes').value = '0';
    else if (h.defaultDuration && $('duration_minutes').value === '0') setSelect($('duration_minutes'), h.defaultDuration);
    if (cat === 'Class' && $('recurrence').value === 'none') { $('recurrence').value = 'weekly'; syncRecurrence(); }
  }
  updateConflictWarning();
}

function syncRecurrence() {
  const rec = $('recurrence').value;
  $('intervalField').hidden = !['weekly', 'monthly', 'interval'].includes(rec);
  $('daysField').hidden = rec !== 'weekly';
  $('untilField').hidden = rec === 'none';
  $('intervalUnit').textContent = { weekly: 'week(s)', monthly: 'month(s)', interval: 'day(s)' }[rec] || '';
  if (rec === 'weekly' && !document.querySelector('input[name=recurDay]:checked') && S.isValidDate($('due_date').value)) {
    const box = document.querySelector(`input[name=recurDay][value="${S.weekday($('due_date').value)}"]`);
    if (box) box.checked = true;
  }
  updateConflictWarning();
}

function formData() {
  const rec = $('recurrence').value;
  return {
    id: $('editId').value || undefined,
    title: $('title').value.trim(),
    category: formCategory,
    subject: $('subject').value.trim(),
    priority: formCategory === 'Class' ? 'Medium' : $('priority').value,
    due_date: $('due_date').value,
    due_time: $('due_time').value,
    duration_minutes: $('durationField').hidden ? 0 : Number($('duration_minutes').value),
    location: $('locationField').hidden ? '' : $('location').value.trim(),
    est_minutes: $('effortField').hidden ? 0 : Number($('est_minutes').value),
    remind_before: Number($('remind_before').value),
    recurrence: rec,
    recur_interval: rec === 'none' ? 1 : Number($('recur_interval').value) || 1,
    recur_days: rec === 'weekly' ? [...document.querySelectorAll('input[name=recurDay]:checked')].map((c) => Number(c.value)).join(',') : null,
    recur_until: rec === 'none' ? null : ($('recur_until').value || null),
    linked_id: $('linkedId').value ? Number($('linkedId').value) : null,
    description: $('description').value.trim()
  };
}

function validateForm(d) {
  const problems = [];
  if (!d.title) problems.push(['title', 'Give it a title.']);
  if (!S.isValidDate(d.due_date)) problems.push(['due_date', 'Choose a date.']);
  if (!S.isValidTime(d.due_time)) problems.push(['due_time', 'Choose a time.']);
  if (d.recurrence !== 'none' && (!Number.isInteger(d.recur_interval) || d.recur_interval < 1 || d.recur_interval > 365)) problems.push(['recur_interval', 'Repeat interval must be between 1 and 365.']);
  if (d.recur_until && S.isValidDate(d.due_date) && d.recur_until < d.due_date) problems.push(['recur_until', '“Until” must be on or after the start date.']);
  ['title', 'due_date', 'due_time', 'recur_interval', 'recur_until'].forEach((f) => $(f).removeAttribute('aria-invalid'));
  problems.forEach(([f]) => $(f).setAttribute('aria-invalid', 'true'));
  return problems.map((p) => p[1]);
}

function updateConflictWarning() {
  const d = formData();
  const warn = $('conflictWarn');
  const hits = S.conflictsFor(d, state.reminders.filter((r) => r.status !== 'Completed'));
  const notes = [];
  if (hits.length) {
    const h = hits[0];
    notes.push(`Overlaps with “${h.other.reminder.title}” (${fmtWhen(h.other.date, h.other.time)})${hits.length > 1 ? ` and ${hits.length - 1} other item${hits.length > 2 ? 's' : ''}` : ''}.`);
  }
  if (!d.id && S.isValidDate(d.due_date) && S.isValidTime(d.due_time) && d.recurrence === 'none' && S.toDate(d.due_date, d.due_time) < new Date()) {
    notes.push('This date and time is in the past.');
  }
  warn.hidden = !notes.length;
  warn.textContent = notes.join(' ');
}

function openForm(r, defaults) {
  const d = Object.assign({
    title: '', category: 'Assignment', subject: '', priority: 'Medium', due_date: S.ymd(new Date()), due_time: '23:59',
    duration_minutes: 0, location: '', est_minutes: 0, remind_before: 60, recurrence: 'none', recur_interval: 1,
    recur_days: '', recur_until: '', description: '', linked_id: ''
  }, defaults || {}, r || {});
  if (!r && !defaults) {
    // Sensible default: a deadline tomorrow evening.
    d.due_date = S.addDays(S.ymd(new Date()), 1);
  }
  $('formTitle').textContent = r ? 'Edit' : 'New reminder';
  $('editId').value = r ? r.id : '';
  $('linkedId').value = d.linked_id || '';
  $('title').value = d.title;
  $('subject').value = d.subject || '';
  $('priority').value = d.priority || 'Medium';
  $('due_date').value = d.due_date;
  $('due_time').value = String(d.due_time).slice(0, 5);
  setSelect($('duration_minutes'), d.duration_minutes || 0);
  $('location').value = d.location || '';
  setSelect($('est_minutes'), d.est_minutes || 0);
  setSelect($('remind_before'), d.remind_before ?? 60);
  $('recurrence').value = d.recurrence || 'none';
  $('recur_interval').value = d.recur_interval || 1;
  $('recur_until').value = d.recur_until || '';
  $('description').value = d.description || '';
  dayPicker($('recurDays'), 'recurDay', S.parseDays(d.recur_days));
  $('subjectOptions').innerHTML = subjects().map((s) => `<option value="${escapeHtml(s)}">`).join('');
  $('formError').textContent = '';
  $('deleteInForm').hidden = !r;
  $('deleteInForm').dataset.id = r ? r.id : '';
  $('saveBtn').disabled = false;
  syncRecurrence();
  setCategory(d.category, !r);
  validateForm({ title: 'x', due_date: '2000-01-01', due_time: '00:00', recurrence: 'none' });
  $('reminderDialog').showModal();
  setTimeout(() => $('title').focus(), 30);
}

function bindForm() {
  $('categorySeg').innerHTML = S.CATEGORIES.map((c) => `<button type="button" data-cat="${c}">${c}</button>`).join('');
  $('categorySeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) setCategory(b.dataset.cat, true);
  };
  $('recurrence').onchange = syncRecurrence;
  ['due_date', 'due_time', 'duration_minutes', 'recur_interval', 'recur_until'].forEach((id) => $(id).addEventListener('change', updateConflictWarning));
  $('recurDays').addEventListener('change', updateConflictWarning);
  $('closeForm').onclick = $('cancelForm').onclick = () => $('reminderDialog').close();
  $('deleteInForm').onclick = () => runAction('del', $('deleteInForm').dataset.id);
  $('reminderForm').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData();
    const problems = validateForm(d);
    if (problems.length) { $('formError').textContent = problems.join(' '); return; }
    $('formError').textContent = '';
    const btn = $('saveBtn');
    if (btn.disabled) return; // double-submit guard
    btn.disabled = true;
    try {
      if (d.id) await api('/api/reminders/' + d.id, { method: 'PUT', body: JSON.stringify(d) });
      else await api('/api/reminders', { method: 'POST', body: JSON.stringify(d) });
      $('reminderDialog').close();
      toast(d.id ? 'Changes saved' : `Added “${d.title}”`);
      await reload();
    } catch (err) {
      $('formError').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  $('addBtn').onclick = () => openForm(null, state.view === 'calendar' ? { due_date: state.calDate > S.ymd(new Date()) ? state.calDate : S.addDays(S.ymd(new Date()), 1) } : null);
  $('addClassBtn').onclick = () => openForm(null, { category: 'Class', recurrence: 'weekly', due_time: '09:00', duration_minutes: 60, remind_before: 15, due_date: S.ymd(new Date()) });
  $('addStudyBlock').onclick = () => openForm(null, { category: 'Study', recurrence: 'weekly', due_time: '17:00', duration_minutes: 60, remind_before: 10, due_date: S.ymd(new Date()) });
}

// ---------------------------------------------------------------- notifications

function notificationStatusText() {
  if (!('Notification' in window)) return 'This browser does not support system notifications; reminders appear inside the app while it is open.';
  if (Notification.permission === 'granted') return 'Browser notifications are on. They are delivered while CampusPulse is open in a tab.';
  if (Notification.permission === 'denied') return 'Browser notifications are blocked in your browser settings; reminders appear inside the app while it is open.';
  return 'Browser notifications are not enabled yet; reminders appear inside the app while it is open.';
}

function updateBanner() {
  $('notifBanner').hidden = !('Notification' in window) || Notification.permission !== 'default' || store(BANNER_KEY) === '1';
}

async function requestPermission() {
  if (!('Notification' in window)) return;
  try { await Notification.requestPermission(); } catch (_) {}
  updateBanner();
  if (state.view === 'settings') renderSettings();
  if (Notification.permission === 'granted') showNotification('Notifications enabled', 'You will be alerted about upcoming classes and deadlines.', null);
}

function showNotification(title, body, reminderId) {
  // Reminder alerts stay up for a minute so they aren't missed.
  toast(`${title} — ${body}`, reminderId ? { action: { label: 'Open', run: () => { const r = byId(reminderId); if (r) openForm(r); } }, duration: 60000, dismissible: true } : {});
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag: reminderId ? `r${reminderId}` : 'campuspulse', icon: document.querySelector('link[rel=icon]').href });
    n.onclick = () => {
      window.focus();
      const r = reminderId && byId(reminderId);
      if (r) openForm(r);
      n.close();
    };
  } catch (_) { /* some browsers only allow notifications from a service worker */ }
}

function notificationText(ev) {
  const o = ev.occurrence;
  const r = o.reminder;
  const isEvent = o.duration > 0 || r.category === 'Class';
  const when = ev.lead === 0 ? (isEvent ? 'Starting now' : 'Due now') : `${isEvent ? 'Starts' : 'Due'} ${fmtWhen(o.date, o.time)}`;
  const extra = [r.subject, r.location].filter(Boolean).join(' · ');
  return { title: r.title, body: extra ? `${when} · ${extra}` : when };
}

function seenKeys() {
  try { return JSON.parse(store(SEEN_KEY) || '[]'); } catch (_) { return []; }
}

let checking = false;
async function checkNotifications() {
  if (!state.user || checking) return;
  checking = true;
  try {
    const now = new Date();
    const seen = seenKeys();
    const seenSet = new Set(seen);
    const missed = [];
    for (const ev of S.dueNotifications(state.reminders, now)) {
      if (seenSet.has(ev.key)) continue;
      const isMissed = now - ev.fireAt > 10 * 60000;
      const text = notificationText(ev);
      const res = await api('/api/notifications/claim', {
        method: 'POST',
        body: JSON.stringify({ key: ev.key, title: text.title, body: text.body, reminder_id: ev.occurrence.reminder.id, missed: isMissed })
      });
      seen.push(ev.key);
      seenSet.add(ev.key);
      if (!res.claimed) continue; // already shown in another tab/device or before a restart
      if (isMissed) missed.push(text);
      else showNotification(text.title, text.body, ev.occurrence.reminder.id);
    }
    store(SEEN_KEY, JSON.stringify(seen.slice(-500)));
    if (missed.length) {
      toast(`You missed ${missed.length} reminder${missed.length === 1 ? '' : 's'} while CampusPulse was closed.`, { action: { label: 'Show', run: openBell }, duration: 10000 });
    }
    refreshBellDot();
  } catch (_) {
    /* network hiccup — try again on the next tick */
  } finally {
    checking = false;
  }
}

let bellItems = [];
async function refreshBellDot() {
  if (!state.user) return;
  try {
    bellItems = await api('/api/notifications');
    const last = store(BELL_SEEN_KEY) || '';
    $('bellDot').hidden = !bellItems.some((n) => n.fired_at > last);
  } catch (_) {}
}

async function openBell() {
  const panel = $('bellPanel');
  await refreshBellDot();
  $('notifStatus').textContent = 'Notification' in window && Notification.permission === 'granted' ? 'Browser alerts on' : 'In-app only';
  $('notifList').innerHTML = bellItems.length ? bellItems.map((n) => `<div class="notif ${n.missed ? 'missed' : ''}" ${n.reminder_id && byId(n.reminder_id) ? `data-act="edit" data-id="${n.reminder_id}"` : ''}>
      <strong>${escapeHtml(n.title)}</strong><small>${escapeHtml(n.body)}</small><small>${escapeHtml(new Date(n.fired_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</small></div>`).join('')
    : empty('No notifications yet', 'Reminders you receive will be listed here.');
  panel.hidden = false;
  if (bellItems[0]) store(BELL_SEEN_KEY, bellItems[0].fired_at);
  $('bellDot').hidden = true;
}

function bindNotifications() {
  $('bellBtn').onclick = (e) => {
    e.stopPropagation();
    if ($('bellPanel').hidden) openBell(); else $('bellPanel').hidden = true;
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bell-wrap')) $('bellPanel').hidden = true;
  });
  $('enableNotif').onclick = requestPermission;
  $('dismissBanner').onclick = () => { store(BANNER_KEY, '1'); updateBanner(); };
  setInterval(checkNotifications, 30000);
  // Pick up changes made on other devices every few minutes.
  setInterval(async () => {
    if (!state.user || $('reminderDialog').open) return;
    try {
      state.reminders = await api('/api/reminders');
      if (state.view !== 'planner') render();
    } catch (_) {}
  }, 5 * 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) { checkNotifications(); render(); }
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  applyTheme(store(THEME_KEY) || 'system');
  bindAuth();
  bindForm();
  bindSettings();
  bindNotifications();
  ['search', 'filterStatus', 'filterCategory', 'filterSubject', 'filterPriority', 'filterWhen', 'groupBy'].forEach((id) => {
    $(id).addEventListener(id === 'search' ? 'input' : 'change', renderTasks);
  });
  $('calMode').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) { state.calMode = b.dataset.mode; renderCalendar(); }
  };
  $('calPrev').onclick = () => calShift(-1);
  $('calNext').onclick = () => calShift(1);
  $('calToday').onclick = () => { state.calDate = S.ymd(new Date()); renderCalendar(); };
  $('planHorizon').onchange = renderPlanner;
  $('acceptPlan').onclick = acceptPlan;
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store(THEME_KEY) || 'system'));
  }
  window.addEventListener('hashchange', route);
  // Keep the "now" line, overdue flags and today's timeline current.
  setInterval(() => { if (state.user && ['dashboard', 'calendar'].includes(state.view) && !$('reminderDialog').open) render(); }, 60000);

  if (token()) {
    try {
      const user = await api('/api/user');
      await enterApp(user);
      return;
    } catch (_) {
      setToken('');
    }
  }
  route();
}

boot();
