// Check authentication and load reminders
window.onload = async function() {
    // Fetch current user
    const userRes = await fetch('/api/user');
    if (!userRes.ok) {
        window.location.href = 'index.html';
        return;
    }
    const user = await userRes.json();
    document.getElementById('userName').innerText = user.name;

    // Load reminders
    loadReminders();

    // Setup logout
    document.getElementById('logoutBtn').onclick = async function() {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = 'index.html';
    };

    // Start notification polling (every 60 seconds)
    checkDueReminders();
    setInterval(checkDueReminders, 60000);
};

async function loadReminders() {
    const res = await fetch('/api/reminders');
    const reminders = await res.json();
    const list = document.getElementById('reminderList');
    list.innerHTML = '';

    if (reminders.length === 0) {
        list.innerHTML = '<p>No reminders yet. Add one!</p>';
        return;
    }

    reminders.forEach(r => {
        const item = document.createElement('div');
        item.className = `reminder-item priority-${r.priority} ${r.status === 'Completed' ? 'completed' : ''}`;
        item.innerHTML = `
            <h3>${r.title}</h3>
            <p><strong>Subject:</strong> ${r.subject}</p>
            <p><strong>Due:</strong> ${r.due_date} at ${r.due_time}</p>
            <p><strong>Priority:</strong> ${r.priority}</p>
            <p><strong>Status:</strong> ${r.status}</p>
            ${r.status === 'Pending' ? `<button class="complete-btn" data-id="${r.id}">✔ Mark Completed</button>` : ''}
            <button class="delete-btn" data-id="${r.id}">🗑 Delete</button>
        `;
        list.appendChild(item);
    });

    // Attach event listeners to complete buttons
    document.querySelectorAll('.complete-btn').forEach(btn => {
        btn.onclick = async function() {
            const id = this.dataset.id;
            await fetch(`/api/reminders/${id}/complete`, { method: 'PUT' });
            loadReminders();
        };
    });

    // Attach delete buttons
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.onclick = async function() {
            const id = this.dataset.id;
            await fetch(`/api/reminders/${id}`, { method: 'DELETE' });
            loadReminders();
        };
    });
}

// Notification system: check for reminders due within next 5 minutes
async function checkDueReminders() {
    const res = await fetch('/api/reminders');
    const reminders = await res.json();
    const now = new Date();
    
    reminders.filter(r => r.status === 'Pending').forEach(r => {
        const dueDateTime = new Date(`${r.due_date}T${r.due_time}`);
        const diffMs = dueDateTime - now;
        const diffMin = Math.round(diffMs / 60000);
        
        // Notify if due in 5 minutes or less (and not past)
        if (diffMin <= 5 && diffMin >= 0) {
            showNotification(r.title, `Due in ${diffMin} minute(s)!`);
        }
    });
}

// Request notification permission and show alert
async function showNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            new Notification(title, { body });
        }
    } else {
        // Fallback to alert if notifications denied
        alert(`🔔 ${title}: ${body}`);
    }
}

// Request notification permission on page load
if (Notification && Notification.permission === 'default') {
    Notification.requestPermission();
}