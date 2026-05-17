// User dashboard logic

if (!requireAuth('user')) throw new Error('not auth');

document.getElementById('header-username').textContent = API.getUser().username;

// ── State ──────────────────────────────────────────────────────
let state = {
  balance: 0,
  activeSession: null,
  spendingBlocked: false,
  mandatory: { required: 0, completed: 0, total: 0, ids: [] },
  chores: [],
  timerInterval: null,
  selectedChore: null,
  countdown: {
    durationSeconds: 0,
    remainingSeconds: 0,
    running: false,
    interval: null,
  },
  alarmInterval: null,
  durationMode: 'direct',
};

// ── Bootstrap ──────────────────────────────────────────────────
async function init() {
  document.getElementById('manual-start').value = nowLocalInput();

  await Promise.all([loadStatus(), loadChores(), loadCompletions()]);

  document.getElementById('start-now-btn').addEventListener('click', () => startSession(false));
  document.getElementById('start-manual-btn').addEventListener('click', () => startSession(true));
  document.getElementById('stop-now-btn').addEventListener('click', () => stopSession(false));
  document.getElementById('stop-manual-btn').addEventListener('click', () => stopSession(true));

  // Poll every 15 s for live updates
  setInterval(loadStatus, 15000);
}

// ── Status ─────────────────────────────────────────────────────
async function loadStatus() {
  try {
    const data = await API.get('/user/status');
    state.balance         = data.balance;
    state.activeSession   = data.activeSession;
    state.spendingBlocked = data.spendingBlocked;
    state.mandatory       = data.mandatory;
    renderBalance();
    renderSession();
    renderMandatory();
  } catch (err) {
    console.error('Status error', err);
  }
}

function renderBalance() {
  const el  = document.getElementById('balance-display');
  const sub = document.getElementById('balance-sub');
  const bal = state.balance;

  if (bal < 0) {
    el.textContent = `−${fmtMins(-bal)}`;
    el.className = 'balance-display empty';
    sub.innerHTML = `<span style="color:var(--danger);font-weight:600;">In time debt — ${-bal} minute${-bal !== 1 ? 's' : ''} owed</span>`;
  } else if (bal === 0) {
    el.textContent = '0m';
    el.className = 'balance-display empty';
    sub.textContent = 'No time remaining';
  } else {
    el.textContent = fmtMins(bal);
    el.className = 'balance-display' + (bal < 30 ? ' low' : '');
    sub.textContent = `${bal} minute${bal !== 1 ? 's' : ''} remaining`;
  }
}

function renderSession() {
  const idle    = document.getElementById('session-idle');
  const active  = document.getElementById('session-active');
  const blocked = state.spendingBlocked;

  document.getElementById('blocked-banner').classList.toggle('hidden', !blocked);
  document.getElementById('start-now-btn').disabled    = blocked;
  document.getElementById('start-manual-btn').disabled = blocked;

  if (state.activeSession) {
    idle.classList.add('hidden');
    active.classList.remove('hidden');
    document.getElementById('manual-stop').value = nowLocalInput();

    const startAt = new Date(state.activeSession.start_time);
    document.getElementById('session-info').textContent =
      `Started at ${startAt.toLocaleTimeString()}`;

    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => updateLiveTimer(startAt), 1000);
    updateLiveTimer(startAt);
  } else {
    clearInterval(state.timerInterval);
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    document.getElementById('balance-live').textContent = '';
    document.getElementById('manual-start').value = nowLocalInput();
  }
}

function updateLiveTimer(startAt) {
  const elapsed  = (Date.now() - startAt.getTime()) / 60000;
  document.getElementById('session-timer').textContent = fmtMinsExact(elapsed);

  const remaining = state.balance - elapsed;
  const liveEl = document.getElementById('balance-live');
  if (remaining <= 0) {
    const debtAmt = fmtMins(-remaining);
    liveEl.textContent = `⚠ ${debtAmt} in debt — session continues until you stop.`;
    liveEl.className = 'text-sm text-danger mb-2';
  } else if (remaining < 10) {
    liveEl.textContent = `~${fmtMins(remaining)} remaining`;
    liveEl.className = 'text-sm text-warning mb-2';
  } else {
    liveEl.textContent = `~${fmtMins(remaining)} remaining`;
    liveEl.className = 'text-sm text-muted mb-2';
  }
}

