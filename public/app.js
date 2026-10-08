const TOKEN_KEY = 'campuspulse_token';

function token() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (token()) headers.Authorization = 'Bearer ' + token();
  const res = await fetch(path, Object.assign({}, options, { headers, credentials: 'include' }));
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const el = document.getElementById('page-' + name);
  if (el) el.classList.add('active');
  if (name === 'login' || name === 'register') location.hash = name;
  else if (name === 'dash') location.hash = 'dashboard';
  else if (name === 'form') location.hash = 'add';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function dueDate(r) {
  return new Date(`${r.due_date}T${(r.due_time || '00:00').slice(0, 5)}`);
}

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isOverdue(r) {
  return r.status === 'Pending' && dueDate(r) < new Date();
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 3200);
}

let reminders = [];

async function boot() {
  document.getElementById('todayLabel').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    document.getElementById('loginError').textContent = '';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('loginEmail').value,
          password: document.getElementById('loginPassword').value
        })
      });
      setToken(data.token);
      await enterApp(data.user);
    } catch (err) {
      document.getElementById('loginError').textContent = err.message;
    }
  };

  document.getElementById('registerForm').onsubmit = async (e) => {
    e.preventDefault();
    document.getElementById('regError').textContent = '';
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('regName').value,
          email: document.getElementById('regEmail').value,
          password: document.getElementById('regPassword').value
        })
      });
      setToken(data.token);
      await enterApp(data.user);
    } catch (err) {
      document.getElementById('regError').textContent = err.message;
    }
  };

  document.getElementById('logoutBtn').onclick = async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
    setToken('');
    showPage('login');
  };

  document.getElementById('addBtn').onclick = () => openForm();
  document.getElementById('cancelForm').onclick = () => showPage('dash');
  document.getElementById('search').oninput = render;
  document.getElementById('filterStatus').onchange = render;
  document.getElementById('filterPriority').onchange = render;

  document.getElementById('reminderForm').onsubmit = async (e) => {
    e.preventDefault();
    document.getElementById('formError').textContent = '';
    const payload = {
      title: document.getElementById('title').value,
      subject: document.getElementById('subject').value,
      description: document.getElementById('description').value,
      due_date: document.getElementById('due_date').value,
      due_time: document.getElementById('due_time').value,
      priority: document.getElementById('priority').value
    };
    const id = document.getElementById('editId').value;
    try {
      if (id) await api('/api/reminders/' + id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/reminders', { method: 'POST', body: JSON.stringify(payload) });
      await loadReminders();
      showPage('dash');
      toast('Reminder saved');
    } catch (err) {
      document.getElementById('formError').textContent = err.message;
    }
  };

  window.addEventListener('hashchange', onHash);

  if (token()) {
    try {
      const user = await api('/api/user');
      await enterApp(user);
      return;
    } catch (_) {
      setToken('');
    }
  }
  onHash();
}

async function enterApp(user) {
  document.getElementById('userName').textContent = user.name;
  await loadReminders();
  showPage('dash');
  checkDue();
}

function onHash() {
  if (token()) return;
  showPage(location.hash === '#register' ? 'register' : 'login');
}

async function loadReminders() {
  reminders = await api('/api/reminders');
  render();
}

function openForm(r) {
  document.getElementById('formTitle').textContent = r ? 'Edit reminder' : 'Add reminder';
  document.getElementById('editId').value = r ? r.id : '';
  document.getElementById('title').value = r ? r.title : '';
  document.getElementById('subject').value = r ? r.subject : '';
  document.getElementById('description').value = r ? (r.description || '') : '';
  document.getElementById('due_date').value = r ? r.due_date : '';
  document.getElementById('due_time').value = r ? String(r.due_time).slice(0, 5) : '';
  document.getElementById('priority').value = r ? r.priority : 'Medium';
  document.getElementById('formError').textContent = '';
  showPage('form');
}

function render() {
  const q = (document.getElementById('search').value || '').toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const priority = document.getElementById('filterPriority').value;
  const pending = reminders.filter((r) => r.status === 'Pending');
  const overdue = reminders.filter(isOverdue);
  const today = reminders.filter((r) => r.status === 'Pending' && r.due_date === ymd(new Date()));
  const done = reminders.filter((r) => r.status === 'Completed');
  document.getElementById('statPending').textContent = pending.length;
  document.getElementById('statOverdue').textContent = overdue.length;
  document.getElementById('statToday').textContent = today.length;
  document.getElementById('statDone').textContent = done.length;

  let items = reminders.slice().sort((a, b) => dueDate(a) - dueDate(b));
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

  const list = document.getElementById('reminderList');
  if (!items.length) {
    list.innerHTML = '<div class="empty">No reminders yet. Add one and stay ahead of class.</div>';
    return;
  }
  list.innerHTML = items.map((r) => {
    const overdueFlag = isOverdue(r);
    const when = dueDate(r).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    return `<div class="item ${escapeHtml(r.priority)} ${r.status === 'Completed' ? 'done' : ''} ${overdueFlag ? 'overdue' : ''}">
      <h3>${escapeHtml(r.title)}</h3>
      <div class="chips">
        <span class="chip">${escapeHtml(r.subject || 'General')}</span>
        <span class="chip">${escapeHtml(r.priority)}</span>
        <span class="chip">${overdueFlag ? 'Overdue' : escapeHtml(r.status)}</span>
      </div>
      <p><strong>Due:</strong> ${escapeHtml(when)}</p>
      ${r.description ? `<p>${escapeHtml(r.description)}</p>` : ''}
      <div class="actions">
        ${r.status === 'Pending'
          ? `<button class="inline ok" data-act="done" data-id="${r.id}">Mark done</button>`
          : `<button class="inline ok" data-act="reopen" data-id="${r.id}">Reopen</button>`}
        <button class="inline secondary" data-act="edit" data-id="${r.id}">Edit</button>
        <button class="inline danger" data-act="del" data-id="${r.id}">Delete</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'edit') {
        openForm(reminders.find((x) => String(x.id) === String(id)));
        return;
      }
      if (act === 'del' && !confirm('Delete this reminder?')) return;
      try {
        if (act === 'done') await api('/api/reminders/' + id + '/complete', { method: 'PUT' });
        if (act === 'reopen') await api('/api/reminders/' + id + '/reopen', { method: 'PUT' });
        if (act === 'del') await api('/api/reminders/' + id, { method: 'DELETE' });
        await loadReminders();
      } catch (err) {
        toast(err.message);
      }
    };
  });
}

const notified = new Set();
async function checkDue() {
  try {
    reminders = await api('/api/reminders');
    render();
    const now = new Date();
    reminders.filter((r) => r.status === 'Pending').forEach((r) => {
      const mins = Math.round((dueDate(r) - now) / 60000);
      const key = r.id + ':' + Math.floor(mins / 5);
      if (mins <= 15 && mins >= 0 && !notified.has(key)) {
        notified.add(key);
        toast(`${r.title}: ${mins === 0 ? 'Due now' : 'Due in ' + mins + ' min'}`);
      }
    });
  } catch (_) {}
}
setInterval(checkDue, 60000);

boot();
