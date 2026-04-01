// ==================== SOCKET CONNECTION ====================
const socket = io();
let chips = [];
let currentQRSessionId = null;

// ==================== SOCKET EVENTS ====================

socket.on('connect', () => {
    console.log('Conectado ao servidor');
});

socket.on('stats', (stats) => {
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-connected').textContent = stats.connected;
    document.getElementById('stat-warming').textContent = stats.warming;
    document.getElementById('stat-messages').textContent = formatNumber(stats.totalMessages);
});

socket.on('chips_list', (list) => {
    chips = list;
    renderChips();
});

socket.on('chip_update', (chip) => {
    const idx = chips.findIndex(c => c.id === chip.id);
    if (idx >= 0) {
        chips[idx] = chip;
    } else {
        chips.unshift(chip);
    }
    renderChips();
});

socket.on('chip_deleted', ({ chipId }) => {
    chips = chips.filter(c => c.id !== chipId);
    renderChips();
});

socket.on('qr', ({ sessionId, chipId, qr }) => {
    currentQRSessionId = sessionId;
    const qrImage = document.getElementById('qr-image');
    qrImage.innerHTML = `<img src="${qr}" alt="QR Code">`;
});

socket.on('connected', ({ sessionId, chipId, phone }) => {
    if (currentQRSessionId === sessionId) {
        const qrImage = document.getElementById('qr-image');
        qrImage.innerHTML = `<div style="color:#34a853;font-size:48px">✓</div><div style="margin-top:8px;color:#333">Conectado!<br><small>${phone || ''}</small></div>`;
        document.getElementById('btn-next-qr').style.display = 'inline-flex';
    }
    showToast(`Chip ${phone || 'novo'} conectado!`, 'success');
});

socket.on('logged_out', ({ sessionId, chipId }) => {
    showToast('Chip deslogado pelo WhatsApp', 'danger');
});

socket.on('activity', (data) => {
    addActivityItem(data);
});

socket.on('phase_change', ({ chipId, phase, days }) => {
    const chip = chips.find(c => c.id === chipId);
    showToast(`${chip?.phone || 'Chip'} avancou para Fase ${phase} (${days} dias)`, 'warning');
});

socket.on('error', ({ message }) => {
    showToast(message, 'danger');
});

// ==================== RENDER CHIPS ====================

