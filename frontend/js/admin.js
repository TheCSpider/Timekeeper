// Admin dashboard logic

if (!requireAuth('admin')) throw new Error('not auth');

document.getElementById('header-username').textContent = API.getUser().username;

// ── State ──────────────────────────────────────────────────────
let allUsers       = [];
let allChores      = [];
let allCompletions = [];
let activitySort   = { col: 'submitted_at', dir: 'desc' };

// ── Tab switching ──────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    const tabs = ['dashboard', 'chores', 'settings'];
    b.classList.toggle('active', tabs[i] === name);
  });
  document.querySelectorAll('.tab-pane').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${name}`);
  });

  if (name === 'dashboard') loadDashboard();
  if (name === 'chores')    loadChores();
  if (name === 'settings')  loadSettings();
}

// ── Bootstrap ──────────────────────────────────────────────────
async function init() {
  await loadDashboard();
}

// ── Dashboard ──────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [users, weekly] = await Promise.all([
      API.get('/admin/users'),
      API.get('/admin/weekly-status'),
    ]);
    allUsers = users;
    renderDashboard(weekly);
    populateAwardDropdown(users);
    loadPending();   // refresh pending section in parallel (fire-and-forget)
    loadActivity();  // refresh recent activity in parallel (fire-and-forget)
  } catch (err) {
    showToast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function renderDashboard(weekly) {
  const el = document.getElementById('dashboard-table');
  const users = weekly.filter((u) => u.role !== 'admin');

  if (users.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">👤</div>No regular users yet.</div>';
    return;
  }

  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>User</th>
      <th>Balance</th>
      <th>Mandatory Chores</th>
      <th>Spending</th>
      <th>Actions</th>
    </tr></thead>
    <tbody>
      ${users.map((u) => {
        const blocked = u.spending_blocked && !u.admin_override;
        const isDebt  = u.time_balance_minutes < 0;
        const pct = u.mandatory_total > 0
          ? Math.min(100, Math.round((u.mandatory_completed / Math.max(1, u.mandatory_required)) * 100))
          : 100;
        const barClass = pct >= 100 ? '' : pct > 50 ? ' warn' : ' danger';
        return `<tr>
          <td><strong>${esc(u.username)}</strong></td>
          <td class="font-bold ${isDebt ? 'text-danger' : u.time_balance_minutes === 0 ? '' : 'text-success'}">
            ${isDebt ? '−' + fmtMins(-u.time_balance_minutes) + ' <span class="badge badge-danger text-xs">debt</span>' : fmtMins(u.time_balance_minutes)}
          </td>
          <td>
            ${u.mandatory_total === 0
              ? '<span class="text-muted text-sm">None this week</span>'
              : `<div style="min-width:120px">
                  <div class="progress-wrap" style="margin:.25rem 0">
                    <div class="progress-bar${barClass}" style="width:${pct}%"></div>
                  </div>
                  <span class="text-xs text-muted">${u.mandatory_completed}/${u.mandatory_required} required</span>
                </div>`}
          </td>
          <td>
            ${blocked
              ? '<span class="badge badge-danger">Blocked</span>'
              : u.admin_override
                ? '<span class="badge badge-info">Unblocked (override)</span>'
                : '<span class="badge badge-success">Active</span>'}
          </td>
          <td>
            <div style="display:flex;gap:.375rem;flex-wrap:wrap;">
              ${blocked
                ? `<button class="btn btn-warning btn-xs" onclick="unblockUser(${u.id})">Unblock</button>`
                : ''}
              <button class="btn btn-outline btn-xs" onclick="quickAdjust(${u.id}, '${esc(u.username)}', 'award')">+ Award</button>
              <button class="btn btn-ghost btn-xs text-danger" onclick="quickAdjust(${u.id}, '${esc(u.username)}', 'deduct')">− Deduct</button>
              <button class="btn btn-ghost btn-xs" style="opacity:.6" onclick="deleteUser(${u.id}, '${esc(u.username)}')">Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function populateAwardDropdown(users) {
  const sel = document.getElementById('award-user-id');
  const regularUsers = users.filter((u) => u.role === 'user');
  sel.innerHTML = regularUsers.map((u) =>
    `<option value="${u.id}">${esc(u.username)}</option>`
  ).join('') || '<option value="">No users</option>';
}