function renderMandatory() {
  const { required, completed, total, ids } = state.mandatory;
  const badge = document.getElementById('mandatory-badge');
  const bar   = document.getElementById('mandatory-bar');
  const text  = document.getElementById('mandatory-text');

  if (total === 0) {
    badge.className = 'badge badge-neutral';
    badge.textContent = 'No mandatory chores this week';
    bar.style.width = '100%';
    bar.className = 'progress-bar';
    text.textContent = '';
    document.getElementById('mandatory-chore-list').innerHTML = '';
    return;
  }

  const pct = Math.min(100, Math.round((completed / Math.max(1, required)) * 100));
  bar.style.width = pct + '%';
  bar.className = 'progress-bar' + (pct >= 100 ? '' : pct > 50 ? ' warn' : ' danger');

  if (completed >= required) {
    badge.className = 'badge badge-success';
    badge.textContent = `✓ Done (${completed}/${required})`;
    text.textContent = total > required
      ? `You completed the required ${required} of ${total} mandatory chores.`
      : `All ${total} mandatory chores complete!`;
  } else {
    badge.className = 'badge badge-warning';
    badge.textContent = `${completed} / ${required} required`;
    text.textContent = `Complete ${required - completed} more mandatory chore${required - completed > 1 ? 's' : ''} this week to avoid a spending block next week.`;
  }

  const listEl = document.getElementById('mandatory-chore-list');
  const mandatoryChores = state.chores.filter((c) => ids.includes(c.id));
  listEl.innerHTML = mandatoryChores.map((c) => {
    const status = c.completion_status;
    let iconClass = 'pending', icon = '○';
    if (status === 'approved' || status === 'auto_approved') { iconClass = 'done'; icon = '✓'; }
    else if (status === 'pending') { iconClass = 'needs-validation'; icon = '⧖'; }
    return `<div class="chore-check-item">
      <span class="chore-check-icon ${iconClass}">${icon}</span>
      <span>${esc(c.name)}</span>
      ${status === 'pending' ? '<span class="badge badge-warning text-xs">awaiting approval</span>' : ''}
    </div>`;
  }).join('');
}