function renderChips() {
    const grid = document.getElementById('chips-grid');

    if (chips.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📱</div>
                <h3>Nenhum chip cadastrado</h3>
                <p>Clique em "+ Adicionar Chip" para comecar</p>
            </div>`;
        return;
    }

    grid.innerHTML = chips.map(chip => {
        const progress = chip.messages_target > 0
            ? Math.min(100, Math.round((chip.messages_sent / chip.messages_target) * 100))
            : 0;
        const remaining = Math.max(0, chip.messages_target - chip.messages_sent);

        return `
        <div class="chip-card" id="chip-${chip.id}">
            <div class="chip-header">
                <div>
                    <div class="chip-name">${chip.name || 'Chip ' + chip.id}</div>
                    <div class="chip-phone">${chip.phone || 'Aguardando conexao...'}</div>
                </div>
                <div class="chip-status status-${chip.status}">
                    <span class="dot"></span>
                    ${getStatusLabel(chip.status)}
                </div>
            </div>

            <div class="chip-meta">
                <span>📊 Fase <span class="badge badge-phase-${chip.phase}">${chip.phase}</span></span>
                <span>💬 ${formatNumber(chip.messages_sent)} msgs</span>
                ${chip.connected_at ? `<span>📅 ${formatDate(chip.connected_at)}</span>` : ''}
            </div>

            <div class="chip-progress">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${progress}%"></div>
                </div>
                <div class="progress-info">
                    <span>Progresso: ${progress}%</span>
                    <span>Faltam ${formatNumber(remaining)} msgs</span>
                </div>
            </div>

            <div class="chip-actions">
                ${chip.status === 'warming'
                    ? `<button class="btn btn-warning btn-sm" onclick="stopWarming(${chip.id})">⏸ Pausar</button>`
                    : chip.status === 'connected'
                        ? `<button class="btn btn-success btn-sm" onclick="startWarming(${chip.id})">▶ Aquecer</button>`
                        : chip.status === 'disconnected'
                            ? `<button class="btn btn-primary btn-sm" onclick="reconnectChip('${chip.session_id}')">🔄 Reconectar</button>`
                            : `<button class="btn btn-outline btn-sm" disabled>⏳ Aguardando...</button>`
                }
                <button class="btn btn-outline btn-sm" onclick="disconnectChip(${chip.id})" ${chip.status === 'disconnected' ? 'disabled' : ''}>⏏ Desconectar</button>
                <button class="btn-icon danger" onclick="deleteChip(${chip.id})" title="Excluir">✕</button>
            </div>
        </div>`;
    }).join('');
}

function getStatusLabel(status) {
    const labels = {
        'connected': 'Conectado',
        'warming': 'Aquecendo',
        'disconnected': 'Desconectado',
        'qr_pending': 'QR Pendente',
        'paused': 'Pausado'
    };
    return labels[status] || status;
}

// ==================== ACTIONS ====================

function openQRModal() {
    document.getElementById('qr-modal').classList.add('active');
    document.getElementById('qr-image').innerHTML = '<div class="qr-waiting">Gerando QR Code...</div>';
    document.getElementById('btn-next-qr').style.display = 'none';
    currentQRSessionId = null;
    socket.emit('request_qr', { name: '' });
}

function closeQRModal() {
    document.getElementById('qr-modal').classList.remove('active');
    currentQRSessionId = null;
}

function nextQR() {
    document.getElementById('qr-image').innerHTML = '<div class="qr-waiting">Gerando QR Code...</div>';
    document.getElementById('btn-next-qr').style.display = 'none';
    currentQRSessionId = null;
    socket.emit('request_qr', { name: '' });
}

function startWarming(chipId) {
    socket.emit('start_warming', { chipId });
    showToast('Aquecimento iniciado', 'success');
}

function stopWarming(chipId) {
    socket.emit('stop_warming', { chipId });
    showToast('Aquecimento pausado', 'warning');
}

function startAll() {
    socket.emit('start_all');
    showToast('Aquecimento iniciado para todos os chips conectados', 'success');
}

function stopAll() {
    socket.emit('stop_all');
    showToast('Aquecimento parado para todos os chips', 'warning');
}

function disconnectChip(chipId) {
    if (confirm('Desconectar este chip?')) {
        socket.emit('disconnect_chip', { chipId });
    }
}

function deleteChip(chipId) {
    if (confirm('Excluir este chip? A sessao sera removida permanentemente.')) {
        socket.emit('delete_chip', { chipId });
        showToast('Chip excluido', 'danger');
    }
}

function reconnectChip(sessionId) {
    socket.emit('reconnect_chip', { sessionId });
    showToast('Reconectando...', 'accent');
}

function refreshChips() {
    fetch('/api/chips')
        .then(r => r.json())
        .then(list => {
            chips = list;
            renderChips();
        });
    fetch('/api/stats')
        .then(r => r.json())
        .then(stats => socket.emit('stats', stats));
}

// ==================== ACTIVITY LOG ====================

const activityItems = [];
const MAX_ACTIVITY = 100;

function addActivityItem(data) {
    activityItems.unshift(data);
    if (activityItems.length > MAX_ACTIVITY) activityItems.pop();

    // Only render if activity tab is visible
    if (document.getElementById('tab-activity').classList.contains('active')) {
        renderActivity();
    }
}

function renderActivity() {
    const log = document.getElementById('activity-log');
    if (activityItems.length === 0) {
        log.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📊</div>
                <h3>Sem atividade ainda</h3>
                <p>A atividade aparecera aqui quando o aquecimento iniciar</p>
            </div>`;
        return;
    }

    log.innerHTML = activityItems.map(item => {
        const chip = chips.find(c => c.id === item.chipId);
        const chipLabel = chip?.phone || chip?.name || `Chip ${item.chipId}`;
        const icon = getActionIcon(item.action);
        const iconClass = getActionClass(item.action);

        return `
        <div class="activity-item">
            <div class="activity-icon ${iconClass}">${icon}</div>
            <div class="activity-content">
                <span class="activity-chip">${chipLabel}</span>
                ${item.target ? `→ <span class="activity-target">${item.target}</span>` : ''}
                ${item.message ? `<br><small style="color:var(--text-secondary)">${truncate(item.message, 60)}</small>` : ''}
                ${!item.success ? '<br><small style="color:var(--danger)">❌ Erro</small>' : ''}
            </div>
            <div class="activity-time">${item.time || ''}</div>
        </div>`;
    }).join('');
}

