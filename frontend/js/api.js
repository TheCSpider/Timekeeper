// Shared API utilities used by all pages

const API = {
  base: '/api',

  getToken() { return localStorage.getItem('tk_token'); },
  getUser()  { try { return JSON.parse(localStorage.getItem('tk_user')); } catch { return null; } },

  setAuth(token, user) {
    localStorage.setItem('tk_token', token);
    localStorage.setItem('tk_user', JSON.stringify(user));
  },

  clearAuth() {
    localStorage.removeItem('tk_token');
    localStorage.removeItem('tk_user');
  },

  async fetch(path, options = {}) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(this.base + path, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
    });

    if (res.status === 401) {
      this.clearAuth();
      window.location.href = '/';
      return;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  get(path)         { return this.fetch(path); },
  post(path, body)  { return this.fetch(path, { method: 'POST',   body: JSON.stringify(body) }); },
  put(path, body)   { return this.fetch(path, { method: 'PUT',    body: JSON.stringify(body) }); },
  del(path)         { return this.fetch(path, { method: 'DELETE' }); },
};

// ── Toast notifications ────────────────────────────────────────
function showToast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Time formatting ────────────────────────────────────────────
function fmtMins(minutes) {
  if (minutes == null) return '—';
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h > 0) return `${h}h ${rem}m`;
  return `${rem}m`;
}

function fmtMinsExact(minutes) {
  if (minutes == null) return '—';
  const totalSec = Math.max(0, Math.round(minutes * 60));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function fmtDatetime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

// ── Guard: redirect if not logged in / wrong role ──────────────
function requireAuth(role) {
  const user = API.getUser();
  if (!user || !API.getToken()) {
    window.location.href = '/';
    return false;
  }
  if (role && user.role !== role) {
    window.location.href = user.role === 'admin' ? '/admin.html' : '/user.html';
    return false;
  }
  return true;
}

function logout() {
  API.clearAuth();
  window.location.href = '/';
}

// ── Modal helpers ──────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// ── Change password (works for both admin card and user modal) ─
async function changeMyPassword(modalId) {
  const current = document.getElementById('chpw-current').value;
  const newPw   = document.getElementById('chpw-new').value;
  const confirm = document.getElementById('chpw-confirm').value;
  const msgEl   = document.getElementById('chpw-msg');
  msgEl.textContent = '';
  msgEl.className = 'text-sm';

  if (!current || !newPw || !confirm) {
    msgEl.textContent = 'All fields are required.';
    msgEl.className = 'text-sm text-danger';
    return;
  }
  if (newPw !== confirm) {
    msgEl.textContent = 'New passwords do not match.';
    msgEl.className = 'text-sm text-danger';
    return;
  }
  if (newPw.length < 6) {
    msgEl.textContent = 'New password must be at least 6 characters.';
    msgEl.className = 'text-sm text-danger';
    return;
  }
  try {
    await API.post('/auth/change-password', { current_password: current, new_password: newPw });
    showToast('Password changed successfully.', 'success');
    document.getElementById('chpw-current').value = '';
    document.getElementById('chpw-new').value     = '';
    document.getElementById('chpw-confirm').value = '';
    if (modalId) closeModal(modalId);
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'text-sm text-danger';
  }
}

// ── Set datetime-local input to now ───────────────────────────
function nowLocalInput() {
  const now = new Date();
  now.setSeconds(0, 0);
  return now.toISOString().slice(0, 16);
}
