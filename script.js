function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function dueDate(r) {
  return new Date(`${r.due_date}T${r.due_time || '00:00'}`);
}

function isOverdue(r) {
  return r.status === 'Pending' && dueDate(r) < new Date();
}

function isToday(r) {
  const d = r.due_date;
  const t = new Date();
  const ymd = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  return d === ymd;
}

function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3500);
}

let allReminders = [];

window.onload = async function() {
  let userRes;
  try {
    userRes = await fetch('/api/user', { credentials: 'same-origin' });
  } catch (networkErr) {
    window.location.href = 'index.html';
    return;
  }
  if (!userRes.ok) {
    window.location.href = 'index.html';
    return;
  }
  const user = await userRes.json();
  document.getElementById('userName').innerText = user.name;
  const todayLabel = document.getElementById('todayLabel');
  if (todayLabel) {
    todayLabel.textContent = new Date().toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }

  document.getElementById('logoutBtn').onclick = async function() {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = 'index.html';
  };

  const search = document.getElementById('search');
  const filterStatus = document.getElementById('filterStatus');
  const filterPriority = document.getElementById('filterPriority');
  [search, filterStatus, filterPriority].forEach((el) => {
    if (el) el.addEventListener('input', renderReminders);
    if (el) el.addEventListener('change', renderReminders);
  });

  await loadReminders();
  checkDueReminders();
  setInterval(checkDueReminders, 60000);
};

async function loadReminders() {
  let res;
  try {
    res = await fetch('/api/reminders', { credentials: 'same-origin' });
  } catch (networkErr) {
    return;
  }
  if (!res.ok) return;
  allReminders = await res.json();
  renderReminders();
}

function renderReminders() {
  const list = document.getElementById('reminderList');
  const q = (document.getElementById('search')?.value || '').toLowerCase();
  const status = document.getElementById('filterStatus')?.value || 'all';
  const priority = document.getElementById('filterPriority')?.value || 'all';

  const pending = allReminders.filter((r) => r.status === 'Pending');
  const overdue = allReminders.filter(isOverdue);
  const today = allReminders.filter((r) => r.status === 'Pending' && isToday(r));
  const done = allReminders.filter((r) => r.status === 'Completed');

  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  set('statPending', pending.length);
  set('statOverdue', overdue.length);
  set('statToday', today.length);
  set('statDone', done.length);

  let items = allReminders.slice().sort((a, b) => dueDate(a) - dueDate(b));
  if (q) {
    items = items.filter((r) =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.subject || '').toLowerCase().includes(q) ||
      (r.description || '').toLowerCase().includes(q)
    );
  }
  if (priority !== 'all') items = items.filter((r) => r.priority === priority);
  if (status === 'Pending') items = items.filter((r) => r.status === 'Pending');
  if (status === 'Completed') items = items.filter((r) => r.status === 'Completed');
  if (status === 'Overdue') items = items.filter(isOverdue);

  if (!items.length) {
    list.innerHTML = '<div class="empty">No reminders match. Add one and stay ahead of class.</div>';
    return;
  }

  list.innerHTML = '';
  items.forEach((r) => {
    const overdueFlag = isOverdue(r);
    const item = document.createElement('div');
    item.className = `reminder-item priority-${r.priority} ${r.status === 'Completed' ? 'completed' : ''} ${overdueFlag ? 'overdue' : ''}`;
    const when = dueDate(r).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    item.innerHTML = `
      <h3>${escapeHtml(r.title)}</h3>
      <div class="meta">
        <span class="chip">${escapeHtml(r.subject || 'General')}</span>
        <span class="chip">${escapeHtml(r.priority)}</span>
        <span class="chip">${overdueFlag ? 'Overdue' : escapeHtml(r.status)}</span>
      </div>
      <p><strong>Due:</strong> ${escapeHtml(when)}</p>
      ${r.description ? `<p>${escapeHtml(r.description)}</p>` : ''}
      <div class="row-actions">
        ${r.status === 'Pending'
          ? `<button class="complete-btn" data-id="${r.id}">Mark done</button>`
          : `<button class="complete-btn" data-reopen="${r.id}">Reopen</button>`}
        <button class="edit-btn" data-edit="${r.id}">Edit</button>
        <button class="delete-btn" data-id="${r.id}">Delete</button>
      </div>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.complete-btn').forEach((btn) => {
    btn.onclick = async function() {
      const id = this.dataset.id || this.dataset.reopen;
      const reopen = Boolean(this.dataset.reopen);
      await fetch(`/api/reminders/${id}/${reopen ? 'reopen' : 'complete'}`, {
        method: 'PUT', credentials: 'same-origin'
      });
      loadReminders();
    };
  });
  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.onclick = async function() {
      if (!confirm('Delete this reminder?')) return;
      await fetch(`/api/reminders/${this.dataset.id}`, {
        method: 'DELETE', credentials: 'same-origin'
      });
      loadReminders();
    };
  });
  list.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.onclick = function() {
      location.href = 'add-reminder.html?id=' + this.dataset.edit;
    };
  });
}

const notified = new Set();

async function checkDueReminders() {
  let res;
  try {
    res = await fetch('/api/reminders', { credentials: 'same-origin' });
  } catch (networkErr) {
    return;
  }
  if (!res.ok) return;
  const reminders = await res.json();
  const now = new Date();
  reminders.filter((r) => r.status === 'Pending').forEach((r) => {
    const dueDateTime = dueDate(r);
    const diffMin = Math.round((dueDateTime - now) / 60000);
    const key = r.id + ':' + Math.floor(diffMin / 5);
    if (diffMin <= 15 && diffMin >= 0 && !notified.has(key)) {
      notified.add(key);
      showNotification(r.title, diffMin === 0 ? 'Due now!' : `Due in ${diffMin} minute(s)`);
    }
  });
}

async function showNotification(title, body) {
  toast(`${title}: ${body}`);
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') new Notification(title, { body });
    }
  } catch (_) { /* notifications optional in preview */ }
}