function loadActivity() {
    fetch('/api/activity?limit=50')
        .then(r => r.json())
        .then(activities => {
            activityItems.length = 0;
            for (const a of activities) {
                activityItems.push({
                    chipId: a.chip_id,
                    action: a.action_type,
                    target: a.target,
                    message: a.details,
                    success: a.success,
                    time: new Date(a.created_at).toLocaleTimeString()
                });
            }
            renderActivity();
        });
}

function getActionIcon(action) {
    const icons = {
        'private_chat': '💬', 'audio': '🎤', 'group_chat': '👥',
        'group_create': '📋', 'status': '📱', 'sticker': '🏷️',
        'reaction': '👍', 'error': '❌'
    };
    return icons[action] || '📝';
}

function getActionClass(action) {
    const classes = {
        'private_chat': 'chat', 'audio': 'audio', 'group_chat': 'group',
        'group_create': 'group', 'status': 'status', 'sticker': 'sticker',
        'reaction': 'reaction', 'error': 'error'
    };
    return classes[action] || 'chat';
}

// ==================== CONFIG ====================

function loadConfig() {
    fetch('/api/config')
        .then(r => r.json())
        .then(configs => {
            const grid = document.getElementById('config-grid');
            grid.innerHTML = configs.map(config => `
                <div class="config-card">
                    <h4>Fase ${config.phase} — ${config.description || ''}</h4>
                    <div class="config-row">
                        <label>Msgs/dia</label>
                        <input type="number" value="${config.daily_limit}" onchange="updateConfig(${config.phase}, 'daily_limit', this.value)">
                    </div>
                    <div class="config-row">
                        <label>Delay min (seg)</label>
                        <input type="number" value="${config.min_delay_seconds}" onchange="updateConfig(${config.phase}, 'min_delay_seconds', this.value)">
                    </div>
                    <div class="config-row">
                        <label>Delay max (seg)</label>
                        <input type="number" value="${config.max_delay_seconds}" onchange="updateConfig(${config.phase}, 'max_delay_seconds', this.value)">
                    </div>
                    <div class="config-row">
                        <label>Hora inicio</label>
                        <input type="number" value="${config.active_hour_start}" min="0" max="23" onchange="updateConfig(${config.phase}, 'active_hour_start', this.value)">
                    </div>
                    <div class="config-row">
                        <label>Hora fim</label>
                        <input type="number" value="${config.active_hour_end}" min="0" max="23" onchange="updateConfig(${config.phase}, 'active_hour_end', this.value)">
                    </div>
                    <div class="config-row">
                        <label>Acoes</label>
                        <input type="text" value="${config.enabled_actions}" style="width:100%;margin-top:4px" onchange="updateConfig(${config.phase}, 'enabled_actions', this.value)">
                    </div>
                </div>
            `).join('');
        });
}

function updateConfig(phase, field, value) {
    const body = {};
    body[field] = isNaN(value) ? value : parseInt(value);
    fetch(`/api/config/${phase}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(() => showToast('Configuracao atualizada', 'success'));
}

// ==================== TABS ====================

function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    const tabs = document.querySelectorAll('.tab');
    const tabMap = { 'chips': 0, 'activity': 1, 'config': 2 };
    tabs[tabMap[tabName]].classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'activity') renderActivity();
    if (tabName === 'config') loadConfig();
}

// ==================== UTILITIES ====================

function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Hoje';
    if (diffDays === 1) return 'Ontem';
    if (diffDays < 7) return `${diffDays} dias`;
    return d.toLocaleDateString('pt-BR');
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function showToast(message, type = 'accent') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';

    const colors = {
        'success': 'var(--success)', 'danger': 'var(--danger)',
        'warning': 'var(--warming)', 'accent': 'var(--accent)'
    };

    toast.style.borderLeftColor = colors[type] || colors.accent;
    toast.style.borderLeftWidth = '3px';
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ==================== KEYBOARD SHORTCUTS ====================

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeQRModal();
});

// Click outside modal to close
document.getElementById('qr-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeQRModal();
});
