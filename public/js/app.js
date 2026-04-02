// ==================== KS DIGITAL — COMMAND CENTER ====================
const socket = io();
let chips = [];
let currentQRSessionId = null;

// ==================== ANIMATED COUNTER ====================
function animateValue(el, start, end, duration) {
    if (start === end) return;
    const range = end - start;
    const startTime = performance.now();
    function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // easeOutExpo
        const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
        const current = Math.round(start + range * ease);
        el.textContent = formatNumber(current);
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}

function updateStat(id, newValue) {
    const el = document.getElementById(id);
    const current = parseInt(el.dataset.raw || '0');
    el.dataset.raw = newValue;
    animateValue(el, current, newValue, 600);
}

// ==================== SOCKET EVENTS ====================
socket.on('connect', () => {
    console.log('[KS] Conectado ao servidor');
    addFeedItem('system', 'Sistema', 'Conectado ao servidor', 'connect');
});

socket.on('stats', (stats) => {
    updateStat('stat-total', stats.total);
    updateStat('stat-connected', stats.connected);
    updateStat('stat-warming', stats.warming);
    updateStat('stat-messages', stats.totalMessages);
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
    // Show scan step with QR
    document.getElementById('qr-step-name').style.display = 'none';
    document.getElementById('qr-step-scan').style.display = 'block';
    const chipName = document.getElementById('chip-name-input').value.trim();
    const modalTitle = document.querySelector('#qr-modal .modal h3');
    if (modalTitle && chipName) modalTitle.textContent = 'Conectar: ' + chipName;
    const qrImage = document.getElementById('qr-image');
    qrImage.innerHTML = `<img src="${qr}" alt="QR Code">`;
});

socket.on('connected', ({ sessionId, chipId, phone }) => {
    if (currentQRSessionId === sessionId) {
        const qrImage = document.getElementById('qr-image');
        qrImage.innerHTML = `<div style="color:#22C55E;font-size:48px">✓</div><div style="margin-top:8px;color:#666;font-size:14px">Conectado!<br><small>${phone || ''}</small></div>`;
        document.getElementById('btn-next-qr').style.display = 'inline-flex';
    }
    showToast(`Chip ${phone || 'novo'} conectado!`, 'success');
    addFeedItem(phone || 'Novo chip', 'Conectado com sucesso', null, 'connect');
});

socket.on('logged_out', ({ sessionId, chipId }) => {
    showToast('Chip deslogado pelo WhatsApp', 'danger');
    addFeedItem('Chip', 'Deslogado pelo WhatsApp', null, 'error');
});

socket.on('activity', (data) => {
    addActivityItem(data);
    // Also add to live feed
    const chip = chips.find(c => c.id === data.chipId);
    const label = chip?.phone || chip?.name || `Chip ${data.chipId}`;
    addFeedItem(label, getActionLabel(data.action), data.message, getActionClass(data.action));
});

socket.on('phase_change', ({ chipId, phase, days }) => {
    const chip = chips.find(c => c.id === chipId);
    const name = chip?.phone || 'Chip';
    showToast(`${name} avancou para Fase ${phase} (${days} dias)`, 'warning');
    addFeedItem(name, `Fase ${phase} (${days}d)`, null, 'system');
});

socket.on('error', ({ message }) => {
    showToast(message, 'danger');
});

// ==================== TEMPERATURE SYSTEM ====================
function getTemperature(chip) {
    const progress = chip.messages_target > 0
        ? Math.min(100, Math.round((chip.messages_sent / chip.messages_target) * 100))
        : 0;

    if (progress < 15) return { level: 'cold', label: 'Frio', fires: '❄️', cls: 'cold' };
    if (progress < 40) return { level: 'warming', label: 'Aquecendo', fires: '🔥', cls: 'warming' };
    if (progress < 75) return { level: 'hot', label: 'Quente', fires: '🔥🔥', cls: 'hot' };
    return { level: 'ready', label: 'Pronto', fires: '🔥🔥🔥', cls: 'ready' };
}