// ── Session actions ────────────────────────────────────────────
async function startSession(manual) {
  try {
    const body = {};
    if (manual) {
      const val = document.getElementById('manual-start').value;
      if (!val) { showToast('Please enter a start time.', 'error'); return; }
      body.start_time = new Date(val).toISOString();
    }
    await API.post('/user/session/start', body);
    showToast('Session started!', 'success');
    await loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function cancelSession() {
  if (!confirm('Cancel this session? No time will be deducted.')) return;
  try {
    await API.post('/user/session/cancel', {});
    showToast('Session cancelled — no time deducted.', 'info');
    await loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopSession(manual) {
  try {
    const body = {};
    if (manual) {
      const val = document.getElementById('manual-stop').value;
      if (!val) { showToast('Please enter a stop time.', 'error'); return; }
      body.end_time = new Date(val).toISOString();
    }
    const result = await API.post('/user/session/stop', body);
    const newBal = result.new_balance;
    const balMsg = newBal < 0
      ? ` Balance: −${fmtMins(-newBal)} (in debt).`
      : ` Balance: ${fmtMins(newBal)} remaining.`;
    showToast(`Session ended. Deducted ${fmtMins(result.time_deducted)}.${balMsg}`, 'success');
    await loadStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── Chore list ─────────────────────────────────────────────────
async function loadChores() {
  try {
    const chores = await API.get('/user/chores');
    state.chores = chores;
    renderMandatory();
    renderChores();
  } catch (err) {
    showToast('Failed to load chores: ' + err.message, 'error');
  }
}

function repeatBadge(c) {
  if (c.repeat_type === 'daily')     return '<span class="badge badge-neutral text-xs">Daily</span>';
  if (c.repeat_type === 'weekdays')  return '<span class="badge badge-neutral text-xs">Weekdays</span>';
  if (c.repeat_type === 'unlimited') return '<span class="badge badge-neutral text-xs">Unlimited</span>';
  return '';
}

function capInfo(c) {
  if (!c.max_earned_minutes) return '';
  const period = c.max_period || 'week';
  const earned = period === 'day' ? c.earned_today : c.earned_this_week;
  const remaining = c.max_earned_minutes - earned;
  if (remaining <= 0) {
    return `<span class="text-danger text-xs">Cap reached (${fmtMins(c.max_earned_minutes)}/${period})</span>`;
  }
  return `<span class="text-muted text-xs">Cap: ${fmtMins(remaining)} left of ${fmtMins(c.max_earned_minutes)}/${period}</span>`;
}

function renderChores() {
  const el = document.getElementById('chores-list');

  if (state.chores.length === 0) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">🧹</div>No chores available.</div>';
    return;
  }

  el.innerHTML = state.chores.map((c) => {
    const isMandatory = c.is_mandatory_this_week;
    const canSubmit   = c.can_submit;
    const blockReason = c.submit_block_reason;

    let earnLabel = '';
    if (!isMandatory) {
      if (c.chore_type === 'doing') {
        earnLabel = c.time_earned_minutes > 0 ? `+${fmtMins(c.time_earned_minutes)}` : '';
      } else {
        earnLabel = `+${c.time_ratio}× duration`;
      }
    }

    let actionBtn;
    if (!canSubmit) {
      // Blocked by repeat constraint
      const label = blockReason || 'Not available';
      actionBtn = `<span class="badge badge-neutral text-xs" style="white-space:normal;text-align:right;">${esc(label)}</span>`;
    } else if (c.at_cap && !isMandatory) {
      // At earning cap, but could still submit mandatory chores
      actionBtn = `<span class="badge badge-warning text-xs">Earning cap reached</span>`;
    } else {
      actionBtn = `<button class="btn btn-primary btn-sm" onclick="openChoreModal(${c.id})">
        ${c.chore_type === 'time_based' ? '⏱ Log Time' : '✓ Complete'}
      </button>`;
    }

    return `<div class="chore-item${isMandatory ? ' mandatory' : ''}${!canSubmit ? ' completed-item' : ''}">
      <div class="chore-item-body">
        <div class="chore-item-name">${esc(c.name)}</div>
        <div class="chore-item-meta">
          ${isMandatory ? '<span class="badge badge-warning text-xs">Mandatory</span>' : ''}
          ${repeatBadge(c)}
          ${c.requires_validation ? '<span class="badge badge-info text-xs">Needs validation</span>' : ''}
          ${earnLabel ? `<span class="text-success font-bold">${earnLabel}</span>` : (!isMandatory ? '<span class="text-muted">No time earned</span>' : '')}
          ${capInfo(c)}
        </div>
        ${c.description ? `<div class="text-xs text-muted mt-1">${esc(c.description)}</div>` : ''}
      </div>
      <div class="chore-item-actions">${actionBtn}</div>
    </div>`;
  }).join('');
}

function openChoreModal(choreId) {
  const chore = state.chores.find((c) => c.id === choreId);
  if (!chore) return;
  state.selectedChore = chore;

  document.getElementById('modal-chore-name').textContent = chore.name;
  document.getElementById('modal-chore-desc').textContent = chore.description || '';
  document.getElementById('modal-notes').value = '';
  document.getElementById('modal-error').textContent = '';

  const isMandatory = chore.is_mandatory_this_week;
  const earnEl = document.getElementById('modal-chore-earn');

  if (isMandatory) {
    earnEl.textContent = 'Mandatory chore — no time earned.';
    earnEl.className = 'text-sm text-muted';
  } else if (chore.at_cap) {
    earnEl.textContent = `Earning cap reached — you can still submit but won't earn time.`;
    earnEl.className = 'text-sm text-warning';
  } else if (chore.chore_type === 'doing') {
    earnEl.textContent = `You will earn ${fmtMins(chore.time_earned_minutes)}.`;
    earnEl.className = 'text-sm text-success font-bold';
  } else {
    const capText = chore.max_earned_minutes
      ? ` (cap: ${fmtMins(chore.max_earned_minutes - (chore.max_period === 'day' ? chore.earned_today : chore.earned_this_week))} left)`
      : '';
    earnEl.textContent = `You will earn ${chore.time_ratio}× the minutes you enter${capText}.`;
    earnEl.className = 'text-sm text-success font-bold';
  }

  const durGroup = document.getElementById('modal-duration-group');
  if (chore.chore_type === 'time_based') {
    durGroup.classList.remove('hidden');
    // Reset to direct-duration mode each time the modal opens
    setDurationMode('direct');
    document.getElementById('modal-duration').value = '';
  } else {
    durGroup.classList.add('hidden');
    document.getElementById('modal-duration').value = '';
  }

  openModal('chore-modal');
}

async function submitChore() {
  const chore = state.selectedChore;
  if (!chore) return;

  const btn   = document.getElementById('modal-submit-btn');
  const errEl = document.getElementById('modal-error');
  errEl.textContent = '';

  const body = { notes: document.getElementById('modal-notes').value.trim() || null };

  if (chore.chore_type === 'time_based') {
    if (state.durationMode === 'direct') {
      const dur = parseFloat(document.getElementById('modal-duration').value);
      if (!dur || dur <= 0) {
        errEl.textContent = 'Please enter a valid duration.';
        return;
      }
      body.duration_minutes = dur;
    } else {
      const startVal = document.getElementById('modal-start-time').value;
      const endVal   = document.getElementById('modal-end-time').value;
      if (!startVal || !endVal) {
        errEl.textContent = 'Please enter a start and end time.';
        return;
      }
      const dur = (new Date(endVal) - new Date(startVal)) / 60000;
      if (dur <= 0) {
        errEl.textContent = 'End time must be after start time.';
        return;
      }
      body.duration_minutes = Math.floor(dur);
    }
  }

  btn.disabled = true;
  btn.textContent = 'Submitting…';

  try {
    const result = await API.post(`/user/chores/${chore.id}/complete`, body);
    closeModal('chore-modal');
    const earned = result.time_earned_minutes;
    if (result.status === 'pending') {
      showToast('Submitted! Waiting for admin approval.', 'info');
    } else if (result.at_cap) {
      showToast('Chore logged! (Earning cap reached — no time awarded.)', 'info');
    } else if (earned > 0) {
      showToast(`Chore submitted! You earned ${fmtMins(earned)}.`, 'success');
    } else {
      showToast('Mandatory chore logged!', 'success');
    }
    await Promise.all([loadStatus(), loadChores(), loadCompletions()]);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit';
  }
}

// ── Countdown Timer ────────────────────────────────────────────

function setQuickTimer(minutes) {
  timerSet(minutes * 60);
  document.getElementById('countdown-input').value = '';
}

function setCustomTimer() {
  const val = parseInt(document.getElementById('countdown-input').value, 10);
  if (!val || val <= 0) { showToast('Enter a valid number of minutes.', 'error'); return; }
  timerSet(val * 60);
}

function timerSet(seconds) {
  _timerClearInterval();
  state.countdown.running = false;
  state.countdown.durationSeconds = seconds;
  state.countdown.remainingSeconds = seconds;
  stopAlarm();
  document.getElementById('alarm-overlay').classList.add('hidden');
  const disp = document.getElementById('countdown-display');
  disp.classList.remove('warning', 'alarm');
  _updateCountdownDisplay();
  _updateTimerButtons();
}

function timerStartPause() {
  if (state.countdown.running) {
    _timerClearInterval();
    state.countdown.running = false;
    _updateTimerButtons();
    document.getElementById('timer-status-text').textContent = 'Paused';
  } else {
    if (state.countdown.remainingSeconds <= 0) return;
    state.countdown.running = true;
    state.countdown.interval = setInterval(_timerTick, 1000);
    _updateTimerButtons();
    document.getElementById('timer-status-text').textContent = 'Running…';
  }
}

function timerReset() {
  _timerClearInterval();
  stopAlarm();
  state.countdown.running = false;
  state.countdown.remainingSeconds = state.countdown.durationSeconds;
  document.getElementById('alarm-overlay').classList.add('hidden');
  const disp = document.getElementById('countdown-display');
  disp.classList.remove('warning', 'alarm');
  _updateCountdownDisplay();
  _updateTimerButtons();
  document.getElementById('timer-status-text').textContent = '';
}

function dismissAlarm() {
  stopAlarm();
  document.getElementById('alarm-overlay').classList.add('hidden');
  const disp = document.getElementById('countdown-display');
  disp.classList.remove('alarm', 'warning');
  // Reset ready for another run
  state.countdown.remainingSeconds = state.countdown.durationSeconds;
  state.countdown.running = false;
  _timerClearInterval();
  _updateCountdownDisplay();
  _updateTimerButtons();
  document.getElementById('timer-status-text').textContent = '';
}

function _timerTick() {
  if (state.countdown.remainingSeconds <= 0) {
    _timerClearInterval();
    state.countdown.running = false;
    _triggerAlarm();
    return;
  }
  state.countdown.remainingSeconds--;
  _updateCountdownDisplay();
  const disp = document.getElementById('countdown-display');
  if (state.countdown.remainingSeconds <= 60 && state.countdown.remainingSeconds > 0) {
    disp.classList.add('warning');
  }
  if (state.countdown.remainingSeconds === 0) {
    _timerClearInterval();
    state.countdown.running = false;
    _triggerAlarm();
  }
}

function _timerClearInterval() {
  if (state.countdown.interval) {
    clearInterval(state.countdown.interval);
    state.countdown.interval = null;
  }
}

function _updateCountdownDisplay() {
  const rem = state.countdown.remainingSeconds;
  const mins = Math.floor(rem / 60);
  const secs = rem % 60;
  document.getElementById('countdown-display').textContent =
    `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function _updateTimerButtons() {
  const startBtn = document.getElementById('timer-start-btn');
  const resetBtn = document.getElementById('timer-reset-btn');
  const hasDuration = state.countdown.durationSeconds > 0;
  const running = state.countdown.running;
  const done = state.countdown.remainingSeconds === 0 && hasDuration;

  startBtn.disabled = !hasDuration || done;
  resetBtn.disabled = !hasDuration;
  startBtn.textContent = running ? '⏸ Pause' : '▶ Start';
  if (running) {
    startBtn.className = 'btn btn-warning';
  } else {
    startBtn.className = 'btn btn-success';
  }
}

function _triggerAlarm() {
  const disp = document.getElementById('countdown-display');
  disp.classList.remove('warning');
  disp.classList.add('alarm');
  document.getElementById('alarm-overlay').classList.remove('hidden');
  document.getElementById('timer-status-text').textContent = '';
  _updateTimerButtons();
  startAlarm();
}

// ── Alarm (Web Audio API) ──────────────────────────────────────

function startAlarm() {
  _playAlarmPattern();  // immediate
  state.alarmInterval = setInterval(_playAlarmPattern, 2800);
}

function stopAlarm() {
  if (state.alarmInterval) {
    clearInterval(state.alarmInterval);
    state.alarmInterval = null;
  }
}

function _playAlarmPattern() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Three rising beeps
    const beeps = [
      { time: 0,    freq: 783.99, dur: 0.18 },  // G5
      { time: 0.25, freq: 880,    dur: 0.18 },  // A5
      { time: 0.5,  freq: 1046.5, dur: 0.28 },  // C6 (longer)
    ];
    beeps.forEach(({ time, freq, dur }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + time);
      gain.gain.linearRampToValueAtTime(0.45, ctx.currentTime + time + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + time + dur);
      osc.start(ctx.currentTime + time);
      osc.stop(ctx.currentTime + time + dur + 0.05);
    });
    // Close the context after all beeps finish
    setTimeout(() => ctx.close(), 1200);
  } catch (e) {
    console.warn('Web Audio unavailable:', e);
  }
}

// ── Duration mode (chore modal) ────────────────────────────────

function setDurationMode(mode) {
  state.durationMode = mode;
  document.getElementById('dur-mode-direct').classList.toggle('active', mode === 'direct');
  document.getElementById('dur-mode-times').classList.toggle('active', mode === 'times');
  document.getElementById('dur-direct-panel').classList.toggle('hidden', mode !== 'direct');
  document.getElementById('dur-times-panel').classList.toggle('hidden', mode !== 'times');

  if (mode === 'times') {
    // Default: start = now, end = now
    const now = nowLocalInput();
    document.getElementById('modal-start-time').value = now;
    document.getElementById('modal-end-time').value = now;
    calcModalDuration();
  }
}

function calcModalDuration() {
  const startVal = document.getElementById('modal-start-time').value;
  const endVal   = document.getElementById('modal-end-time').value;
  const calcEl   = document.getElementById('modal-duration-calc');
  if (!startVal || !endVal) { calcEl.textContent = 'Calculated duration: —'; return; }
  const diff = (new Date(endVal) - new Date(startVal)) / 60000;
  if (diff <= 0) {
    calcEl.textContent = '⚠ End time must be after start time.';
    calcEl.className = 'text-sm text-danger mt-1';
  } else {
    const m = Math.floor(diff);
    calcEl.textContent = `Calculated duration: ${m} minute${m !== 1 ? 's' : ''}`;
    calcEl.className = 'text-sm text-muted mt-1';
  }
}

// ── History ────────────────────────────────────────────────────
async function loadCompletions() {
  try {
    const completions = await API.get('/user/completions');
    const el = document.getElementById('completions-list');

    if (completions.length === 0) {
      el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div>No activity yet.</div>';
      return;
    }

    const statusBadge = (s) => ({
      pending:      '<span class="badge badge-warning">Pending</span>',
      approved:     '<span class="badge badge-success">Approved</span>',
      auto_approved:'<span class="badge badge-success">Approved</span>',
      rejected:     '<span class="badge badge-danger">Rejected</span>',
      adjustment:   '',
    }[s] ?? `<span class="badge badge-neutral">${esc(s)}</span>`);

    const rows = completions.map((c) => {
      const isAdj = c.activity_type === 'adjustment';
      const amt   = c.time_earned_minutes;

      const typeCell = isAdj
        ? '<span class="badge badge-info text-xs">Admin Adjustment</span>'
        : c.chore_type === 'time_based'
          ? `${Math.round(c.duration_minutes)}m logged`
          : 'Doing';

      const earnCell = isAdj
        ? `<span class="${amt >= 0 ? 'text-success' : 'text-danger'} font-bold">${amt >= 0 ? '+' : '−'}${fmtMins(Math.abs(amt))}</span>`
        : amt > 0
          ? `<span class="text-success font-bold">+${fmtMins(amt)}</span>`
          : '<span class="text-muted">—</span>';

      const rowClass = isAdj ? ' class="activity-adj-row"' : '';

      return `<tr${rowClass}>
        <td>${esc(c.chore_name)}</td>
        <td class="text-sm">${typeCell}</td>
        <td>${earnCell}</td>
        <td class="text-sm text-muted">${esc(c.notes || '—')}</td>
        <td>${isAdj ? '' : statusBadge(c.status)}</td>
        <td class="text-sm text-muted">${fmtDatetime(c.submitted_at)}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr>
        <th>Chore / Event</th><th>Type</th><th>Time</th><th>Notes</th><th>Status</th><th>Submitted</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  } catch (err) {
    console.error('Completions error', err);
  }
}

// ── Utility ────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

init();