// ── Award / Deduct UI toggle ───────────────────────────────────
function updateAdjustUI() {
  const action = document.querySelector('input[name="adjust-action"]:checked')?.value || 'award';
  document.getElementById('adjust-minutes-label').textContent =
    action === 'deduct' ? 'Minutes to deduct' : 'Minutes to award';
  const btn = document.getElementById('adjust-submit-btn');
  if (action === 'deduct') {
    btn.textContent = 'Deduct Time';
    btn.className = 'btn btn-danger';
  } else {
    btn.textContent = 'Award Time';
    btn.className = 'btn btn-success';
  }
  // Highlight selected radio label
  document.getElementById('award-opt').style.borderColor =
    action === 'award' ? 'var(--success)' : 'var(--border)';
  document.getElementById('deduct-opt').style.borderColor =
    action === 'deduct' ? 'var(--danger)' : 'var(--border)';
}

// ── User management ────────────────────────────────────────────
async function createUser() {
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value;
  const role     = document.getElementById('new-role').value;
  const errEl    = document.getElementById('create-user-error');
  errEl.textContent = '';

  if (!username || !password) {
    errEl.textContent = 'Username and password are required.';
    return;
  }
  try {
    await API.post('/admin/users', { username, password, role });
    showToast(`User "${username}" created.`, 'success');
    document.getElementById('new-username').value = '';
    document.getElementById('new-password').value = '';
    await loadDashboard();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  try {
    await API.del(`/admin/users/${id}`);
    showToast(`User "${username}" deleted.`, 'success');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function unblockUser(id) {
  try {
    await API.post(`/admin/users/${id}/unblock`, {});
    showToast('Spending unblocked for this week.', 'success');
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function adjustTime() {
  const userId  = document.getElementById('award-user-id').value;
  const minutes = parseInt(document.getElementById('award-minutes').value, 10);
  const reason  = document.getElementById('award-reason').value.trim();
  const action  = document.querySelector('input[name="adjust-action"]:checked')?.value || 'award';

  if (!userId) { showToast('Select a user.', 'error'); return; }
  if (!minutes || minutes <= 0) { showToast('Enter a valid amount.', 'error'); return; }

  try {
    const endpoint = action === 'deduct'
      ? `/admin/users/${userId}/deduct`
      : `/admin/users/${userId}/award`;
    const res = await API.post(endpoint, { amount_minutes: minutes, reason });
    const newBal = res.new_balance;
    const balStr = newBal < 0
      ? `−${fmtMins(-newBal)} (in debt)`
      : fmtMins(newBal);
    showToast(
      `${action === 'deduct' ? 'Deducted' : 'Awarded'} ${fmtMins(minutes)}. New balance: ${balStr}.`,
      action === 'deduct' ? 'info' : 'success'
    );
    document.getElementById('award-minutes').value = '';
    document.getElementById('award-reason').value  = '';
    await loadDashboard();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Pre-select a user and action in the adjust panel
function quickAdjust(userId, username, action) {
  const sel = document.getElementById('award-user-id');
  for (const opt of sel.options) { if (opt.value == userId) { sel.value = userId; break; } }
  document.querySelector(`input[name="adjust-action"][value="${action}"]`).checked = true;
  updateAdjustUI();
  document.getElementById('award-minutes').focus();
  showToast(
    `${action === 'deduct' ? 'Deducting from' : 'Awarding to'} ${username}. Enter amount below.`,
    'info'
  );
}

// ── Chores ─────────────────────────────────────────────────────
async function loadChores() {
  try {
    allChores = await API.get('/admin/chores');
    renderChoresTable();
  } catch (err) {
    showToast('Failed to load chores: ' + err.message, 'error');
  }
}

function repeatLabel(c) {
  if (c.repeat_type === 'daily')     return 'Daily';
  if (c.repeat_type === 'weekdays')  return 'Weekdays';
  if (c.repeat_type === 'unlimited') return 'Unlimited';
  return 'Once/week';
}

function capLabel(c) {
  if (!c.max_earned_minutes) return '—';
  return `${fmtMins(c.max_earned_minutes)} / ${c.max_period}`;
}

function renderChoresTable() {
  const el = document.getElementById('chores-table');
  if (allChores.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🧹</div>No chores yet.</div>';
    return;
  }

  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Name</th><th>Type</th><th>Reward</th><th>Repeat</th><th>Cap</th>
      <th>Validation</th>
      <th>Mandatory<br><span class="text-xs font-normal">this week</span></th>
      <th>Active</th><th>Actions</th>
    </tr></thead>
    <tbody>
      ${allChores.map((c) => `<tr style="${!c.active ? 'opacity:.5' : ''}">
        <td>
          <strong>${esc(c.name)}</strong>
          ${c.description ? `<div class="text-xs text-muted">${esc(c.description)}</div>` : ''}
        </td>
        <td>${c.chore_type === 'time_based' ? 'Time-based' : 'Doing'}</td>
        <td>
          ${c.chore_type === 'time_based'
            ? `${c.time_ratio}× logged time`
            : c.time_earned_minutes > 0
              ? `+${fmtMins(c.time_earned_minutes)}`
              : '<span class="text-muted">None</span>'}
        </td>
        <td><span class="badge badge-neutral text-xs">${repeatLabel(c)}</span></td>
        <td class="text-sm text-muted">${capLabel(c)}</td>
        <td>${c.requires_validation
          ? '<span class="badge badge-info">Required</span>'
          : '<span class="badge badge-neutral">Auto</span>'}</td>
        <td style="text-align:center">
          <label class="toggle" title="Toggle mandatory for current week">
            <input type="checkbox" ${c.is_mandatory_this_week ? 'checked' : ''}
              onchange="toggleMandatory(${c.id}, this)">
            <span class="toggle-slider"></span>
          </label>
        </td>
        <td>${c.active
          ? '<span class="badge badge-success">Yes</span>'
          : '<span class="badge badge-neutral">No</span>'}</td>
        <td>
          <div style="display:flex;gap:.375rem;flex-wrap:wrap;">
            <button class="btn btn-ghost btn-xs" onclick="openChoreForm(${c.id})">Edit</button>
            <button class="btn btn-ghost btn-xs text-danger" onclick="deleteChore(${c.id}, '${esc(c.name)}')">Delete</button>
          </div>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

async function deleteChore(choreId, choreName) {
  if (!confirm(`Delete "${choreName}"?\n\nIf users have completed this chore before, it will be deactivated (hidden) instead of permanently removed.`)) return;
  try {
    const res = await API.del(`/admin/chores/${choreId}`);
    if (res.soft) {
      showToast(`"${choreName}" has completion history — deactivated and hidden from users.`, 'info');
    } else {
      showToast(`"${choreName}" permanently deleted.`, 'success');
    }
    await loadChores();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function toggleMandatory(choreId, checkbox) {
  try {
    const res = await API.post(`/admin/chores/${choreId}/toggle-mandatory`, {});
    showToast(res.mandatory ? 'Marked as mandatory this week.' : 'Removed from mandatory list.', 'success');
    checkbox.checked = res.mandatory;
    const chore = allChores.find((c) => c.id === choreId);
    if (chore) chore.is_mandatory_this_week = res.mandatory;
  } catch (err) {
    showToast(err.message, 'error');
    checkbox.checked = !checkbox.checked;
  }
}

function onChoreTypeChange() {
  const type = document.getElementById('chore-type').value;
  document.getElementById('doing-fields').classList.toggle('hidden', type !== 'doing');
  document.getElementById('time-fields').classList.toggle('hidden', type !== 'time_based');
}

function openChoreForm(choreId) {
  document.getElementById('chore-modal-title').textContent = choreId ? 'Edit Chore' : 'Add Chore';
  document.getElementById('chore-modal-error').textContent = '';

  if (choreId) {
    const c = allChores.find((x) => x.id === choreId);
    if (!c) return;
    document.getElementById('chore-edit-id').value        = c.id;
    document.getElementById('chore-name').value           = c.name;
    document.getElementById('chore-desc').value           = c.description || '';
    document.getElementById('chore-type').value           = c.chore_type;
    document.getElementById('chore-validation').value     = String(c.requires_validation);
    document.getElementById('chore-earned').value         = c.time_earned_minutes;
    document.getElementById('chore-ratio').value          = c.time_ratio;
    document.getElementById('chore-active').value         = String(c.active);
    document.getElementById('chore-repeat').value         = c.repeat_type || 'once';
    document.getElementById('chore-max-earned').value     = c.max_earned_minutes || '';
    document.getElementById('chore-max-period').value     = c.max_period || 'week';
  } else {
    document.getElementById('chore-edit-id').value        = '';
    document.getElementById('chore-name').value           = '';
    document.getElementById('chore-desc').value           = '';
    document.getElementById('chore-type').value           = 'doing';
    document.getElementById('chore-validation').value     = 'false';
    document.getElementById('chore-earned').value         = '30';
    document.getElementById('chore-ratio').value          = '0.5';
    document.getElementById('chore-active').value         = 'true';
    document.getElementById('chore-repeat').value         = 'once';
    document.getElementById('chore-max-earned').value     = '';
    document.getElementById('chore-max-period').value     = 'week';
  }
  onChoreTypeChange();
  openModal('chore-modal');
}

async function saveChore() {
  const errEl = document.getElementById('chore-modal-error');
  errEl.textContent = '';

  const id   = document.getElementById('chore-edit-id').value;
  const name = document.getElementById('chore-name').value.trim();
  const type = document.getElementById('chore-type').value;

  if (!name) { errEl.textContent = 'Name is required.'; return; }

  const maxEarned = document.getElementById('chore-max-earned').value;

  const body = {
    name,
    description:          document.getElementById('chore-desc').value.trim() || null,
    chore_type:           type,
    requires_validation:  document.getElementById('chore-validation').value === 'true',
    time_earned_minutes:  parseInt(document.getElementById('chore-earned').value, 10) || 0,
    time_ratio:           parseFloat(document.getElementById('chore-ratio').value) || 0.5,
    active:               document.getElementById('chore-active').value === 'true',
    repeat_type:          document.getElementById('chore-repeat').value,
    max_earned_minutes:   maxEarned ? parseInt(maxEarned, 10) : null,
    max_period:           document.getElementById('chore-max-period').value,
  };

  try {
    if (id) {
      await API.put(`/admin/chores/${id}`, body);
      showToast('Chore updated.', 'success');
    } else {
      await API.post('/admin/chores', body);
      showToast('Chore created.', 'success');
    }
    closeModal('chore-modal');
    await loadChores();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ── Pending validations ────────────────────────────────────────
async function loadPending() {
  try {
    const pending = await API.get('/admin/completions/pending');
    const badge   = document.getElementById('pending-count');
    if (pending.length > 0) {
      badge.textContent = pending.length;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
    renderPending(pending);
  } catch (err) {
    showToast('Failed to load pending: ' + err.message, 'error');
  }
}

function renderPending(pending) {
  const el = document.getElementById('pending-table');
  if (pending.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div>No pending validations.</div>';
    return;
  }

  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>User</th><th>Chore</th><th>Type</th><th>Would Earn</th><th>Notes</th><th>Submitted</th><th>Actions</th>
    </tr></thead>
    <tbody>
      ${pending.map((p) => `<tr>
        <td><strong>${esc(p.username)}</strong></td>
        <td>${esc(p.chore_name)}</td>
        <td>${p.chore_type === 'time_based'
          ? `Time-based (${Math.round(p.duration_minutes)} min logged)`
          : 'Doing'}</td>
        <td class="text-success font-bold">
          ${p.time_earned_minutes > 0 ? '+' + fmtMins(p.time_earned_minutes) : '—'}
        </td>
        <td class="text-sm text-muted">${esc(p.notes || '—')}</td>
        <td class="text-sm text-muted">${fmtDatetime(p.submitted_at)}</td>
        <td>
          <div style="display:flex;gap:.375rem;">
            <button class="btn btn-success btn-xs" onclick="validate(${p.id}, 'approve')">Approve</button>
            <button class="btn btn-danger btn-xs"  onclick="validate(${p.id}, 'reject')">Reject</button>
          </div>
        </td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

async function validate(id, action) {
  try {
    await API.put(`/admin/completions/${id}`, { action });
    showToast(action === 'approve' ? 'Approved — time credited.' : 'Rejected.', action === 'approve' ? 'success' : 'info');
    await loadPending();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Recent Activity ────────────────────────────────────────────
async function loadActivity() {
  try {
    allCompletions = await API.get('/admin/completions/all');

    // Populate chore filter with unique sorted names
    const choreNames = [...new Set(allCompletions.map((r) => r.chore_name))].sort();
    const choreFilter = document.getElementById('filter-chore');
    const prevChore   = choreFilter.value;
    choreFilter.innerHTML = '<option value="">All chores</option>' +
      choreNames.map((n) => `<option value="${esc(n)}"${n === prevChore ? ' selected' : ''}>${esc(n)}</option>`).join('');

    // Populate user filter with unique sorted usernames
    const userNames = [...new Set(allCompletions.map((r) => r.username))].sort();
    const userFilter = document.getElementById('filter-user');
    const prevUser   = userFilter.value;
    userFilter.innerHTML = '<option value="">All users</option>' +
      userNames.map((n) => `<option value="${esc(n)}"${n === prevUser ? ' selected' : ''}>${esc(n)}</option>`).join('');

    filterActivity();
  } catch (err) {
    showToast('Failed to load activity: ' + err.message, 'error');
  }
}

function resetActivityFilters() {
  document.getElementById('filter-chore').value     = '';
  document.getElementById('filter-user').value      = '';
  document.getElementById('filter-status').value    = '';
  document.getElementById('filter-date-from').value = '';
  document.getElementById('filter-date-to').value   = '';
  filterActivity();
}

function filterActivity() {
  const chore    = document.getElementById('filter-chore').value;
  const user     = document.getElementById('filter-user').value;
  const status   = document.getElementById('filter-status').value;
  const dateFrom = document.getElementById('filter-date-from').value;
  const dateTo   = document.getElementById('filter-date-to').value;

  let rows = allCompletions;
  if (chore)    rows = rows.filter((r) => r.chore_name === chore);
  if (user)     rows = rows.filter((r) => r.username   === user);
  if (status)   rows = rows.filter((r) => r.status     === status);
  if (dateFrom) rows = rows.filter((r) => r.submitted_at.slice(0, 10) >= dateFrom);
  if (dateTo)   rows = rows.filter((r) => r.submitted_at.slice(0, 10) <= dateTo);

  renderActivity(rows);
}

function sortActivity(col) {
  if (activitySort.col === col) {
    activitySort.dir = activitySort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    activitySort.col = col;
    // Numeric / date columns default descending; text columns ascending
    activitySort.dir = ['submitted_at', 'time_earned_minutes', 'duration_minutes'].includes(col)
      ? 'desc' : 'asc';
  }
  filterActivity();
}

function renderActivity(rows) {
  // Sort a copy so we don't mutate the filtered array
  const { col, dir } = activitySort;
  const sorted = [...rows].sort((a, b) => {
    let av = a[col] ?? '', bv = b[col] ?? '';
    // Numeric columns: treat null/undefined as 0
    if (col === 'time_earned_minutes' || col === 'duration_minutes') {
      av = Number(av) || 0;
      bv = Number(bv) || 0;
    }
    if (av < bv) return dir === 'asc' ? -1 :  1;
    if (av > bv) return dir === 'asc' ?  1 : -1;
    return 0;
  });

  const el = document.getElementById('activity-table');

  if (sorted.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div>No activity matches your filters.</div>';
    return;
  }

  const icon = (c) => activitySort.col !== c
    ? '<span class="sort-icon">⇅</span>'
    : `<span class="sort-icon active">${activitySort.dir === 'asc' ? '↑' : '↓'}</span>`;

  const statusBadge = (s) => ({
    pending:      '<span class="badge badge-warning">Pending</span>',
    approved:     '<span class="badge badge-success">Approved</span>',
    auto_approved:'<span class="badge badge-success">Auto</span>',
    rejected:     '<span class="badge badge-danger">Rejected</span>',
    adjustment:   '',
    completed:    '<span class="badge badge-info">Completed</span>',
  }[s] ?? `<span class="badge badge-neutral">${esc(s)}</span>`);

  const rowsHtml = sorted.map((r) => {
    const isAdj  = r.activity_type === 'adjustment';
    const isSess = r.activity_type === 'session';
    const amt    = r.time_earned_minutes;

    const typeCell = isSess
      ? '<span class="badge badge-neutral text-xs">Screen Time</span>'
      : isAdj
        ? '<span class="badge badge-info text-xs">Adjustment</span>'
        : r.chore_type === 'time_based' ? 'Time-based' : 'Doing';

    const loggedCell = (isAdj && !isSess) ? '—' : r.duration_minutes ? Math.round(r.duration_minutes) + 'm' : '—';

    const earnCell = (isAdj || isSess)
      ? `<span class="${amt >= 0 ? 'text-success' : 'text-danger'} font-bold">${amt >= 0 ? '+' : '−'}${fmtMins(Math.abs(amt))}</span>`
      : amt > 0
        ? `<span class="text-success font-bold">+${fmtMins(amt)}</span>`
        : '<span class="text-muted">—</span>';

    const rowClass = isAdj ? ' class="activity-adj-row"' : '';

    return `<tr${rowClass}>
      <td><strong>${esc(r.username)}</strong></td>
      <td>${esc(r.chore_name)}</td>
      <td class="text-sm">${typeCell}</td>
      <td class="text-sm text-muted">${loggedCell}</td>
      <td>${earnCell}</td>
      <td>${isAdj ? '' : statusBadge(r.status)}</td>
      <td class="text-sm text-muted">${esc(r.notes || '—')}</td>
      <td class="text-sm text-muted">${fmtDatetime(r.submitted_at)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="th-sort" onclick="sortActivity('username')">User ${icon('username')}</th>
        <th class="th-sort" onclick="sortActivity('chore_name')">Chore / Event ${icon('chore_name')}</th>
        <th class="th-sort" onclick="sortActivity('chore_type')">Type ${icon('chore_type')}</th>
        <th class="th-sort" onclick="sortActivity('duration_minutes')">Time Logged ${icon('duration_minutes')}</th>
        <th class="th-sort" onclick="sortActivity('time_earned_minutes')">Amount ${icon('time_earned_minutes')}</th>
        <th class="th-sort" onclick="sortActivity('status')">Status ${icon('status')}</th>
        <th>Notes</th>
        <th class="th-sort" onclick="sortActivity('submitted_at')">Submitted ${icon('submitted_at')}</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>
    <p class="activity-count">${sorted.length} result${sorted.length !== 1 ? 's' : ''}${sorted.length < allCompletions.length ? ` (filtered from ${allCompletions.length})` : ''}</p>`;
}

// ── Settings ───────────────────────────────────────────────────
async function loadSettings() {
  try {
    const [history, appSettings] = await Promise.all([
      API.get('/admin/settings'),
      API.get('/admin/app-settings'),
    ]);
    renderSettingsHistory(history);
    if (history.length > 0) {
      const latest = history[0];
      document.getElementById('setting-allowance').value = latest.allowance_minutes;
      document.getElementById('setting-required').value  = latest.required_mandatory_count;
    }
    document.getElementById('setting-timezone').value = appSettings.timezone || 'UTC';
  } catch (err) {
    showToast('Failed to load settings: ' + err.message, 'error');
  }
}

async function saveTimezone() {
  const tz    = document.getElementById('setting-timezone').value.trim();
  const msgEl = document.getElementById('timezone-msg');
  msgEl.textContent = '';
  msgEl.className = 'text-sm';
  if (!tz) {
    msgEl.textContent = 'Enter a timezone.';
    msgEl.className = 'text-sm text-danger';
    return;
  }
  try {
    await API.post('/admin/app-settings', { timezone: tz });
    msgEl.textContent = `Timezone set to "${tz}".`;
    msgEl.className = 'text-sm text-success';
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'text-sm text-danger';
  }
}

function renderSettingsHistory(settings) {
  const el = document.getElementById('settings-history');
  if (settings.length === 0) {
    el.innerHTML = '<p class="text-muted text-sm">No settings saved yet.</p>';
    return;
  }
  el.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Effective Week</th><th>Allowance</th><th>Required Chores</th></tr></thead>
    <tbody>
      ${settings.map((s) => `<tr>
        <td class="text-sm">${fmtDate(s.effective_week_start)}</td>
        <td>${fmtMins(s.allowance_minutes)}</td>
        <td>${s.required_mandatory_count === 0 ? 'All' : s.required_mandatory_count}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

async function saveSettings() {
  const allowance = parseInt(document.getElementById('setting-allowance').value, 10);
  const required  = parseInt(document.getElementById('setting-required').value, 10);
  const dateVal   = document.getElementById('setting-date').value;
  const msgEl     = document.getElementById('settings-msg');
  msgEl.textContent = '';
  msgEl.className = 'text-sm';

  if (isNaN(allowance) || allowance < 0) {
    msgEl.textContent = 'Enter a valid allowance (0 or more).';
    msgEl.className = 'text-sm text-danger';
    return;
  }

  const body = {
    allowance_minutes:        allowance,
    required_mandatory_count: isNaN(required) ? 0 : required,
  };
  if (dateVal) body.effective_week_start = dateVal;

  try {
    const res = await API.post('/admin/settings', body);
    msgEl.textContent = `Saved! Effective from ${fmtDate(res.effective_week_start)}.`;
    msgEl.className = 'text-sm text-success';
    await loadSettings();
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = 'text-sm text-danger';
  }
}

// ── Utility ────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