// ==================== RENDER CHIPS ====================
function renderChips() {
    const grid = document.getElementById('chips-grid');

    if (chips.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📱</div>
                <h3>Nenhum chip cadastrado</h3>
                <p>Clique em "+ Chip" para conectar o primeiro</p>
            </div>`;
        return;
    }

    grid.innerHTML = chips.map(chip => {
        const progress = chip.messages_target > 0
            ? Math.min(100, Math.round((chip.messages_sent / chip.messages_target) * 100))
            : 0;
        const remaining = Math.max(0, chip.messages_target - chip.messages_sent);
        const temp = getTemperature(chip);
        const initial = (chip.name || chip.phone || 'C')[0].toUpperCase();
        const avatarClass = chip.status === 'warming' ? 'warming' : chip.status === 'disconnected' ? 'disconnected' : '';
        const avatarContent = chip.profile_pic
            ? `<img src="${chip.profile_pic}" alt="${initial}" onerror="this.parentElement.innerHTML='${initial}'">`
            : initial;

        return `
        <div class="chip-card status-${chip.status}" id="chip-${chip.id}">
            <div class="chip-header">
                <div class="chip-info">
                    <div class="chip-avatar ${avatarClass}">${avatarContent}</div>
                    <div>
                        <div class="chip-name">${chip.name || 'Chip ' + chip.id} <span class="btn-edit-name" onclick="editChipName(${chip.id}, '${(chip.name || '').replace(/'/g, "\\'")}')" title="Editar nome">✏️</span></div>
                        <div class="chip-phone">${chip.phone || 'Aguardando conexao...'}</div>
                    </div>
                </div>
                <div class="chip-status">
                    <span class="dot"></span>
                    ${getStatusLabel(chip.status)}
                    ${chip.proxy_ip ? `<div class="proxy-badge" title="Proxy ativo">🛡️ ${chip.proxy_ip}</div>` : '<div class="proxy-badge no-proxy">⚠️ Sem proxy</div>'}
                </div>
            </div>

            <div class="chip-temp">
                <div class="temp-bar-wrapper">
                    <div class="temp-label">
                        <span>Temperatura</span>
                        <span class="temp-status">${temp.label} — ${progress}%</span>
                    </div>
                    <div class="temp-bar">
                        <div class="temp-fill ${temp.cls}" style="width: ${progress}%"></div>
                    </div>
                </div>
                <div class="temp-fires">${temp.fires}</div>
            </div>

            <div class="chip-meta">
                <span class="chip-meta-item">
                    <span class="meta-icon">📊</span>
                    Fase <span class="badge badge-phase-${chip.phase}">${chip.phase}</span>
                </span>
                <span class="chip-meta-item">
                    <span class="meta-icon">💬</span>
                    ${formatNumber(chip.messages_sent)} msgs
                </span>
                ${chip.connected_at ? `<span class="chip-meta-item"><span class="meta-icon">📅</span>${formatDate(chip.connected_at)}</span>` : ''}
            </div>

            <div class="chip-actions">
                ${chip.status === 'warming'
                    ? `<button class="btn btn-warning btn-sm" onclick="stopWarming(${chip.id})">⏸ Pausar</button>`
                    : chip.status === 'connected'
                        ? `<button class="btn btn-success btn-sm" onclick="startWarming(${chip.id})">▶ Aquecer</button>`
                        : chip.status === 'disconnected'
                            ? `<button class="btn btn-primary btn-sm" onclick="reconnectChip('${chip.session_id}')">🔄 Reconectar</button>`
                            : chip.status === 'qr_pending'
                                ? `<button class="btn btn-primary btn-sm" onclick="retryQR('${chip.session_id}', ${chip.id})">📱 Gerar QR Code</button>`
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
        'connected': 'Online',
        'warming': 'Aquecendo',
        'disconnected': 'Offline',
        'qr_pending': 'QR Pendente',
        'paused': 'Pausado'
    };
    return labels[status] || status;
}

// ==================== ACTIONS ====================
function openQRModal() {
    document.getElementById('qr-modal').classList.add('active');
    document.getElementById('qr-step-name').style.display = 'block';
    document.getElementById('qr-step-scan').style.display = 'none';
    document.getElementById('chip-name-input').value = '';
    document.getElementById('chip-name-input').focus();
    currentQRSessionId = null;
}

// Enter no input de nome confirma
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('chip-name-input');
    if (nameInput) {
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') confirmChipName();
        });
    }
});

let chipCreating = false;
function confirmChipName() {
    if (chipCreating) return;
    chipCreating = true;
    const name = document.getElementById('chip-name-input').value.trim();
    document.getElementById('qr-step-name').style.display = 'none';
    document.getElementById('qr-step-scan').style.display = 'block';
    document.getElementById('qr-image').innerHTML = '<div class="qr-waiting">Gerando QR Code...</div>';
    document.getElementById('btn-next-qr').style.display = 'none';
    currentQRSessionId = null;
    socket.emit('request_qr', { name: name });
    setTimeout(() => { chipCreating = false; }, 5000);
}

let qrLoading = false;
function reloadQR() {
    if (qrLoading) return;
    qrLoading = true;
    document.getElementById('qr-image').innerHTML = '<div class="qr-waiting">Gerando QR Code...</div>';
    if (currentQRSessionId) {
        // Reconnect existing session instead of creating new
        socket.emit('reconnect_chip', { sessionId: currentQRSessionId });
    } else {
        const name = document.getElementById('chip-name-input').value.trim();
        socket.emit('request_qr', { name: name });
    }
    setTimeout(() => { qrLoading = false; }, 3000); // cooldown 3s
}

function closeQRModal() {
    document.getElementById('qr-modal').classList.remove('active');
    currentQRSessionId = null;
}

function nextQR() {
    document.getElementById('qr-step-name').style.display = 'block';
    document.getElementById('qr-step-scan').style.display = 'none';
    document.getElementById('chip-name-input').value = '';
    document.getElementById('chip-name-input').focus();
    currentQRSessionId = null;
}

function editChipName(chipId, currentName) {
    const newName = prompt('Nome do chip:', currentName);
    if (newName !== null && newName.trim() !== '') {
        fetch(`/api/chips/${chipId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim() })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                const idx = chips.findIndex(c => c.id === chipId);
                if (idx >= 0) chips[idx].name = newName.trim();
                renderChips();
                showToast('Nome atualizado', 'success');
            }
        });
    }
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
    showToast('Escala iniciada para todos os chips', 'success');
}

function stopAll() {
    socket.emit('stop_all');
    showToast('Aquecimento parado', 'warning');
}

function disconnectChip(chipId) {
    if (confirm('Desconectar este chip?')) {
        socket.emit('disconnect_chip', { chipId });
    }
}

function deleteChip(chipId) {
    if (confirm('Excluir este chip? A sessao sera removida.')) {
        socket.emit('delete_chip', { chipId });
        showToast('Chip excluido', 'danger');
    }
}

function reconnectChip(sessionId) {
    socket.emit('reconnect_chip', { sessionId });
    showToast('Reconectando...', 'accent');
}

function retryQR(sessionId, chipId) {
    if (qrLoading) return;
    qrLoading = true;
    document.getElementById('qr-modal').classList.add('active');
    document.getElementById('qr-step-name').style.display = 'none';
    document.getElementById('qr-step-scan').style.display = 'block';
    document.getElementById('qr-image').innerHTML = '<div class="qr-waiting">Gerando QR Code...</div>';
    document.getElementById('btn-next-qr').style.display = 'none';
    currentQRSessionId = sessionId;
    socket.emit('reconnect_chip', { sessionId });
    setTimeout(() => { qrLoading = false; }, 3000);
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

// ==================== LIVE FEED (SIDEBAR) ====================
const feedItems = [];
const MAX_FEED = 50;

function addFeedItem(chipLabel, detail, message, iconType) {
    const now = new Date();
    const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const icon = getFeedIcon(iconType);

    feedItems.unshift({ chipLabel, detail, message, iconType, icon, time });
    if (feedItems.length > MAX_FEED) feedItems.pop();
    renderFeed();
}

function renderFeed() {
    const feed = document.getElementById('live-feed');
    if (feedItems.length === 0) return;

    feed.innerHTML = feedItems.map((item, i) => `
        <div class="feed-item" ${i === 0 ? 'style="animation:feedFadeIn 0.4s ease"' : ''}>
            <div class="feed-icon ${item.iconType || 'system'}">${item.icon}</div>
            <div class="feed-content">
                <div class="feed-chip">${item.chipLabel}</div>
                <div class="feed-detail">${item.detail}${item.message ? ' — ' + truncate(item.message, 40) : ''}</div>
            </div>
            <div class="feed-time">${item.time}</div>
        </div>
    `).join('');
}

function getFeedIcon(type) {
    const icons = {
        'chat': '💬', 'audio': '🎤', 'group': '👥',
        'status': '📱', 'sticker': '🏷️', 'reaction': '👍',
        'error': '❌', 'connect': '🟢', 'system': '⚡'
    };
    return icons[type] || '📝';
}

function getActionLabel(action) {
    const labels = {
        'private_chat': 'Mensagem enviada',
        'audio': 'Audio enviado',
        'group_chat': 'Msg em grupo',
        'group_create': 'Grupo criado',
        'status': 'Status publicado',
        'sticker': 'Sticker enviado',
        'reaction': 'Reagiu a msg'
    };
    return labels[action] || action;
}

// ==================== ACTIVITY LOG (TAB) ====================
const activityItems = [];
const MAX_ACTIVITY = 100;

function addActivityItem(data) {
    activityItems.unshift(data);
    if (activityItems.length > MAX_ACTIVITY) activityItems.pop();
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
                <h3>Sem atividade</h3>
                <p>Eventos aparecerao aqui quando o aquecimento iniciar</p>
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
                ${item.target ? ` → <span class="activity-target">${item.target}</span>` : ''}
                ${item.message ? `<br><small style="color:var(--text-muted)">${truncate(item.message, 60)}</small>` : ''}
                ${!item.success ? '<br><small style="color:var(--danger)">Erro</small>' : ''}
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
    }).then(() => showToast('Config atualizada', 'success'));
}

// ==================== TABS ====================
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    const tabs = document.querySelectorAll('.tab');
    const tabMap = { 'chips': 0, 'activity': 1, 'config': 2, 'proxies': 3 };
    tabs[tabMap[tabName]].classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'activity') renderActivity();
    if (tabName === 'config') loadConfig();
    if (tabName === 'proxies') loadProxies();
}

// ==================== TEST MESSAGE ====================

function sendTestMessage() {
    fetch('/api/test-message', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast(`Teste enviado: ${data.from} → ${data.to}`, 'success');
            } else {
                showToast(data.error || 'Erro ao enviar teste', 'danger');
            }
        })
        .catch(() => showToast('Erro de conexao', 'danger'));
}

// ==================== PROXIES ====================

function loadProxies() {
    fetch('/api/proxies').then(r => r.json()).then(proxies => {
        renderProxyList(proxies);
    });
    fetch('/api/proxies/stats').then(r => r.json()).then(stats => {
        document.getElementById('proxy-stats').textContent =
            `${stats.total} total | ${stats.available} disponivel | ${stats.in_use} em uso`;
    });
}

function renderProxyList(proxies) {
    // Ordena: Em uso primeiro (por nome do chip), depois Disponível
    proxies.sort((a, b) => {
        const aUsed = a.assigned_chip_id ? 0 : 1;
        const bUsed = b.assigned_chip_id ? 0 : 1;
        if (aUsed !== bUsed) return aUsed - bUsed;
        // Dentro de "em uso", ordena por nome do chip
        if (a.assigned_chip_id && b.assigned_chip_id) {
            const chipA = chips.find(c => c.id === a.assigned_chip_id);
            const chipB = chips.find(c => c.id === b.assigned_chip_id);
            const nameA = (chipA?.name || '').toLowerCase();
            const nameB = (chipB?.name || '').toLowerCase();
            return nameA.localeCompare(nameB);
        }
        return 0;
    });
    const list = document.getElementById('proxy-list');
    if (proxies.length === 0) {
        list.innerHTML = `<div class="empty-state" style="padding:30px"><div class="empty-icon" style="font-size:28px">🔒</div><h3>Nenhum proxy cadastrado</h3><p>Adicione proxies acima para isolar cada chip com IP diferente</p></div>`;
        return;
    }
    list.innerHTML = `<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="border-bottom:1px solid var(--border)">
                <th style="padding:10px 14px;text-align:left;color:var(--text-muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Proxy</th>
                <th style="padding:10px 14px;text-align:left;color:var(--text-muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Status</th>
                <th style="padding:10px 14px;text-align:left;color:var(--text-muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Chip</th>
                <th style="padding:10px 14px;width:60px"></th>
            </tr></thead>
            <tbody>${proxies.map(p => {
                const chip = p.assigned_chip_id ? chips.find(c => c.id === p.assigned_chip_id) : null;
                const masked = p.url.replace(/\/\/(.*?)@/, '//***@');
                return `<tr style="border-bottom:1px solid rgba(0,0,0,0.03)">
                    <td style="padding:8px 14px;font-family:monospace;font-size:12px;color:var(--text-secondary)">${masked}</td>
                    <td style="padding:8px 14px"><span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;${p.assigned_chip_id ? 'background:rgba(249,115,22,0.08);color:var(--warming)' : 'background:rgba(34,197,94,0.08);color:var(--success)'}">${p.assigned_chip_id ? 'Em uso' : 'Disponivel'}</span></td>
                    <td style="padding:8px 14px;font-size:12px;color:var(--text-muted)">${chip ? ((chip.name ? chip.name + ' — ' : '') + (chip.phone || 'Chip ' + chip.id)) : '—'}</td>
                    <td style="padding:8px 14px"><button class="btn-icon danger" onclick="deleteOneProxy(${p.id})" title="Remover">✕</button></td>
                </tr>`;
            }).join('')}</tbody>
        </table>
    </div>`;
}

function addProxies() {
    const input = document.getElementById('proxy-input');
    const lines = input.value.split('\n').map(l => l.trim()).filter(l => l);
    if (lines.length === 0) return showToast('Cole pelo menos um proxy', 'warning');

    fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: lines })
    }).then(r => r.json()).then(data => {
        if (data.success) {
            showToast(`${data.added} proxies adicionados`, 'success');
            input.value = '';
            loadProxies();
        }
    });
}

function deleteOneProxy(id) {
    fetch(`/api/proxies/${id}`, { method: 'DELETE' })
        .then(() => { showToast('Proxy removido', 'danger'); loadProxies(); });
}

function deleteAllProxies() {
    if (!confirm('Remover todos os proxies?')) return;
    fetch('/api/proxies', { method: 'DELETE' })
        .then(() => { showToast('Todos os proxies removidos', 'danger'); loadProxies(); });
}

// ==================== LOGOUT ====================
function doLogout() {
    fetch('/api/logout', { method: 'POST' })
        .then(() => window.location.href = '/login');
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
    if (diffDays < 7) return `${diffDays}d`;
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

    const icons = {
        'success': '✓', 'danger': '✕',
        'warning': '⚠', 'accent': 'ℹ'
    };
    const colors = {
        'success': 'rgba(34,197,94,0.12)', 'danger': 'rgba(239,68,68,0.12)',
        'warning': 'rgba(249,115,22,0.12)', 'accent': 'rgba(59,130,246,0.12)'
    };
    const textColors = {
        'success': 'var(--success)', 'danger': 'var(--danger)',
        'warning': 'var(--warming)', 'accent': 'var(--accent)'
    };

    toast.innerHTML = `
        <div class="toast-icon" style="background:${colors[type] || colors.accent};color:${textColors[type] || textColors.accent}">${icons[type] || 'ℹ'}</div>
        <span>${message}</span>`;

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

document.getElementById('qr-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeQRModal();
});
