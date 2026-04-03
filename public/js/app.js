// ==================== KS DIGITAL — COMMAND CENTER ====================
const socket = io();
let chips = [];
let folders = [];
let currentQRSessionId = null;
let _pendingAdmConnect = false; // Auto-mark as ADM after QR connect

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
    loadFeedHistory();
    addFeedItem('system', 'Conectado ao servidor', null, 'system');
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

socket.on('folders_list', (list) => {
    folders = list;
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
        if (_pendingAdmConnect) {
            qrImage.innerHTML = `<div style="color:#8B5CF6;font-size:48px">👤</div><div style="margin-top:8px;color:#666;font-size:14px">ADM Conectado!<br><small>${phone || ''}</small></div>`;
        } else {
            qrImage.innerHTML = `<div style="color:#22C55E;font-size:48px">✓</div><div style="margin-top:8px;color:#666;font-size:14px">Conectado!<br><small>${phone || ''}</small></div>`;
        }
        document.getElementById('btn-next-qr').style.display = 'inline-flex';
    }
    // Auto-mark as ADM if connected via "Adicionar aos Grupos" flow
    if (_pendingAdmConnect && chipId) {
        _pendingAdmConnect = false;
        setInstanceType(chipId, 'admin');
        showToast(`ADM ${phone || ''} conectado e marcado!`, 'success');
        // Refresh group-add tab if visible
        setTimeout(() => loadAdminInstances(), 1000);
    } else {
        showToast(`Chip ${phone || 'novo'} conectado!`, 'success');
    }
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
function renderChipCard(chip) {
    const progress = chip.messages_target > 0
        ? Math.min(100, Math.round((chip.messages_sent / chip.messages_target) * 100))
        : 0;
    const temp = getTemperature(chip);
    const initial = (chip.name || chip.phone || 'C')[0].toUpperCase();
    const avatarClass = chip.status === 'warming' ? 'warming' : chip.status === 'disconnected' ? 'disconnected' : '';
    const avatarContent = chip.profile_pic
        ? `<img src="${chip.profile_pic}" alt="${initial}" onerror="this.parentElement.innerHTML='${initial}'">`
        : initial;

    const instanceBadge = chip.instance_type === 'admin'
        ? '<span class="instance-badge adm">ADM</span>'
        : '';
    const readyBadge = chip.phase >= 4 && chip.status !== 'discarded'
        ? '<span class="instance-badge ready">PRONTO</span>'
        : '';

    return `
    <div class="chip-card status-${chip.status}${_bulkSelected.has(chip.id) ? ' bulk-selected' : ''}" id="chip-${chip.id}" draggable="true" ondragstart="onDragStart(event, ${chip.id})">
        <input type="checkbox" class="bulk-checkbox" ${_bulkSelected.has(chip.id) ? 'checked' : ''} onclick="toggleBulkSelect(${chip.id}, event)" title="Selecionar">
        <div class="chip-header">
            <div class="chip-info">
                <div class="chip-avatar ${avatarClass}">${avatarContent}</div>
                <div class="chip-identity">
                    <div class="chip-name">${chip.name || 'Chip ' + chip.id} ${instanceBadge}${readyBadge} <span class="btn-edit-name" onclick="editChipName(${chip.id}, '${(chip.name || '').replace(/'/g, "\\'")}')" title="Editar nome">✏️</span></div>
                    <div class="chip-phone">${chip.phone || 'Aguardando conexao...'}</div>
                </div>
            </div>
            <div class="chip-status">
                <span class="dot"></span>
                ${getStatusLabel(chip.status)}
            </div>
        </div>

        <div class="chip-badges">
            ${chip.proxy_ip
                ? `<span class="proxy-badge" title="Proxy ativo">🛡️ ${chip.proxy_ip}</span>`
                : '<span class="proxy-badge no-proxy">⚠️ Sem proxy</span>'}
            ${getHealthBadgeHtml(chip.id)}
            ${getLastActivityHtml(chip.id)}
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
            ${chip.connected_at ? `<span class="chip-meta-item"><span class="meta-icon">📅</span> ${formatDate(chip.connected_at)}</span>` : ''}
        </div>

        <div class="chip-actions">
            ${chip.status === 'warming'
                ? `<button class="btn btn-warning btn-sm" onclick="stopWarming(${chip.id})">⏸ Pausar</button>${chip.phase >= 4 ? `<button class="btn btn-outline btn-sm" onclick="enterRehabUI(${chip.id})" title="Reabilitar">🏥</button>` : ''}`
                : chip.status === 'rehabilitation'
                    ? `<button class="btn btn-success btn-sm" onclick="resumeFromRehab(${chip.id})">▶ Voltar</button><button class="btn btn-danger btn-sm" onclick="discardChipUI(${chip.id})">✕ Descartar</button>`
                    : chip.status === 'connected'
                        ? `<button class="btn btn-success btn-sm" onclick="startWarming(${chip.id})">▶ Aquecer</button>`
                        : chip.status === 'discarded'
                            ? `<button class="btn btn-outline btn-sm" disabled>Descartado</button>`
                            : chip.status === 'disconnected'
                                ? `<button class="btn btn-primary btn-sm" onclick="reconnectChip('${chip.session_id}')">🔄 Reconectar</button>`
                                : chip.status === 'qr_pending'
                                    ? `<button class="btn btn-primary btn-sm" onclick="retryQR('${chip.session_id}', ${chip.id})">📱 Gerar QR Code</button>`
                                    : `<button class="btn btn-outline btn-sm" disabled>⏳ Aguardando...</button>`
            }
            ${chip.status !== 'discarded' ? `<button class="btn btn-outline btn-sm" onclick="disconnectChip(${chip.id})" ${chip.status === 'disconnected' ? 'disabled' : ''}>⏏ Desconectar</button>` : ''}
            ${['connected','warming','paused'].includes(chip.status) && (chip.instance_type || 'warming') === 'warming' ? `<button class="btn btn-outline btn-sm" onclick="setInstanceType(${chip.id},'admin')" title="Marcar como ADM do cliente">👤 ADM</button>` : ''}
            ${chip.instance_type === 'admin' ? `<button class="btn btn-outline btn-sm btn-adm-active" onclick="setInstanceType(${chip.id},'warming')" title="Voltar para aquecimento">👤 ADM ✓</button>` : ''}
            <button class="btn-icon" onclick="openChipHistory(${chip.id})" title="Historico">📋</button>
            <button class="btn-icon danger" onclick="deleteChip(${chip.id})" title="Excluir">✕</button>
        </div>
    </div>`;
}

function renderFolderSection(folderId, folderName, folderChips, isUnassigned) {
    const count = folderChips.length;
    const label = isUnassigned
        ? `Sem pasta (${count} chip${count !== 1 ? 's' : ''})`
        : `${folderName} (${count}/12)`;
    const dropId = isUnassigned ? 'drop-none' : `drop-folder-${folderId}`;
    const dataFolder = isUnassigned ? 'null' : folderId;
    const folderKey = isUnassigned ? 'none' : folderId;

    return `
    <div class="folder-section" id="${dropId}">
        <div class="folder-header" onclick="toggleFolder('${dropId}')">
            <div class="folder-header-left">
                <span class="folder-toggle" id="toggle-${dropId}">▼</span>
                <span class="folder-title">${isUnassigned ? '📂' : '📁'} ${label}</span>
                ${getFolderSummaryHtml(folderKey)}
            </div>
            ${!isUnassigned ? `
            <div class="folder-actions" onclick="event.stopPropagation()">
                <button class="btn-icon" onclick="renameFolder(${folderId}, '${folderName.replace(/'/g, "\\'")}')" title="Renomear">✏️</button>
                <button class="btn-icon danger" onclick="deleteFolderConfirm(${folderId})" title="Excluir pasta">🗑️</button>
            </div>` : ''}
        </div>
        <div class="folder-drop-zone chips-grid" data-folder="${dataFolder}"
             ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event)">
            ${folderChips.length > 0 ? folderChips.map(c => renderChipCard(c)).join('') : `
            <div class="empty-folder-hint">Arraste chips para esta pasta</div>`}
        </div>
    </div>`;
}

function renderChips() {
    const grid = document.getElementById('chips-grid');

    if (chips.length === 0 && folders.length === 0) {
        grid.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📱</div>
                <h3>Nenhum chip cadastrado</h3>
                <p>Clique em "+ Chip" para conectar o primeiro</p>
            </div>`;
        return;
    }

    let html = '';

    // Unassigned chips (no folder)
    const unassigned = chips.filter(c => !c.folder_id);
    if (unassigned.length > 0 || folders.length > 0) {
        html += renderFolderSection(null, null, unassigned, true);
    }

    // Each folder
    for (const folder of folders) {
        const folderChips = chips.filter(c => c.folder_id === folder.id);
        html += renderFolderSection(folder.id, folder.name, folderChips, false);
    }

    // If no folders and has chips, just render unassigned
    if (folders.length === 0 && unassigned.length > 0) {
        // Already rendered above
    }

    grid.innerHTML = html;
}

// ==================== FOLDER CRUD ====================
// ==================== MODAL INPUT/CONFIRM SYSTEM ====================
let _inputModalCallback = null;
let _confirmModalCallback = null;

function openInputModal(title, desc, defaultValue, callback) {
    document.getElementById('input-modal-title').textContent = title;
    document.getElementById('input-modal-desc').textContent = desc || '';
    document.getElementById('input-modal-value').value = defaultValue || '';
    document.getElementById('input-modal').classList.add('active');
    document.getElementById('input-modal-value').focus();
    _inputModalCallback = callback;
}

function closeInputModal() {
    document.getElementById('input-modal').classList.remove('active');
    _inputModalCallback = null;
}

function confirmInputModal() {
    const value = document.getElementById('input-modal-value').value.trim();
    if (!value) return;
    const cb = _inputModalCallback;
    closeInputModal();
    if (cb) cb(value);
}

// Enter no input modal confirma
document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('input-modal-value');
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') confirmInputModal(); });
});

function openConfirmModal(title, desc, btnText, callback) {
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-desc').textContent = desc || '';
    document.getElementById('confirm-modal-btn').textContent = btnText || 'Excluir';
    document.getElementById('confirm-modal').classList.add('active');
    _confirmModalCallback = callback;
}

function closeConfirmModal() {
    document.getElementById('confirm-modal').classList.remove('active');
    _confirmModalCallback = null;
}

function confirmConfirmModal() {
    const cb = _confirmModalCallback;
    closeConfirmModal();
    if (cb) cb();
}

// ==================== FOLDERS ====================

function createFolder() {
    openInputModal('Nova Pasta', 'Nome do cliente:', '', (name) => {
        fetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        }).then(r => r.json()).then(data => {
            if (data.success) {
                folders.push(data.folder);
                renderChips();
                showToast('Pasta criada: ' + data.folder.name, 'success');
            }
        });
    });
}

function renameFolder(id, currentName) {
    openInputModal('Renomear Pasta', 'Novo nome:', currentName, (name) => {
        fetch(`/api/folders/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        }).then(r => r.json()).then(data => {
            if (data.success) {
                const f = folders.find(f => f.id === id);
                if (f) f.name = name;
                renderChips();
                showToast('Pasta renomeada', 'success');
            }
        });
    });
}

function deleteFolderConfirm(id) {
    const folder = folders.find(f => f.id === id);
    openConfirmModal('Excluir Pasta', `Excluir "${folder?.name}"? Os chips serao movidos para "Sem pasta".`, 'Excluir', () => {
        fetch(`/api/folders/${id}`, { method: 'DELETE' }).then(r => r.json()).then(data => {
            if (data.success) {
                folders = folders.filter(f => f.id !== id);
                chips.forEach(c => { if (c.folder_id === id) delete c.folder_id; });
                renderChips();
                showToast('Pasta excluida', 'danger');
            }
        });
    });
}

function loadFolders() {
    fetch('/api/folders').then(r => r.json()).then(list => {
        folders = list;
        renderChips();
    });
}

// ==================== DRAG AND DROP ====================
let draggedChipId = null;

function onDragStart(event, chipId) {
    draggedChipId = chipId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', chipId);
    // Add visual feedback
    setTimeout(() => {
        const el = document.getElementById('chip-' + chipId);
        if (el) el.style.opacity = '0.4';
    }, 0);
}

function onDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const zone = event.currentTarget;
    if (!zone.classList.contains('drag-over')) {
        zone.classList.add('drag-over');
    }
}

function onDragLeave(event) {
    const zone = event.currentTarget;
    // Only remove if actually leaving the zone (not entering a child)
    if (!zone.contains(event.relatedTarget)) {
        zone.classList.remove('drag-over');
    }
}

function onDrop(event) {
    event.preventDefault();
    const zone = event.currentTarget;
    zone.classList.remove('drag-over');
    const chipId = parseInt(event.dataTransfer.getData('text/plain'));
    if (!chipId) return;

    const folderId = zone.dataset.folder === 'null' ? null : parseInt(zone.dataset.folder);

    // Restore opacity
    const el = document.getElementById('chip-' + chipId);
    if (el) el.style.opacity = '1';

    // Update locally
    const chip = chips.find(c => c.id === chipId);
    if (chip) {
        if (folderId === null) {
            delete chip.folder_id;
        } else {
            chip.folder_id = folderId;
        }
    }

    // Update server
    fetch(`/api/chips/${chipId}/folder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folderId })
    }).then(r => r.json()).then(data => {
        if (data.success) {
            renderChips();
        }
    });
}

// Listen for dragend to restore opacity if drop was cancelled
document.addEventListener('dragend', () => {
    if (draggedChipId) {
        const el = document.getElementById('chip-' + draggedChipId);
        if (el) el.style.opacity = '1';
        draggedChipId = null;
    }
});

function toggleFolder(dropId) {
    const zone = document.querySelector(`#${dropId} .folder-drop-zone`);
    const toggle = document.getElementById('toggle-' + dropId);
    if (!zone) return;
    if (zone.style.display === 'none') {
        zone.style.display = '';
        if (toggle) toggle.textContent = '▼';
    } else {
        zone.style.display = 'none';
        if (toggle) toggle.textContent = '▶';
    }
}

function getStatusLabel(status) {
    const labels = {
        'connected': 'Online',
        'warming': 'Aquecendo',
        'disconnected': 'Offline',
        'qr_pending': 'QR Pendente',
        'paused': 'Pausado',
        'rehabilitation': 'Em Reabilitação',
        'discarded': 'Descartado'
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
    _pendingAdmConnect = false;
}

function nextQR() {
    document.getElementById('qr-step-name').style.display = 'block';
    document.getElementById('qr-step-scan').style.display = 'none';
    document.getElementById('chip-name-input').value = '';
    document.getElementById('chip-name-input').focus();
    currentQRSessionId = null;
}

function editChipName(chipId, currentName) {
    openInputModal('Editar Nome', 'Nome do chip:', currentName, (newName) => {
        fetch(`/api/chips/${chipId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                const idx = chips.findIndex(c => c.id === chipId);
                if (idx >= 0) chips[idx].name = newName;
                renderChips();
                showToast('Nome atualizado', 'success');
            }
        });
    });
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
    openConfirmModal('Desconectar Chip', 'Deseja desconectar este chip?', 'Desconectar', () => {
        socket.emit('disconnect_chip', { chipId });
    });
}

function deleteChip(chipId) {
    openConfirmModal('Excluir Chip', 'Excluir este chip? A sessao sera removida permanentemente.', 'Excluir', () => {
        socket.emit('delete_chip', { chipId });
        showToast('Chip excluido', 'danger');
    });
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
    fetch('/api/folders')
        .then(r => r.json())
        .then(list => {
            folders = list;
            renderChips();
        });
    fetch('/api/stats')
        .then(r => r.json())
        .then(stats => {
            updateStat('stat-total', stats.total);
            updateStat('stat-connected', stats.connected);
            updateStat('stat-warming', stats.warming);
            updateStat('stat-messages', stats.totalMessages);
        });
}

// ==================== LIVE FEED (SIDEBAR) ====================
const feedItems = [];
const MAX_FEED = 50;

function loadFeedHistory() {
    fetch('/api/activity?limit=30')
        .then(r => r.json())
        .then(activities => {
            if (!activities || activities.length === 0) return;
            // Load in reverse order (oldest first) so newest ends up on top
            const sorted = activities.slice().reverse();
            for (const a of sorted) {
                const chip = chips.find(c => c.id === a.chip_id);
                const label = chip?.phone || chip?.name || `Chip ${a.chip_id}`;
                const time = new Date(a.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const iconType = getActionClass(a.action_type);
                const icon = getFeedIcon(iconType);
                const detail = getActionLabel(a.action_type);
                feedItems.unshift({ chipLabel: label, detail, message: a.details, iconType, icon, time });
                if (feedItems.length > MAX_FEED) feedItems.pop();
            }
            renderFeed();
        })
        .catch(() => {}); // silently fail if API not ready
}

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

    feed.innerHTML = feedItems.map((item, i) => {
        const colorClass = item.iconType === 'error' ? 'feed-error' : item.iconType === 'connect' || item.iconType === 'system' ? 'feed-info' : 'feed-success';
        return `
        <div class="feed-item ${colorClass}" ${i === 0 ? 'style="animation:feedFadeIn 0.4s ease"' : ''}>
            <div class="feed-icon ${item.iconType || 'system'}">${item.icon}</div>
            <div class="feed-content">
                <div class="feed-chip">${item.chipLabel}</div>
                <div class="feed-detail">${item.detail}${item.message ? ' — ' + truncate(item.message, 40) : ''}</div>
            </div>
            <div class="feed-time">${item.time}</div>
        </div>`;
    }).join('');
}

function getFeedIcon(type) {
    const icons = {
        'chat': '💬', 'audio': '🎤', 'group': '👥',
        'status': '📱', 'sticker': '🏷️', 'reaction': '👍',
        'error': '❌', 'connect': '🟢', 'system': '⚡',
        'location': '📍', 'image': '🖼️'
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
        'reaction': 'Reagiu a msg',
        'location': 'Localizacao enviada',
        'image': 'Imagem enviada'
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
        'reaction': '👍', 'error': '❌', 'location': '📍', 'image': '🖼️'
    };
    return icons[action] || '📝';
}

function getActionClass(action) {
    const classes = {
        'private_chat': 'chat', 'audio': 'audio', 'group_chat': 'group',
        'group_create': 'group', 'status': 'status', 'sticker': 'sticker',
        'reaction': 'reaction', 'error': 'error', 'location': 'location', 'image': 'image'
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
    const tabMap = { 'chips': 0, 'activity': 1, 'config': 2, 'rehab': 3, 'proxies': 4, 'groupadd': 5, 'adminmanage': 6 };
    tabs[tabMap[tabName]].classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'activity') renderActivity();
    if (tabName === 'config') loadConfig();
    if (tabName === 'rehab') loadRehab();
    if (tabName === 'proxies') loadProxies();
    if (tabName === 'groupadd') loadGroupAddTab();
    if (tabName === 'adminmanage') loadAdminManageTab();
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
                    <td style="padding:8px 14px;font-size:12px;color:var(--text-muted)">${chip ? (() => { const f = chip.folder_id ? folders.find(f => f.id === chip.folder_id) : null; return (f ? '<strong>' + f.name + '</strong> · ' : '') + (chip.name ? chip.name + ' — ' : '') + (chip.phone || 'Chip ' + chip.id); })() : '—'}</td>
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
    if (e.key === 'Escape') {
        closeQRModal();
        closeInputModal();
        closeConfirmModal();
    }
});

document.getElementById('qr-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeQRModal();
});
document.getElementById('input-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeInputModal();
});
document.getElementById('confirm-modal').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) closeConfirmModal();
});

// ==================== HEALTH MONITOR — ADDITIVE CODE ====================

// Global state for health data (populated by health_update socket event)
let _healthData = null;
let _dismissedAlerts = new Set();
let _activityFilter = 'all';

// Socket listener for health updates (emitted every 30s by server)
socket.on('health_update', (data) => {
    _healthData = data;
    updateHealthUI();
});

function updateHealthUI() {
    if (!_healthData) return;

    // Update stats cards with enriched data
    updateEnrichedStats(_healthData.enrichedStats);

    // Update alerts bar
    updateAlertsBar(_healthData.alerts);

    // Update rehab badge and suggestions
    updateRehabBadge();
    if (document.getElementById('tab-rehab') && document.getElementById('tab-rehab').classList.contains('active')) {
        updateRehabSuggestions();
    }

    // Re-render chips to update health badges (only if chips tab visible)
    if (document.getElementById('tab-chips').classList.contains('active')) {
        renderChips();
    }
}

// ==================== 3a. HEALTH BADGES ON CHIP CARDS ====================

function getHealthBadgeHtml(chipId) {
    if (!_healthData || !_healthData.chipHealth || !_healthData.chipHealth[chipId]) return '';
    const h = _healthData.chipHealth[chipId];
    const cls = 'health-' + h.status;
    const labels = { 'healthy': 'Saudavel', 'attention': 'Atencao', 'critical': 'Critico' };
    const label = labels[h.status] || h.status;
    return `<span class="health-badge ${cls}"><span class="health-dot"></span>${label}</span>`;
}

function getLastActivityHtml(chipId) {
    if (!_healthData || !_healthData.chipHealth || !_healthData.chipHealth[chipId]) return '';
    const h = _healthData.chipHealth[chipId];
    if (h.lastActivityMinutesAgo === null || h.lastActivityMinutesAgo === undefined) return '';
    const text = formatTimeAgo(h.lastActivityMinutesAgo);
    return `<span class="last-activity">${text} · ${h.todayMsgCount || 0} msgs</span>`;
}

function formatTimeAgo(minutes) {
    if (minutes < 1) return 'agora';
    if (minutes < 60) return 'ha ' + minutes + ' min';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return 'ha ' + hours + 'h';
    const days = Math.floor(hours / 24);
    return 'ha ' + days + 'd';
}

// ==================== 3b. ENHANCED STATS CARDS ====================

function updateEnrichedStats(stats) {
    if (!stats) return;

    // Update messages stat to show today's count
    const msgEl = document.getElementById('stat-messages');
    if (msgEl) {
        const current = parseInt(msgEl.dataset.raw || '0');
        msgEl.dataset.raw = stats.messagesToday;
        animateValue(msgEl, current, stats.messagesToday, 600);
    }

    // Update stat-sub for messages to say "hoje" and show rate
    const msgCard = msgEl ? msgEl.closest('.stat-card') : null;
    if (msgCard) {
        const sub = msgCard.querySelector('.stat-sub');
        if (sub) {
            sub.innerHTML = 'Hoje <span class="msg-rate">' + stats.msgsPerHour + ' msgs/hora</span>';
        }
    }

    // Add health summary below the warming stat
    const warmingSub = document.getElementById('stat-warming');
    const warmingCard = warmingSub ? warmingSub.closest('.stat-card') : null;
    if (warmingCard) {
        let summaryEl = warmingCard.querySelector('.health-summary');
        if (!summaryEl) {
            summaryEl = document.createElement('div');
            summaryEl.className = 'health-summary';
            warmingCard.appendChild(summaryEl);
        }
        summaryEl.innerHTML = buildHealthSummaryHtml(stats);
    }
}

function buildHealthSummaryHtml(stats) {
    let parts = [];
    if (stats.healthyCnt > 0) {
        parts.push('<span class="health-summary-item"><span class="hs-dot" style="background:#22C55E"></span>' + stats.healthyCnt + ' saudavel</span>');
    }
    if (stats.attentionCnt > 0) {
        parts.push('<span class="health-summary-item"><span class="hs-dot" style="background:#F97316"></span>' + stats.attentionCnt + ' atencao</span>');
    }
    if (stats.criticalCnt > 0) {
        parts.push('<span class="health-summary-item"><span class="hs-dot" style="background:#EF4444"></span>' + stats.criticalCnt + ' critico</span>');
    }
    return parts.join(' ');
}

// ==================== 3c. ALERTS BAR ====================

function updateAlertsBar(alerts) {
    const bar = document.getElementById('alerts-bar');
    if (!bar) return;

    // Filter dismissed alerts
    const active = (alerts || []).filter(a => !_dismissedAlerts.has(alertKey(a)));

    if (active.length === 0) {
        bar.style.display = 'none';
        return;
    }

    bar.style.display = 'flex';

    // Show max 5
    const visible = active.slice(0, 5);
    bar.innerHTML = visible.map(a => {
        const cls = a.level === 'critical' ? 'alert-critical' : 'alert-warning';
        const icon = a.level === 'critical' ? '🚨' : '⚠️';
        const key = alertKey(a).replace(/'/g, "\\'");
        return `<div class="alert-item ${cls}">
            <span class="alert-text">${icon} ${a.message}</span>
            <button class="alert-dismiss" onclick="dismissAlert('${key}')" title="Fechar">✕</button>
        </div>`;
    }).join('');
}

function alertKey(alert) {
    return (alert.chipId || '') + ':' + (alert.message || '');
}

function dismissAlert(key) {
    _dismissedAlerts.add(key);
    if (_healthData && _healthData.alerts) {
        updateAlertsBar(_healthData.alerts);
    }
}

// Clear dismissed alerts periodically (every 5 min) so new alerts of same type show again
setInterval(() => { _dismissedAlerts.clear(); }, 300000);

// ==================== 3d. FOLDER SUMMARY ====================

function getFolderSummaryHtml(folderKey) {
    if (!_healthData || !_healthData.folderSummaries || !_healthData.folderSummaries[folderKey]) return '';
    const s = _healthData.folderSummaries[folderKey];
    if (s.total === 0) return '';

    const statusLabels = { 'healthy': 'Saudavel', 'attention': 'Atencao', 'critical': 'Critico', 'empty': '' };
    const statusLabel = statusLabels[s.overallStatus] || '';
    const parts = [];
    parts.push(s.connected + '/' + s.total + ' chips');
    if (s.warming > 0) parts.push(s.warming + ' aquecendo');
    parts.push(s.todayMessages + ' msgs hoje');
    if (statusLabel) parts.push(statusLabel);

    return '<span class="folder-summary">' + parts.map((p, i) => {
        return (i > 0 ? '<span class="folder-summary-dot"></span>' : '') + p;
    }).join('') + '</span>';
}

// ==================== 3e. ACTIVITY FILTER ====================

function filterActivity(filter) {
    _activityFilter = filter;
    // Update button states
    document.querySelectorAll('.activity-filter-btn').forEach(btn => btn.classList.remove('active'));
    const buttons = document.querySelectorAll('.activity-filter-btn');
    if (filter === 'all' && buttons[0]) buttons[0].classList.add('active');
    if (filter === 'chip' && buttons[1]) buttons[1].classList.add('active');
    if (filter === 'errors' && buttons[2]) buttons[2].classList.add('active');
    renderActivity();
}

// Override renderActivity to respect filters — wrap original logic
const _originalRenderActivity = renderActivity;
renderActivity = function() {
    const log = document.getElementById('activity-log');
    let filtered = activityItems;

    if (_activityFilter === 'errors') {
        filtered = activityItems.filter(item => !item.success);
    } else if (_activityFilter === 'chip') {
        // Group by chip - show most recent per chip
        const seen = new Set();
        filtered = activityItems.filter(item => {
            if (seen.has(item.chipId)) return false;
            seen.add(item.chipId);
            return true;
        });
    }

    if (filtered.length === 0) {
        log.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📊</div>
                <h3>Sem atividade</h3>
                <p>${_activityFilter === 'errors' ? 'Nenhum erro encontrado' : 'Eventos aparecerao aqui quando o aquecimento iniciar'}</p>
            </div>`;
        return;
    }

    log.innerHTML = filtered.map(item => {
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
};

// ==================== REHABILITATION TAB ====================

function loadRehab() {
    fetch('/api/rehab').then(r => r.json()).then(rehabChips => {
        renderRehabList(rehabChips);
    });
    fetch('/api/stats').then(r => r.json()).then(stats => {
        renderRehabStatsBar(stats);
    });
    updateRehabSuggestions();
}

function renderRehabStatsBar(stats) {
    const el = document.getElementById('rehab-stats-bar');
    if (!el) return;
    el.innerHTML = `
        <div style="display:flex;gap:12px;margin-bottom:16px">
            <div class="rehab-stat-card">
                <div class="rehab-stat-icon">🏥</div>
                <div>
                    <div class="rehab-stat-value">${stats.rehabilitation || 0}</div>
                    <div class="rehab-stat-label">Em reabilitacao</div>
                </div>
            </div>
            <div class="rehab-stat-card">
                <div class="rehab-stat-icon">❌</div>
                <div>
                    <div class="rehab-stat-value">${stats.discarded || 0}</div>
                    <div class="rehab-stat-label">Descartados</div>
                </div>
            </div>
        </div>`;
}

function renderRehabList(rehabChips) {
    const list = document.getElementById('rehab-list');
    if (!list) return;

    if (rehabChips.length === 0) {
        list.innerHTML = `
            <div class="empty-state" style="padding:40px">
                <div class="empty-icon" style="font-size:36px">🏥</div>
                <h3>Nenhum chip em reabilitacao</h3>
                <p>Chips com problemas aparecerao aqui quando precisarem de recuperacao</p>
            </div>`;
        return;
    }

    list.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="border-bottom:1px solid var(--border)">
                <th class="rehab-th">Chip</th>
                <th class="rehab-th">Score</th>
                <th class="rehab-th">Proxy</th>
                <th class="rehab-th">Tempo</th>
                <th class="rehab-th">Motivo</th>
                <th class="rehab-th">Acoes</th>
            </tr></thead>
            <tbody>${rehabChips.map(chip => {
                const score = getHealthScoreForChip(chip.id);
                const scoreNum = typeof score === 'number' ? score : 0;
                const scoreClass = scoreNum >= 70 ? 'score-good' : scoreNum >= 40 ? 'score-warning' : 'score-critical';
                const duration = formatRehabDuration(chip.rehab_duration_min);
                return `<tr style="border-bottom:1px solid rgba(0,0,0,0.03)">
                    <td style="padding:10px 14px">
                        <div style="font-weight:600">${chip.name || 'Chip ' + chip.id}</div>
                        <div style="font-size:11px;color:var(--text-muted)">${chip.phone || 'Sem numero'}</div>
                    </td>
                    <td style="padding:10px 14px"><span class="rehab-score ${scoreClass}">${score}</span></td>
                    <td style="padding:10px 14px;font-size:12px;color:var(--text-muted)">${chip.proxy_ip ? '🛡️ ' + chip.proxy_ip : '⚠️ Sem proxy'}</td>
                    <td style="padding:10px 14px;font-size:12px">${duration}</td>
                    <td style="padding:10px 14px;font-size:12px;color:var(--text-secondary)">${chip.rehab_reason || '—'}</td>
                    <td style="padding:10px 14px">
                        <div style="display:flex;gap:6px">
                            <button class="btn btn-success btn-sm" onclick="resumeFromRehab(${chip.id})">▶ Voltar</button>
                            <button class="btn btn-danger btn-sm" onclick="discardChipUI(${chip.id})">✕ Descartar</button>
                        </div>
                    </td>
                </tr>`;
            }).join('')}</tbody>
        </table>
    </div>`;
}

function getHealthScoreForChip(chipId) {
    if (_healthData && _healthData.chipHealth && _healthData.chipHealth[chipId]) {
        return _healthData.chipHealth[chipId].score;
    }
    return '—';
}

function formatRehabDuration(minutes) {
    if (!minutes && minutes !== 0) return '—';
    if (minutes < 60) return minutes + ' min';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ' + (minutes % 60) + 'min';
    const days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
}

function updateRehabBadge() {
    const badge = document.getElementById('rehab-badge');
    if (!badge || !_healthData) return;
    const suggestions = (_healthData.rehabSuggestions || []).length;
    const inRehab = chips.filter(c => c.status === 'rehabilitation').length;
    const count = suggestions + inRehab;
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-flex';
    } else {
        badge.style.display = 'none';
    }
}

function updateRehabSuggestions() {
    const el = document.getElementById('rehab-suggestions');
    if (!el || !_healthData) return;

    const suggestions = _healthData.rehabSuggestions || [];
    const exitReady = _healthData.rehabExitReady || [];

    if (suggestions.length === 0 && exitReady.length === 0) {
        el.innerHTML = '';
        return;
    }

    let html = '';

    if (suggestions.length > 0) {
        html += '<div style="margin-bottom:12px"><h4 style="font-size:13px;color:var(--warning);margin-bottom:8px">⚠️ Sugestoes de Reabilitacao</h4>';
        html += suggestions.map(s => `
            <div class="rehab-suggestion-item">
                <span>${s.chipName} — Score: ${s.score} — ${s.reason}</span>
                <button class="btn btn-warning btn-sm" onclick="enterRehabUI(${s.chipId})">🏥 Reabilitar</button>
            </div>
        `).join('');
        html += '</div>';
    }

    if (exitReady.length > 0) {
        html += '<div style="margin-bottom:12px"><h4 style="font-size:13px;color:var(--success);margin-bottom:8px">✅ Prontos para Retornar</h4>';
        html += exitReady.map(s => `
            <div class="rehab-suggestion-item exit-ready">
                <span>${s.chipName} — Score: ${s.score}${s.rehabDuration ? ' — ' + formatRehabDuration(s.rehabDuration) + ' em rehab' : ''}</span>
                <button class="btn btn-success btn-sm" onclick="resumeFromRehab(${s.chipId})">▶ Voltar</button>
            </div>
        `).join('');
        html += '</div>';
    }

    el.innerHTML = html;
}

function enterRehabUI(chipId) {
    const chip = chips.find(c => c.id === chipId);
    const chipName = chip?.name || chip?.phone || 'Chip ' + chipId;
    openConfirmModal('Reabilitar Chip', 'Enviar "' + chipName + '" para reabilitacao? O aquecimento sera reduzido para recuperacao controlada.', 'Reabilitar', () => {
        fetch('/api/chips/' + chipId + '/rehab/enter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'manual' })
        })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Chip enviado para reabilitacao', 'warning');
                refreshChips();
            } else {
                showToast(data.error || 'Erro', 'danger');
            }
        });
    });
}

function resumeFromRehab(chipId) {
    const chip = chips.find(c => c.id === chipId);
    const chipName = chip?.name || chip?.phone || 'Chip ' + chipId;
    openConfirmModal('Voltar para Operacao', 'Retornar "' + chipName + '" para aquecimento normal (Fase 3)?', 'Confirmar', () => {
        fetch('/api/chips/' + chipId + '/rehab/resume', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Chip retornado ao aquecimento normal', 'success');
                refreshChips();
                if (document.getElementById('tab-rehab').classList.contains('active')) loadRehab();
            } else {
                showToast(data.error || 'Erro', 'danger');
            }
        });
    });
}

function discardChipUI(chipId) {
    const chip = chips.find(c => c.id === chipId);
    const chipName = chip?.name || chip?.phone || 'Chip ' + chipId;
    openConfirmModal('Descartar Chip', 'Marcar "' + chipName + '" como descartado? O chip sera desativado.', 'Descartar', () => {
        fetch('/api/chips/' + chipId + '/discard', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                showToast('Chip descartado', 'danger');
                refreshChips();
                if (document.getElementById('tab-rehab').classList.contains('active')) loadRehab();
            } else {
                showToast(data.error || 'Erro', 'danger');
            }
        });
    });
}

// ==================== GROUP ADD TAB ====================

let _gaGroups = [];
let _gaSelectedGroups = new Set();
let _gaSelectedChips = new Set();
let _gaWarmingChips = [];
let _gaRunning = false;
let _gaPaused = false;
let _gaCurrentOpId = null;
let _gaLogItems = [];

function loadGroupAddTab() {
    loadAdminInstances();
    loadWarmingChipsForGA();
}

// ==================== ADMIN INSTANCES ====================

function connectAdmInstance() {
    _pendingAdmConnect = true;
    openQRModal();
    // Pre-fill name hint
    const nameInput = document.getElementById('chip-name-input');
    if (nameInput) {
        nameInput.value = 'ADM ';
        nameInput.focus();
        nameInput.setSelectionRange(4, 4);
    }
}

function markExistingAsAdm() {
    // Show connected chips that aren't ADM yet
    const available = chips.filter(c => c.status === 'connected' && (c.instance_type || 'warming') === 'warming');
    if (available.length === 0) {
        showToast('Nenhum chip conectado disponivel para marcar como ADM', 'warning');
        return;
    }
    const options = available.map(c => `${c.name || 'Chip ' + c.id} (${c.phone || 'sem numero'})`);
    const choice = prompt('Chips disponiveis:\n\n' + options.map((o, i) => `${i + 1}. ${o}`).join('\n') + '\n\nDigite o numero:');
    if (!choice) return;
    const idx = parseInt(choice) - 1;
    if (idx >= 0 && idx < available.length) {
        setInstanceType(available[idx].id, 'admin');
        setTimeout(() => loadAdminInstances(), 500);
    }
}

function loadAdminInstances() {
    fetch('/api/admin-instances').then(r => r.json()).then(admins => {
        const select = document.getElementById('ga-admin-select');
        const current = select.value;
        select.innerHTML = '<option value="">Selecione uma instancia ADM...</option>';
        if (admins.length === 0) {
            document.getElementById('ga-no-admin').style.display = 'block';
        } else {
            document.getElementById('ga-no-admin').style.display = 'none';
        }
        for (const adm of admins) {
            const label = (adm.name || 'ADM') + (adm.phone ? ' (' + adm.phone + ')' : '');
            const status = adm.is_connected ? '🟢' : '🔴';
            const opt = document.createElement('option');
            opt.value = adm.id;
            opt.textContent = status + ' ' + label;
            opt.disabled = !adm.is_connected;
            select.appendChild(opt);
        }
        if (current) select.value = current;
    });
}

function onAdminInstanceSelect() {
    const chipId = document.getElementById('ga-admin-select').value;
    const infoEl = document.getElementById('ga-admin-info');
    const panels = document.getElementById('ga-panels');

    if (!chipId) {
        infoEl.style.display = 'none';
        panels.style.display = 'none';
        hideSummary();
        return;
    }

    infoEl.style.display = 'block';
    infoEl.innerHTML = '<div class="ga-loading">Buscando grupos...</div>';
    panels.style.display = 'none';

    fetch('/api/admin-instances/' + chipId + '/groups')
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                infoEl.innerHTML = '<div class="ga-error">' + data.error + '</div>';
                return;
            }
            _gaGroups = data;
            _gaSelectedGroups.clear();
            infoEl.innerHTML = '<span class="ga-success-text">🟢 Conectado — ' + data.length + ' grupos encontrados onde e admin</span>';
            panels.style.display = 'grid';
            renderGAGroups();
            renderGAChips();
        })
        .catch(err => {
            infoEl.innerHTML = '<div class="ga-error">Erro: ' + err.message + '</div>';
        });
}

// ==================== GROUPS LIST ====================

function renderGAGroups() {
    const list = document.getElementById('ga-groups-list');
    const search = (document.getElementById('ga-groups-search')?.value || '').toLowerCase();
    document.getElementById('ga-groups-count').textContent = _gaGroups.length;

    const filtered = search ? _gaGroups.filter(g => (g.subject || '').toLowerCase().includes(search)) : _gaGroups;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="ga-empty">Nenhum grupo encontrado</div>';
        return;
    }

    list.innerHTML = filtered.map(g => {
        const checked = _gaSelectedGroups.has(g.id) ? 'checked' : '';
        return `<label class="ga-item ${checked ? 'selected' : ''}">
            <input type="checkbox" ${checked} onchange="gaToggleGroup('${g.id}')">
            <div class="ga-item-info">
                <div class="ga-item-name">${g.subject || 'Sem nome'}</div>
                <div class="ga-item-meta">${g.size} participantes</div>
            </div>
        </label>`;
    }).join('');

    updateGASummary();
}

function gaFilterGroups() { renderGAGroups(); }

function gaToggleGroup(groupId) {
    if (_gaSelectedGroups.has(groupId)) {
        _gaSelectedGroups.delete(groupId);
    } else {
        _gaSelectedGroups.add(groupId);
    }
    renderGAGroups();
}

function gaSelectAllGroups() {
    for (const g of _gaGroups) _gaSelectedGroups.add(g.id);
    renderGAGroups();
}

function gaDeselectAllGroups() {
    _gaSelectedGroups.clear();
    renderGAGroups();
}

// ==================== CHIPS LIST ====================

function loadWarmingChipsForGA() {
    fetch('/api/warming-chips').then(r => r.json()).then(list => {
        _gaWarmingChips = list;
        renderGAChips();
    });
}

function renderGAChips() {
    const list = document.getElementById('ga-chips-list');
    if (!list) return;

    if (_gaWarmingChips.length === 0) {
        list.innerHTML = '<div class="ga-empty">Nenhum chip em aquecimento com numero</div>';
        return;
    }

    list.innerHTML = _gaWarmingChips.map(c => {
        const checked = _gaSelectedChips.has(c.id) ? 'checked' : '';
        const statusLabel = getStatusLabel(c.status);
        return `<label class="ga-item ${checked ? 'selected' : ''}">
            <input type="checkbox" ${checked} onchange="gaToggleChip(${c.id})">
            <div class="ga-item-info">
                <div class="ga-item-name">${c.name || 'Chip ' + c.id}</div>
                <div class="ga-item-meta">${c.phone} · Fase ${c.phase} · ${statusLabel}</div>
            </div>
        </label>`;
    }).join('');

    updateGASummary();
}

function gaToggleChip(chipId) {
    if (_gaSelectedChips.has(chipId)) {
        _gaSelectedChips.delete(chipId);
    } else {
        _gaSelectedChips.add(chipId);
    }
    renderGAChips();
}

function gaSelectAllChips() {
    for (const c of _gaWarmingChips) _gaSelectedChips.add(c.id);
    renderGAChips();
}

function gaDeselectAllChips() {
    _gaSelectedChips.clear();
    renderGAChips();
}

// ==================== SUMMARY ====================

function updateGASummary() {
    const summaryEl = document.getElementById('ga-summary');
    const groupCount = _gaSelectedGroups.size;
    const chipCount = _gaSelectedChips.size;
    const manualText = (document.getElementById('ga-manual-numbers')?.value || '').trim();
    const manualCount = manualText ? manualText.split(/[\n,;]+/).filter(l => l.trim()).length : 0;
    const totalNumbers = chipCount + manualCount;
    const totalAdds = groupCount * totalNumbers;

    if (groupCount === 0 || totalNumbers === 0) {
        summaryEl.style.display = 'none';
        return;
    }

    const adminSelect = document.getElementById('ga-admin-select');
    const adminText = adminSelect.options[adminSelect.selectedIndex]?.textContent || '?';
    const estMinutes = Math.ceil(totalAdds * 12 / 60); // ~12s avg per add

    summaryEl.style.display = 'block';
    summaryEl.innerHTML = `
        <div class="ga-summary-card">
            <div class="ga-summary-title">Resumo da Operacao</div>
            <div class="ga-summary-grid">
                <div class="ga-summary-row"><span>Instancia ADM:</span><strong>${adminText}</strong></div>
                <div class="ga-summary-row"><span>Grupos alvo:</span><strong>${groupCount} grupos</strong></div>
                <div class="ga-summary-row"><span>Numeros:</span><strong>${chipCount} chips${manualCount > 0 ? ' + ' + manualCount + ' manuais' : ''} = ${totalNumbers}</strong></div>
                <div class="ga-summary-row"><span>Total adicoes:</span><strong>${totalAdds} (${totalNumbers} x ${groupCount})</strong></div>
                <div class="ga-summary-row"><span>Promover a admin:</span><strong>Sim (todos)</strong></div>
                <div class="ga-summary-row"><span>Estimativa:</span><strong>~${estMinutes} minutos</strong></div>
            </div>
            <button class="btn btn-success" onclick="gaStartOperation()" id="ga-btn-start" style="margin-top:16px;width:100%">
                Iniciar Adicao
            </button>
        </div>`;
}

function hideSummary() {
    const el = document.getElementById('ga-summary');
    if (el) el.style.display = 'none';
}

// Listen for manual numbers textarea changes
document.addEventListener('DOMContentLoaded', () => {
    const manualEl = document.getElementById('ga-manual-numbers');
    if (manualEl) {
        manualEl.addEventListener('input', () => updateGASummary());
    }
});

// ==================== EXECUTION ====================

function gaStartOperation() {
    const adminChipId = parseInt(document.getElementById('ga-admin-select').value);
    if (!adminChipId) return showToast('Selecione uma instancia ADM', 'warning');
    if (_gaSelectedGroups.size === 0) return showToast('Selecione pelo menos 1 grupo', 'warning');

    const chipIds = Array.from(_gaSelectedChips);
    const manualNumbers = document.getElementById('ga-manual-numbers')?.value || '';

    if (chipIds.length === 0 && !manualNumbers.trim()) {
        return showToast('Selecione chips ou cole numeros manuais', 'warning');
    }

    const selectedGroups = _gaGroups.filter(g => _gaSelectedGroups.has(g.id));
    const config = {
        delayMin: 5, delayMax: 15,
        groupDelayMin: 30, groupDelayMax: 60,
        checkExists: true
    };

    document.getElementById('ga-btn-start').disabled = true;
    document.getElementById('ga-btn-start').textContent = 'Iniciando...';

    fetch('/api/group-add/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            adminChipId, chipIds, manualNumbers,
            groups: selectedGroups, config
        })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            _gaCurrentOpId = data.operationId;
            _gaRunning = true;
            _gaPaused = false;
            _gaLogItems = [];
            showExecutionUI(data.totalItems);
            showToast('Operacao iniciada!', 'success');
        } else {
            showToast(data.error || 'Erro ao iniciar', 'danger');
            document.getElementById('ga-btn-start').disabled = false;
            document.getElementById('ga-btn-start').textContent = 'Iniciar Adicao';
        }
    })
    .catch(err => {
        showToast('Erro: ' + err.message, 'danger');
        document.getElementById('ga-btn-start').disabled = false;
        document.getElementById('ga-btn-start').textContent = 'Iniciar Adicao';
    });
}

function showExecutionUI(totalItems) {
    document.getElementById('ga-summary').style.display = 'none';
    document.getElementById('ga-execution').style.display = 'block';
    document.getElementById('ga-report').style.display = 'none';
    document.getElementById('ga-progress-text').textContent = '0/' + totalItems + ' adicoes (0%)';
    document.getElementById('ga-progress-fill').style.width = '0%';
    document.getElementById('ga-progress-stats').innerHTML = '';
    document.getElementById('ga-log').innerHTML = '';
    document.getElementById('ga-btn-pause').textContent = 'Pausar';
}

function gaTogglePause() {
    if (_gaPaused) {
        fetch('/api/group-add/resume', { method: 'POST' });
        _gaPaused = false;
        document.getElementById('ga-btn-pause').textContent = 'Pausar';
    } else {
        fetch('/api/group-add/pause', { method: 'POST' });
        _gaPaused = true;
        document.getElementById('ga-btn-pause').textContent = 'Retomar';
    }
}

function gaStop() {
    openConfirmModal('Parar Operacao', 'Deseja parar a operacao em andamento? Itens ja processados serao mantidos.', 'Parar', () => {
        fetch('/api/group-add/stop', { method: 'POST' });
        _gaRunning = false;
    });
}

// ==================== SOCKET LISTENERS FOR GROUP ADD ====================

socket.on('group_add_stats', (data) => {
    if (!_gaRunning) return;
    document.getElementById('ga-progress-text').textContent =
        data.processed + '/' + data.total + ' adicoes (' + data.percent + '%)';
    document.getElementById('ga-progress-fill').style.width = data.percent + '%';
    document.getElementById('ga-progress-stats').innerHTML = `
        <span class="ga-stat-item ga-stat-success">✅ ${data.success}</span>
        <span class="ga-stat-item ga-stat-admin">👑 ${data.adminOk} admins</span>
        <span class="ga-stat-item ga-stat-skip">⏭️ ${data.skip}</span>
        <span class="ga-stat-item ga-stat-fail">❌ ${data.fail}</span>
        ${data.adminFail > 0 ? '<span class="ga-stat-item ga-stat-warn">⚠️ ' + data.adminFail + ' sem admin</span>' : ''}
        ${data.currentGroup ? '<span class="ga-stat-item ga-stat-group">📂 ' + data.currentGroup + '</span>' : ''}
    `;
});

socket.on('group_add_log', (data) => {
    if (!document.getElementById('ga-log')) return;
    const icons = {
        'success': '✅', 'admin': '👑', 'admin_fail': '⚠️',
        'skip': '⏭️', 'error': '❌', 'warning': '⚠️',
        'info': 'ℹ️', 'system': '🔄'
    };
    const icon = icons[data.type] || '📝';
    const time = new Date(data.timestamp || Date.now()).toLocaleTimeString('pt-BR');
    const cls = data.type === 'error' ? 'ga-log-error' : data.type === 'admin' ? 'ga-log-admin' : data.type === 'success' ? 'ga-log-success' : data.type === 'warning' || data.type === 'admin_fail' ? 'ga-log-warn' : 'ga-log-info';

    const logEl = document.getElementById('ga-log');
    const item = document.createElement('div');
    item.className = 'ga-log-item ' + cls;
    item.innerHTML = '<span class="ga-log-icon">' + icon + '</span><span class="ga-log-msg">' + data.message + '</span><span class="ga-log-time">' + time + '</span>';
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
});

socket.on('group_add_status', (data) => {
    if (data.status === 'completed' || data.status === 'stopped' || data.status === 'failed') {
        _gaRunning = false;
        _gaPaused = false;
    }
});

socket.on('group_add_complete', (summary) => {
    _gaRunning = false;
    document.getElementById('ga-execution').style.display = 'none';
    showGAReport(summary);
    showToast('Operacao concluida! ' + summary.success + ' adicionados', 'success');

    // Reset start button
    const btn = document.getElementById('ga-btn-start');
    if (btn) { btn.disabled = false; btn.textContent = 'Iniciar Adicao'; }
});

// ==================== REPORT ====================

function showGAReport(summary) {
    const el = document.getElementById('ga-report');
    el.style.display = 'block';

    const durationMin = Math.floor(summary.duration / 60);
    const durationSec = summary.duration % 60;
    const durationText = durationMin > 0 ? durationMin + 'min ' + durationSec + 's' : durationSec + 's';

    el.innerHTML = `
        <div class="ga-report-card">
            <div class="ga-report-header">${summary.status === 'completed' ? '✅ Operacao Concluida' : summary.status === 'stopped' ? '⏹ Operacao Parada' : '❌ Operacao Falhou'}</div>
            <div class="ga-report-grid">
                <div class="ga-report-stat">
                    <div class="ga-report-value">${summary.total}</div>
                    <div class="ga-report-label">Total</div>
                </div>
                <div class="ga-report-stat success">
                    <div class="ga-report-value">${summary.success}</div>
                    <div class="ga-report-label">Adicionados</div>
                </div>
                <div class="ga-report-stat admin">
                    <div class="ga-report-value">${summary.adminPromoted}</div>
                    <div class="ga-report-label">Admins ✅</div>
                </div>
                <div class="ga-report-stat skip">
                    <div class="ga-report-value">${summary.skip}</div>
                    <div class="ga-report-label">Ja membros</div>
                </div>
                <div class="ga-report-stat fail">
                    <div class="ga-report-value">${summary.fail}</div>
                    <div class="ga-report-label">Falhas</div>
                </div>
                <div class="ga-report-stat warn">
                    <div class="ga-report-value">${summary.adminFailed || 0}</div>
                    <div class="ga-report-label">Sem admin ⚠️</div>
                </div>
            </div>
            <div class="ga-report-duration">Duracao: ${durationText}</div>
            <div class="ga-report-actions">
                <button class="btn btn-outline btn-sm" onclick="gaExportCSV(${summary.operationId})">Exportar CSV</button>
                ${summary.fail > 0 ? '<button class="btn btn-warning btn-sm" onclick="gaRetry(' + summary.operationId + ')">Reexecutar falhas (' + summary.fail + ')</button>' : ''}
                <button class="btn btn-primary btn-sm" onclick="gaNewOperation()">Nova Operacao</button>
            </div>
        </div>`;
}

function gaExportCSV(opId) {
    window.open('/api/group-add/operations/' + opId + '/csv', '_blank');
}

function gaRetry(opId) {
    openConfirmModal('Reexecutar Falhas', 'Reexecutar apenas os itens que falharam?', 'Reexecutar', () => {
        fetch('/api/group-add/retry/' + opId, { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                _gaCurrentOpId = data.operationId;
                _gaRunning = true;
                _gaPaused = false;
                _gaLogItems = [];
                showExecutionUI(data.retrying);
                showToast('Reexecutando ' + data.retrying + ' itens', 'success');
            } else {
                showToast(data.error || 'Erro', 'danger');
            }
        });
    });
}

function gaNewOperation() {
    document.getElementById('ga-report').style.display = 'none';
    document.getElementById('ga-execution').style.display = 'none';
    document.getElementById('ga-summary').style.display = 'none';
    _gaSelectedGroups.clear();
    _gaSelectedChips.clear();
    if (document.getElementById('ga-manual-numbers')) document.getElementById('ga-manual-numbers').value = '';
    renderGAGroups();
    renderGAChips();
    const btn = document.getElementById('ga-btn-start');
    if (btn) { btn.disabled = false; btn.textContent = 'Iniciar Adicao'; }
}

// ==================== HISTORY ====================

function loadGroupAddHistory() {
    const el = document.getElementById('ga-history');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    if (el.style.display === 'none') return;

    el.innerHTML = '<div class="ga-loading">Carregando historico...</div>';

    fetch('/api/group-add/operations?limit=20')
    .then(r => r.json())
    .then(ops => {
        if (ops.length === 0) {
            el.innerHTML = '<div class="ga-empty" style="padding:20px">Nenhuma operacao realizada ainda</div>';
            return;
        }
        el.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead><tr style="border-bottom:1px solid var(--border)">
                    <th class="rehab-th">Data</th>
                    <th class="rehab-th">ADM</th>
                    <th class="rehab-th">Total</th>
                    <th class="rehab-th">Sucesso</th>
                    <th class="rehab-th">Admin</th>
                    <th class="rehab-th">Falhas</th>
                    <th class="rehab-th">Status</th>
                    <th class="rehab-th">Acoes</th>
                </tr></thead>
                <tbody>${ops.map(op => {
                    const date = op.created_at ? new Date(op.created_at).toLocaleString('pt-BR') : '—';
                    const statusCls = op.status === 'completed' ? 'ga-status-ok' : op.status === 'running' ? 'ga-status-run' : op.status === 'failed' ? 'ga-status-fail' : 'ga-status-other';
                    return `<tr style="border-bottom:1px solid rgba(0,0,0,0.03)">
                        <td style="padding:8px 14px;font-size:12px">${date}</td>
                        <td style="padding:8px 14px;font-size:12px">${op.admin_name || op.admin_phone || '—'}</td>
                        <td style="padding:8px 14px">${op.total_additions}</td>
                        <td style="padding:8px 14px;color:var(--success)">${op.success_count}</td>
                        <td style="padding:8px 14px;color:#8B5CF6">${op.admin_promoted_count}</td>
                        <td style="padding:8px 14px;color:var(--danger)">${op.fail_count}</td>
                        <td style="padding:8px 14px"><span class="${statusCls}">${op.status}</span></td>
                        <td style="padding:8px 14px">
                            <button class="btn btn-outline btn-xs" onclick="gaExportCSV(${op.id})">CSV</button>
                            ${op.fail_count > 0 ? '<button class="btn btn-warning btn-xs" onclick="gaRetry(' + op.id + ')" style="margin-left:4px">Retry</button>' : ''}
                        </td>
                    </tr>`;
                }).join('')}</tbody>
            </table>
        </div>`;
    });
}

// ==================== MARK AS ADM (from chip card) ====================

function setInstanceType(chipId, type) {
    fetch('/api/chips/' + chipId + '/set-type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            const chip = chips.find(c => c.id === chipId);
            if (chip) chip.instance_type = type;
            renderChips();
            showToast(type === 'admin' ? 'Marcado como ADM' : 'Marcado como Aquecimento', 'success');
        } else {
            showToast(data.error || 'Erro', 'danger');
        }
    });
}

// ==================== DASHBOARD CHARTS ====================

let _chartsVisible = false;
let _chartMsg = null;
let _chartPhase = null;

function toggleCharts() {
    const grid = document.getElementById('charts-grid');
    const icon = document.getElementById('chart-toggle-icon');
    _chartsVisible = !_chartsVisible;
    grid.style.display = _chartsVisible ? 'grid' : 'none';
    icon.textContent = _chartsVisible ? '▲' : '▼';
    if (_chartsVisible) loadDashboardCharts();
}

function loadDashboardCharts() {
    Promise.all([
        fetch('/api/dashboard/daily-stats?days=7').then(r => r.json()),
        fetch('/api/dashboard/summary').then(r => r.json())
    ]).then(([daily, summary]) => {
        renderMessagesChart(daily);
        renderPhasesChart(summary.phases);
    }).catch(() => {});
}

function renderMessagesChart(data) {
    const ctx = document.getElementById('chart-messages');
    if (!ctx) return;
    if (_chartMsg) _chartMsg.destroy();
    const labels = data.map(d => { const p = d.date?.split('-'); return p ? p[2] + '/' + p[1] : ''; });
    const values = data.map(d => d.today_messages || 0);
    _chartMsg = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Msgs/dia', data: values, backgroundColor: 'rgba(99,102,241,0.5)', borderRadius: 6, borderSkipped: false }]
        },
        options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' } }, x: { grid: { display: false } } } }
    });
}

function renderPhasesChart(phases) {
    const ctx = document.getElementById('chart-phases');
    if (!ctx) return;
    if (_chartPhase) _chartPhase.destroy();
    _chartPhase = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Fase 1', 'Fase 2', 'Fase 3', 'Fase 4'],
            datasets: [{ data: [phases[1]||0, phases[2]||0, phases[3]||0, phases[4]||0], backgroundColor: ['#dc2626', '#ca8a04', '#ea580c', '#16a34a'], borderWidth: 0 }]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 } } } }, cutout: '60%' }
    });
}

// ==================== CONFIG SUB-TABS ====================

function switchConfigSub(name) {
    document.querySelectorAll('.config-sub').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.config-subtab').forEach(el => el.classList.remove('active'));
    const sub = document.getElementById('config-sub-' + name);
    if (sub) sub.classList.add('active');
    if (event && event.target) event.target.classList.add('active');
    if (name === 'schedule') loadScheduleSettings();
    if (name === 'notifications') loadNotifSettings();
    if (name === 'proxy-rotation') loadProxyRotSettings();
    if (name === 'media') loadAllMedia();
    if (name === 'messages') loadCustomMessages();
}

// ==================== SCHEDULE SETTINGS ====================

function loadScheduleSettings() {
    fetch('/api/settings').then(r => r.json()).then(s => {
        const sched = s.schedule || {};
        document.getElementById('sched-enabled').checked = sched.enabled || false;
        document.getElementById('sched-start-h').value = sched.start_hour ?? 8;
        document.getElementById('sched-start-m').value = sched.start_min ?? 0;
        document.getElementById('sched-stop-h').value = sched.stop_hour ?? 22;
        document.getElementById('sched-stop-m').value = sched.stop_min ?? 0;
    });
}

function saveScheduleSettings() {
    const data = {
        enabled: document.getElementById('sched-enabled').checked,
        start_hour: parseInt(document.getElementById('sched-start-h').value) || 8,
        start_min: parseInt(document.getElementById('sched-start-m').value) || 0,
        stop_hour: parseInt(document.getElementById('sched-stop-h').value) || 22,
        stop_min: parseInt(document.getElementById('sched-stop-m').value) || 0
    };
    fetch('/api/settings/schedule', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
        .then(() => showToast('Agendamento salvo', 'success'));
}

// ==================== NOTIFICATION SETTINGS ====================

function loadNotifSettings() {
    fetch('/api/settings').then(r => r.json()).then(s => {
        const n = s.notifications || {};
        document.getElementById('notif-enabled').checked = n.enabled || false;
        document.getElementById('notif-phone').value = n.phone || '';
        const events = n.events || [];
        document.querySelectorAll('.notif-event').forEach(cb => { cb.checked = events.includes(cb.value); });
    });
}

function saveNotifSettings() {
    const events = [];
    document.querySelectorAll('.notif-event:checked').forEach(cb => events.push(cb.value));
    const data = {
        enabled: document.getElementById('notif-enabled').checked,
        phone: document.getElementById('notif-phone').value.trim(),
        events
    };
    fetch('/api/settings/notifications', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
        .then(() => showToast('Notificacoes salvas', 'success'));
}

function testNotification() {
    saveNotifSettings();
    setTimeout(() => {
        fetch('/api/test-notification', { method: 'POST' })
            .then(r => r.json())
            .then(d => showToast(d.success ? 'Teste enviado!' : (d.error || 'Erro'), d.success ? 'success' : 'danger'));
    }, 500);
}

// ==================== PROXY ROTATION SETTINGS ====================

function loadProxyRotSettings() {
    fetch('/api/settings').then(r => r.json()).then(s => {
        const pr = s.proxy_rotation || {};
        document.getElementById('proxyrot-enabled').checked = pr.enabled || false;
        document.getElementById('proxyrot-hours').value = pr.interval_hours ?? 6;
    });
}

function saveProxyRotSettings() {
    const data = {
        enabled: document.getElementById('proxyrot-enabled').checked,
        interval_hours: parseInt(document.getElementById('proxyrot-hours').value) || 6
    };
    fetch('/api/settings/proxy-rotation', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })
        .then(() => showToast('Rotacao de proxy salva', 'success'));
}

// ==================== MEDIA MANAGEMENT ====================

function loadAllMedia() {
    ['audios', 'images', 'stickers'].forEach(type => {
        fetch('/api/media/' + type).then(r => r.json()).then(files => {
            document.getElementById('media-' + type + '-count').textContent = files.length;
            const list = document.getElementById('media-' + type + '-list');
            if (files.length === 0) { list.innerHTML = '<p class="settings-hint">Nenhum arquivo</p>'; return; }
            list.innerHTML = files.map(f => `
                <div class="media-item">
                    <span class="media-name">${f.name}</span>
                    <span class="media-size">${(f.size / 1024).toFixed(1)}KB</span>
                    <button class="btn-icon danger" onclick="deleteMedia('${type}','${f.name}')" title="Excluir">✕</button>
                </div>
            `).join('');
        });
    });
}

function uploadMedia(type) {
    const input = document.getElementById('upload-' + type);
    if (!input.files.length) return;
    const form = new FormData();
    for (const f of input.files) form.append('files', f);
    fetch('/api/media/' + type + '/upload', { method: 'POST', body: form })
        .then(r => r.json())
        .then(d => { showToast(d.count + ' arquivo(s) enviado(s)', 'success'); loadAllMedia(); input.value = ''; })
        .catch(() => showToast('Erro no upload', 'danger'));
}

function deleteMedia(type, filename) {
    fetch('/api/media/' + type + '/' + encodeURIComponent(filename), { method: 'DELETE' })
        .then(() => { showToast('Removido', 'success'); loadAllMedia(); });
}

// ==================== CUSTOM MESSAGES ====================

let _customMessages = [];

function loadCustomMessages() {
    fetch('/api/messages').then(r => r.json()).then(msgs => { _customMessages = msgs || []; renderCustomMessages(); });
}

function renderCustomMessages() {
    const list = document.getElementById('custom-messages-list');
    if (_customMessages.length === 0) { list.innerHTML = '<p class="settings-hint">Nenhuma mensagem customizada. As mensagens padrao serao usadas.</p>'; return; }
    list.innerHTML = _customMessages.map((msg, i) => `
        <div class="media-item"><span class="media-name" style="flex:1">${truncate(msg, 60)}</span><button class="btn-icon danger" onclick="removeCustomMessage(${i})">✕</button></div>
    `).join('');
}

function addCustomMessage() {
    const msg = prompt('Digite a mensagem:');
    if (!msg || !msg.trim()) return;
    _customMessages.push(msg.trim());
    fetch('/api/messages', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ messages: _customMessages }) })
        .then(() => { renderCustomMessages(); showToast('Mensagem adicionada', 'success'); });
}

function removeCustomMessage(i) {
    _customMessages.splice(i, 1);
    fetch('/api/messages', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ messages: _customMessages }) })
        .then(() => { renderCustomMessages(); showToast('Removida', 'success'); });
}

// ==================== CHIP HISTORY MODAL ====================

function openChipHistory(chipId) {
    fetch('/api/chips/' + chipId + '/history').then(r => r.json()).then(data => {
        const chip = data.chip;
        const name = chip.name || chip.phone || 'Chip ' + chipId;
        const div = document.createElement('div');
        div.innerHTML = `
        <div class="modal-overlay" onclick="this.parentElement.remove()">
            <div class="modal" style="max-width:600px;max-height:80vh;overflow-y:auto" onclick="event.stopPropagation()">
                <h3>📋 Historico — ${name}</h3>
                <div class="chip-history-stats">
                    <div class="history-stat"><span class="history-stat-val">${data.stats.days_active}</span><span class="history-stat-label">dias</span></div>
                    <div class="history-stat"><span class="history-stat-val">${data.stats.total_messages}</span><span class="history-stat-label">msgs</span></div>
                    <div class="history-stat"><span class="history-stat-val">Fase ${data.stats.phase}</span><span class="history-stat-label">atual</span></div>
                    <div class="history-stat"><span class="history-stat-val">${data.stats.status}</span><span class="history-stat-label">status</span></div>
                </div>
                <div class="chip-timeline">${data.timeline.map(t => {
                    const icon = t.type === 'connect' ? '🟢' : t.type === 'create' ? '📱' : t.type === 'rehab' ? '🏥' : '📊';
                    const time = new Date(t.time).toLocaleString('pt-BR');
                    return '<div class="timeline-item"><span class="timeline-icon">' + icon + '</span><div class="timeline-content"><div class="timeline-detail">' + t.detail + '</div><div class="timeline-time">' + time + '</div></div></div>';
                }).join('')}</div>
                <button class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').parentElement.remove()" style="margin-top:16px;width:100%">Fechar</button>
            </div>
        </div>`;
        document.body.appendChild(div);
    }).catch(() => showToast('Erro ao carregar historico', 'danger'));
}

// ==================== BULK CHIP OPERATIONS ====================

let _bulkSelected = new Set();

function toggleBulkSelect(chipId, event) {
    if (event) event.stopPropagation();
    if (_bulkSelected.has(chipId)) _bulkSelected.delete(chipId);
    else _bulkSelected.add(chipId);
    const card = document.getElementById('chip-' + chipId);
    if (card) card.classList.toggle('bulk-selected', _bulkSelected.has(chipId));
    updateBulkBar();
}

function deselectAllChips() {
    _bulkSelected.clear();
    document.querySelectorAll('.chip-card.bulk-selected').forEach(c => c.classList.remove('bulk-selected'));
    updateBulkBar();
}

function updateBulkBar() {
    let bar = document.getElementById('bulk-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'bulk-bar';
        bar.className = 'bulk-bar';
        const container = document.querySelector('.chips-header');
        if (container) container.after(bar);
    }
    if (_bulkSelected.size === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = `
        <span><strong>${_bulkSelected.size}</strong> selecionado(s)</span>
        <button class="btn btn-success btn-sm" onclick="bulkAction('start')">▶ Aquecer</button>
        <button class="btn btn-warning btn-sm" onclick="bulkAction('stop')">⏸ Pausar</button>
        <button class="btn btn-outline btn-sm" onclick="bulkAction('adm')">👤 ADM</button>
        <button class="btn btn-danger btn-sm" onclick="bulkAction('delete')">✕ Excluir</button>
        <button class="btn btn-outline btn-sm" onclick="deselectAllChips()">Limpar</button>
    `;
}

function bulkAction(action) {
    const ids = Array.from(_bulkSelected);
    if (ids.length === 0) return;
    if (action === 'delete' && !confirm('Excluir ' + ids.length + ' chip(s)?')) return;

    const requests = ids.map(id => {
        if (action === 'start') return fetch('/api/chips/' + id + '/warming/start', { method: 'POST' });
        if (action === 'stop') return fetch('/api/chips/' + id + '/warming/stop', { method: 'POST' });
        if (action === 'adm') return fetch('/api/chips/' + id + '/set-type', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ type: 'admin' }) });
        if (action === 'delete') return fetch('/api/chips/' + id, { method: 'DELETE' });
    });
    Promise.all(requests).then(() => {
        showToast(action + ' aplicado em ' + ids.length + ' chip(s)', 'success');
        _bulkSelected.clear();
        updateBulkBar();
        refreshChips();
    });
}

// Toast listener for server-side toasts
socket.on('toast', (data) => { showToast(data.message, data.type || 'info'); });

// ==================== ADMIN MANAGE TAB (GERENCIAR ADMINS) ====================

let _amGroups = [];
let _amSelectedGroupId = null;
let _amAdmins = [];
let _amSelectedAdmins = new Set();
let _amMembers = [];
let _amSelectedMembers = new Set();
let _amAddChips = [];
let _amSelectedAddChips = new Set();
let _amInviteLinksCache = {}; // { groupId: { link, fetched_at } }
let _amPanelMode = 'admins'; // 'admins', 'members', 'add'
let _amMode = 'demote';
let _amRunning = false;
let _amPaused = false;
let _amCurrentOpId = null;
let _amGroupFilter = 'all'; // 'all', 'pending', 'done'
let _amDoneMarks = {}; // Shared via server DB { groupId: { done_at, done_by } }

function _amLoadDoneMarks() {
    fetch('/api/group-done-marks').then(r => r.json()).then(marks => {
        _amDoneMarks = marks || {};
        amRenderGroups();
    }).catch(() => {});
}
function _amIsGroupDone(groupId) {
    return !!_amDoneMarks[groupId];
}
function _amGetDoneInfo(groupId) {
    return _amDoneMarks[groupId] || null;
}

function loadAdminManageTab() {
    _amLoadDoneMarks();
    loadAmAdminInstances();
}

function loadAmAdminInstances() {
    fetch('/api/admin-instances').then(r => r.json()).then(admins => {
        const select = document.getElementById('am-admin-select');
        if (!select) return;
        const current = select.value;
        select.innerHTML = '<option value="">Selecione uma instancia ADM...</option>';
        for (const adm of admins) {
            const label = (adm.name || 'ADM') + (adm.phone ? ' (' + adm.phone + ')' : '');
            const status = adm.is_connected ? '🟢' : '🔴';
            const opt = document.createElement('option');
            opt.value = adm.id;
            opt.textContent = status + ' ' + label;
            opt.disabled = !adm.is_connected;
            select.appendChild(opt);
        }
        if (current) select.value = current;
    });
}

function onAmAdminSelect() {
    const chipId = document.getElementById('am-admin-select').value;
    const infoEl = document.getElementById('am-admin-info');
    const panels = document.getElementById('am-panels');
    const configEl = document.getElementById('am-config');

    if (!chipId) {
        infoEl.style.display = 'none';
        panels.style.display = 'none';
        configEl.style.display = 'none';
        amHideSummary();
        return;
    }

    infoEl.style.display = 'block';
    infoEl.innerHTML = '<div class="ga-loading">Buscando grupos...</div>';
    panels.style.display = 'none';
    configEl.style.display = 'none';

    fetch('/api/admin-instances/' + chipId + '/groups')
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                infoEl.innerHTML = '<div class="ga-error">' + data.error + '</div>';
                return;
            }
            _amGroups = data;
            _amSelectedGroupId = null;
            _amAdmins = [];
            _amSelectedAdmins.clear();
            infoEl.innerHTML = '<span class="ga-success-text">🟢 Conectado — ' + data.length + ' grupos encontrados</span>';
            panels.style.display = 'grid';
            amRenderGroups();
            amRenderAdmins();
            // Load cached links + trigger background fetch for missing ones
            amLoadAndFetchInviteLinks(chipId, data);
        })
        .catch(err => {
            infoEl.innerHTML = '<div class="ga-error">Erro: ' + err.message + '</div>';
        });
}

// ==================== AM PANEL MODE SWITCHING ====================

function amSwitchPanelMode(mode) {
    _amPanelMode = mode;
    document.querySelectorAll('.am-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.getElementById('am-panel-admins').style.display = mode === 'admins' ? '' : 'none';
    document.getElementById('am-panel-members').style.display = mode === 'members' ? '' : 'none';
    document.getElementById('am-panel-add').style.display = mode === 'add' ? '' : 'none';

    // Hide/show config section (only for admins mode)
    const configEl = document.getElementById('am-config');
    if (configEl) configEl.style.display = (mode === 'admins' && _amSelectedAdmins.size > 0) ? '' : 'none';

    if (mode === 'members' && _amSelectedGroupId) {
        amLoadMembers();
    }
    if (mode === 'add') {
        amLoadAddChips();
    }
}

// ==================== AM MEMBERS (PROMOTE) ====================

function amLoadMembers() {
    const chipId = document.getElementById('am-admin-select').value;
    if (!chipId || !_amSelectedGroupId) return;

    const list = document.getElementById('am-members-list');
    list.innerHTML = '<div class="ga-loading">Carregando membros...</div>';

    fetch(`/api/admin-manage/group-members/${chipId}/${encodeURIComponent(_amSelectedGroupId)}`)
        .then(r => r.json())
        .then(data => {
            if (data.error) { list.innerHTML = '<div class="ga-error">' + data.error + '</div>'; return; }
            _amMembers = data;
            _amSelectedMembers.clear();
            document.getElementById('am-members-count').textContent = '(' + data.length + ')';
            amRenderMembers();
        })
        .catch(err => {
            list.innerHTML = '<div class="ga-error">Erro: ' + err.message + '</div>';
        });
}

function amRenderMembers() {
    const list = document.getElementById('am-members-list');
    const search = (document.getElementById('am-members-search')?.value || '').toLowerCase();

    let filtered = _amMembers;
    if (search) filtered = filtered.filter(m => (m.phone || '').includes(search) || (m.name || '').toLowerCase().includes(search));

    if (filtered.length === 0) {
        list.innerHTML = '<div class="ga-empty">' + (_amMembers.length === 0 ? 'Nenhum membro (todos sao admin)' : 'Nenhum resultado') + '</div>';
        amUpdatePromoteBar();
        return;
    }

    list.innerHTML = filtered.map(m => {
        const checked = _amSelectedMembers.has(m.jid) ? 'checked' : '';
        const phone = m.phone || m.lid || 'Desconhecido';
        let phoneDisplay = phone;
        if (phone.length >= 12 && phone.startsWith('55')) {
            const ddd = phone.substring(2, 4);
            const num = phone.substring(4);
            phoneDisplay = `55 (<b>${ddd}</b>) ${num}`;
        }
        return `<div class="ga-item">
            <input type="checkbox" ${checked} onchange="amToggleMember('${m.jid}')">
            <div class="ga-item-info">
                <div class="ga-item-name">${phoneDisplay}</div>
                <div class="ga-item-meta">${m.name ? m.name + ' · ' : ''}Membro</div>
            </div>
        </div>`;
    }).join('');

    amUpdatePromoteBar();
}

function amToggleMember(jid) {
    if (_amSelectedMembers.has(jid)) _amSelectedMembers.delete(jid);
    else _amSelectedMembers.add(jid);
    amRenderMembers();
}

function amSelectAllMembers() {
    _amMembers.forEach(m => { if (!m.isMe) _amSelectedMembers.add(m.jid); });
    amRenderMembers();
}

function amDeselectAllMembers() {
    _amSelectedMembers.clear();
    amRenderMembers();
}

function amFilterMembers() { amRenderMembers(); }

function amUpdatePromoteBar() {
    const bar = document.getElementById('am-promote-bar');
    const count = _amSelectedMembers.size;
    if (bar) {
        bar.style.display = count > 0 ? 'flex' : 'none';
        document.getElementById('am-promote-count').textContent = count + ' selecionado' + (count > 1 ? 's' : '');
    }
}

async function amPromoteSelected() {
    const chipId = document.getElementById('am-admin-select').value;
    if (!chipId || !_amSelectedGroupId || _amSelectedMembers.size === 0) return;

    const count = _amSelectedMembers.size;
    const groupName = _amGroups.find(g => g.id === _amSelectedGroupId)?.subject || '';
    if (!confirm(`Promover ${count} membro(s) a ADMIN em "${groupName}"?`)) return;

    const jids = [..._amSelectedMembers];
    let ok = 0, fail = 0;

    for (const jid of jids) {
        try {
            const res = await fetch('/api/admin-manage/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chipId: parseInt(chipId), groupId: _amSelectedGroupId, jid })
            });
            const data = await res.json();
            if (data.success) ok++;
            else fail++;
        } catch { fail++; }

        // Small delay between each
        if (jids.indexOf(jid) < jids.length - 1) {
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    showToast(`${ok} promovido(s) a admin${fail ? `, ${fail} falha(s)` : ''}`, ok > 0 ? 'success' : 'danger');
    _amSelectedMembers.clear();
    amLoadMembers(); // Reload to reflect changes
}

// ==================== AM ADD MEMBERS ====================

let _amAddAction = 'add_only'; // 'add_only' or 'add_promote'
let _amAddAbort = false;

function amSetAddAction(action) {
    _amAddAction = action;
    document.querySelectorAll('.am-add-action-option').forEach(el => {
        el.classList.toggle('selected', el.querySelector('input').value === action);
    });
    // Update button text
    const btnText = document.getElementById('am-add-btn-text');
    if (btnText) btnText.textContent = action === 'add_promote' ? '👑 Adicionar + Promover' : '➕ Adicionar ao Grupo';
}

function amUpdateAddCount() {
    const text = document.getElementById('am-add-manual')?.value || '';
    const numbers = text.split('\n').map(n => n.replace(/[^0-9+]/g, '').replace(/^\+/, '')).filter(n => n.length >= 10);
    const hint = document.getElementById('am-add-count-hint');
    if (hint) {
        hint.textContent = numbers.length + ' numero' + (numbers.length !== 1 ? 's' : '') + ' detectado' + (numbers.length !== 1 ? 's' : '');
        hint.style.color = numbers.length > 0 ? 'var(--success)' : 'var(--text-muted)';
    }
}

// Attach counter to textarea
document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('am-add-manual');
    if (ta) ta.addEventListener('input', amUpdateAddCount);
});

function amLoadAddChips() {
    // Nothing to load anymore (chips removed from UI)
    // Just update the textarea counter
    amUpdateAddCount();
}

async function amStartAdd() {
    const chipId = document.getElementById('am-admin-select').value;
    if (!chipId) return showToast('Selecione uma instancia ADM', 'warning');
    if (!_amSelectedGroupId) return showToast('Selecione um grupo na esquerda primeiro', 'warning');

    const manualText = document.getElementById('am-add-manual')?.value || '';
    const numbers = manualText.split('\n').map(n => n.replace(/[^0-9+]/g, '').replace(/^\+/, '')).filter(n => n.length >= 10);

    if (numbers.length === 0) return showToast('Cole pelo menos um numero valido', 'warning');

    const groupName = _amGroups.find(g => g.id === _amSelectedGroupId)?.subject || '';
    const actionText = _amAddAction === 'add_promote' ? 'Adicionar + Promover a Admin' : 'Adicionar como membro';
    if (!confirm(`${actionText}\n\n${numbers.length} numero(s) no grupo "${groupName}"\n\nContinuar?`)) return;

    // Show progress
    _amAddAbort = false;
    const progressEl = document.getElementById('am-add-progress');
    const progressText = document.getElementById('am-add-progress-text');
    const progressFill = document.getElementById('am-add-progress-fill');
    const logEl = document.getElementById('am-add-log');
    progressEl.style.display = 'block';
    logEl.innerHTML = '';
    progressFill.style.width = '0%';

    let addOk = 0, addFail = 0, promoteOk = 0, promoteFail = 0;

    for (let i = 0; i < numbers.length; i++) {
        if (_amAddAbort) {
            logEl.innerHTML += '<div class="log-warn">⚠️ Operacao cancelada pelo usuario</div>';
            break;
        }

        const num = numbers[i];
        const pct = Math.round(((i + 1) / numbers.length) * 100);
        progressText.textContent = `${i + 1}/${numbers.length} (${pct}%)`;
        progressFill.style.width = pct + '%';

        // Step 1: Add to group
        try {
            const addRes = await fetch('/api/admin-manage/add-member', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chipId: parseInt(chipId), groupId: _amSelectedGroupId, number: num })
            });
            const addData = await addRes.json();

            if (addData.success) {
                addOk++;
                logEl.innerHTML += '<div class="log-ok">✅ ' + num + ' adicionado ao grupo</div>';

                // Step 2: Promote if needed
                if (_amAddAction === 'add_promote') {
                    await new Promise(r => setTimeout(r, 2000)); // Wait before promote

                    try {
                        const promRes = await fetch('/api/admin-manage/promote', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chipId: parseInt(chipId), groupId: _amSelectedGroupId, jid: addData.jid })
                        });
                        const promData = await promRes.json();

                        if (promData.success) {
                            promoteOk++;
                            logEl.innerHTML += '<div class="log-ok">👑 ' + num + ' promovido a admin</div>';
                        } else {
                            promoteFail++;
                            logEl.innerHTML += '<div class="log-err">❌ ' + num + ' falha ao promover: ' + (promData.error || '?') + '</div>';
                        }
                    } catch (e) {
                        promoteFail++;
                        logEl.innerHTML += '<div class="log-err">❌ ' + num + ' erro ao promover: ' + e.message + '</div>';
                    }
                }
            } else {
                addFail++;
                logEl.innerHTML += '<div class="log-err">❌ ' + num + ' — ' + (addData.error || 'Falha') + '</div>';
            }
        } catch (e) {
            addFail++;
            logEl.innerHTML += '<div class="log-err">❌ ' + num + ' — Erro: ' + e.message + '</div>';
        }

        logEl.scrollTop = logEl.scrollHeight;

        // Delay between numbers (3-6s)
        if (i < numbers.length - 1 && !_amAddAbort) {
            const delay = 3000 + Math.random() * 3000;
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // Final summary
    let summary = `\n✅ Concluido: ${addOk} adicionado(s)`;
    if (addFail > 0) summary += `, ${addFail} falha(s)`;
    if (_amAddAction === 'add_promote') {
        summary += ` | 👑 ${promoteOk} promovido(s)`;
        if (promoteFail > 0) summary += `, ${promoteFail} falha(s) promote`;
    }
    logEl.innerHTML += '<div class="log-info" style="font-weight:bold;margin-top:6px">' + summary + '</div>';
    progressText.textContent = 'Concluido!';
    showToast(summary.replace('\n', ''), addOk > 0 ? 'success' : 'danger');
}

// ==================== AM INVITE LINKS CACHE ====================

function amLoadAndFetchInviteLinks(chipId, groups) {
    // 1. Load whatever is already cached
    fetch('/api/admin-manage/invite-links-cache')
        .then(r => r.json())
        .then(cache => {
            _amInviteLinksCache = cache || {};
            amUpdateLinksBadge();

            // 2. Check how many are missing
            const missing = groups.filter(g => !_amInviteLinksCache[g.id] || !_amInviteLinksCache[g.id].link);
            if (missing.length === 0) {
                console.log('[Links] All ' + groups.length + ' links already cached');
                return;
            }

            console.log('[Links] ' + (groups.length - missing.length) + ' cached, ' + missing.length + ' missing — fetching in background...');

            // 3. Trigger background fetch on server
            fetch('/api/admin-manage/fetch-all-invite-links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chipId: parseInt(chipId), groups: groups.map(g => ({ id: g.id })) })
            });
        })
        .catch(() => {});
}

function amUpdateLinksBadge() {
    const btn = document.querySelector('.am-export-links-btn');
    if (!btn) return;
    const cached = Object.keys(_amInviteLinksCache).filter(id => _amGroups.some(g => g.id === id)).length;
    const total = _amGroups.length;
    if (cached >= total && total > 0) {
        btn.innerHTML = '📋 Exportar Links ✅';
    } else if (cached > 0) {
        btn.innerHTML = '📋 Exportar Links (' + cached + '/' + total + ')';
    } else {
        btn.innerHTML = '📋 Exportar Links';
    }
}

// ==================== AM GROUPS ====================

function amRenderGroups() {
    const list = document.getElementById('am-groups-list');
    const search = (document.getElementById('am-groups-search')?.value || '').toLowerCase();

    // Total de participantes somando todos os grupos
    const totalMembers = _amGroups.reduce((sum, g) => sum + (g.size || 0), 0);
    const totalEl = document.getElementById('am-total-members');
    if (totalEl) totalEl.textContent = totalMembers.toLocaleString('pt-BR') + ' membros total';

    // Count done groups
    const doneCount = _amGroups.filter(g => _amIsGroupDone(g.id)).length;
    const pendingCount = _amGroups.length - doneCount;
    document.getElementById('am-groups-count').textContent = _amGroups.length;
    const progressEl = document.getElementById('am-groups-progress');
    if (progressEl) {
        progressEl.textContent = doneCount > 0 ? `✓ ${doneCount} feitos · ${pendingCount} pendentes` : '';
    }

    // Update filter button states
    document.querySelectorAll('.am-group-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === _amGroupFilter);
    });

    // Apply search + filter
    let filtered = _amGroups;
    if (search) filtered = filtered.filter(g => (g.subject || '').toLowerCase().includes(search));
    if (_amGroupFilter === 'pending') filtered = filtered.filter(g => !_amIsGroupDone(g.id));
    else if (_amGroupFilter === 'done') filtered = filtered.filter(g => _amIsGroupDone(g.id));

    if (filtered.length === 0) {
        list.innerHTML = '<div class="ga-empty">' + (_amGroupFilter === 'done' ? 'Nenhum grupo marcado como feito' : _amGroupFilter === 'pending' ? 'Todos os grupos foram feitos!' : 'Nenhum grupo encontrado') + '</div>';
        return;
    }

    list.innerHTML = filtered.map(g => {
        const selected = _amSelectedGroupId === g.id ? 'selected' : '';
        const isDone = _amIsGroupDone(g.id);
        const doneInfo = _amGetDoneInfo(g.id);
        const doneTooltip = doneInfo ? `Feito por ${doneInfo.done_by || '?'} em ${new Date(doneInfo.done_at).toLocaleString('pt-BR')}` : 'Marcar como feito';
        return `<div class="ga-item ${selected} ${isDone ? 'am-group-done' : ''}" onclick="amSelectGroup('${g.id}', '${(g.subject || '').replace(/'/g, "\\'")}')">
            <div class="ga-item-info">
                <div class="ga-item-name">${isDone ? '✅ ' : ''}${g.subject || 'Sem nome'}</div>
                <div class="ga-item-meta">${g.size} participantes${isDone && doneInfo ? ' · feito por ' + (doneInfo.done_by || '?') : ''}</div>
            </div>
            <div class="am-group-actions">
                <button class="am-copy-link-btn" id="am-copy-${g.id.replace(/[@.]/g, '_')}" onclick="event.stopPropagation(); amCopyInviteLink('${g.id}')" title="Copiar link de convite">
                    🔗
                </button>
                <button class="am-done-btn ${isDone ? 'done' : ''}" onclick="event.stopPropagation(); amToggleGroupDone('${g.id}')" title="${doneTooltip}">
                    ${isDone ? '✓' : '○'}
                </button>
            </div>
        </div>`;
    }).join('');
}

function amFilterGroups() { amRenderGroups(); }

async function amCopyInviteLink(groupId) {
    const btnId = 'am-copy-' + groupId.replace(/[@.]/g, '_');
    const btn = document.getElementById(btnId);

    // Try cache first (instant)
    if (_amInviteLinksCache[groupId] && _amInviteLinksCache[groupId].link) {
        await navigator.clipboard.writeText(_amInviteLinksCache[groupId].link);
        showToast('Link copiado!', 'success');
        if (btn) { btn.innerHTML = '✅'; setTimeout(() => { btn.innerHTML = '🔗'; }, 1500); }
        return;
    }

    // Fallback: fetch live
    const chipId = document.getElementById('am-admin-select').value;
    if (!chipId) { showToast('Selecione um chip ADM primeiro', 'danger'); return; }
    if (btn) { btn.innerHTML = '⏳'; btn.disabled = true; }

    try {
        const res = await fetch(`/api/admin-manage/invite-link/${chipId}/${encodeURIComponent(groupId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro');
        _amInviteLinksCache[groupId] = { link: data.link, fetched_at: new Date().toISOString() };
        await navigator.clipboard.writeText(data.link);
        showToast('Link copiado!', 'success');
        if (btn) { btn.innerHTML = '✅'; setTimeout(() => { btn.innerHTML = '🔗'; btn.disabled = false; }, 1500); }
    } catch (err) {
        showToast('Erro ao copiar link: ' + err.message, 'danger');
        if (btn) { btn.innerHTML = '❌'; setTimeout(() => { btn.innerHTML = '🔗'; btn.disabled = false; }, 2000); }
    }
}

let _amExportAbort = false;

async function amExportAllLinks() {
    if (_amGroups.length === 0) { showToast('Nenhum grupo carregado', 'danger'); return; }

    const modal = document.getElementById('links-modal');
    const textarea = document.getElementById('am-links-textarea');
    const progressEl = document.getElementById('am-links-progress');
    modal.style.display = 'flex';
    textarea.value = '';

    // Check how many are cached
    const results = [];
    let cachedCount = 0;
    let missingGroups = [];

    for (const g of _amGroups) {
        if (_amInviteLinksCache[g.id] && _amInviteLinksCache[g.id].link) {
            results.push({ name: g.subject || 'Sem nome', link: _amInviteLinksCache[g.id].link, size: g.size || 0 });
            cachedCount++;
        } else {
            missingGroups.push(g);
            results.push({ name: g.subject || 'Sem nome', link: '(buscando...)', size: g.size || 0 });
        }
    }

    // Show cached immediately
    textarea.value = _amFormatLinksText(results);

    if (missingGroups.length === 0) {
        progressEl.innerHTML = '<span style="color:var(--success);font-weight:700">✅ ' + _amGroups.length + ' links prontos (todos do cache)</span>';
        return;
    }

    progressEl.textContent = cachedCount + '/' + _amGroups.length + ' do cache — buscando ' + missingGroups.length + ' restantes...';

    // Fetch missing ones with delay
    _amExportAbort = false;
    const chipId = document.getElementById('am-admin-select').value;
    if (!chipId) { showToast('Selecione um chip ADM primeiro', 'danger'); return; }

    let fetchedCount = 0;
    let errors = 0;

    for (const g of missingGroups) {
        if (_amExportAbort) break;

        let success = false;
        let retries = 0;
        while (!success && retries <= 4 && !_amExportAbort) {
            try {
                const res = await fetch(`/api/admin-manage/invite-link/${chipId}/${encodeURIComponent(g.id)}`);
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro');
                // Update in results array
                const idx = results.findIndex(r => r.name === (g.subject || 'Sem nome') && r.link === '(buscando...)');
                if (idx !== -1) results[idx].link = data.link;
                _amInviteLinksCache[g.id] = { link: data.link, fetched_at: new Date().toISOString() };
                success = true;
            } catch (err) {
                if (err.message && err.message.includes('rate') && retries < 4) {
                    retries++;
                    const wait = retries * 12;
                    progressEl.textContent = `Rate limit — aguardando ${wait}s... (${cachedCount + fetchedCount}/${_amGroups.length})`;
                    await new Promise(r => setTimeout(r, wait * 1000));
                } else {
                    const idx = results.findIndex(r => r.name === (g.subject || 'Sem nome') && r.link === '(buscando...)');
                    if (idx !== -1) results[idx].link = '(erro)';
                    errors++;
                    success = true;
                }
            }
        }

        fetchedCount++;
        progressEl.textContent = (cachedCount + fetchedCount) + '/' + _amGroups.length + (errors ? ` (${errors} erros)` : '');
        textarea.value = _amFormatLinksText(results);
        textarea.scrollTop = textarea.scrollHeight;

        if (fetchedCount < missingGroups.length && !_amExportAbort) {
            await new Promise(r => setTimeout(r, 2500));
        }
    }

    amUpdateLinksBadge();
    const totalErrors = results.filter(r => r.link.startsWith('(erro')).length;
    progressEl.innerHTML = '<span style="color:var(--success);font-weight:700">✅ ' + _amGroups.length + ' grupos processados</span>' + (totalErrors ? ' <span style="color:var(--danger)">(' + totalErrors + ' erros)</span>' : '');
}

function _amFormatLinksText(results) {
    const separator = '━'.repeat(50);
    const header = `📋 LINKS DE CONVITE DOS GRUPOS\n${separator}\n\n`;
    const lines = results.map((r, i) => {
        return `${String(i + 1).padStart(2, '0')}. ${r.name}\n    👥 ${r.size} membros\n    🔗 ${r.link}`;
    });
    const footer = `\n${separator}\nTotal: ${results.length} grupos`;
    return header + lines.join('\n\n') + footer;
}

function amCopyAllLinksText() {
    const textarea = document.getElementById('am-links-textarea');
    if (!textarea.value || textarea.value === 'Gerando links...') { showToast('Aguarde os links serem gerados', 'warning'); return; }
    navigator.clipboard.writeText(textarea.value).then(() => {
        showToast('Lista completa copiada!', 'success');
    }).catch(() => {
        textarea.select();
        document.execCommand('copy');
        showToast('Lista copiada!', 'success');
    });
}

function amSetGroupFilter(filter) {
    _amGroupFilter = filter;
    amRenderGroups();
}

function amToggleGroupDone(groupId) {
    const newState = !_amIsGroupDone(groupId);
    // Optimistic update
    if (newState) _amDoneMarks[groupId] = { done_at: new Date().toISOString(), done_by: 'eu' };
    else delete _amDoneMarks[groupId];
    amRenderGroups();

    // Persist to server
    fetch('/api/group-done-marks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId, done: newState })
    }).then(r => r.json()).then(marks => {
        _amDoneMarks = marks;
        amRenderGroups();
    }).catch(() => {});
}

function amSelectGroup(groupId, groupName) {
    _amSelectedGroupId = groupId;
    _amSelectedAdmins.clear();
    _amSelectedMembers.clear();
    amRenderGroups();

    const chipId = document.getElementById('am-admin-select').value;
    if (!chipId) return;

    // Load admins (always, for the admins panel)
    const list = document.getElementById('am-admins-list');
    list.innerHTML = '<div class="ga-loading">Carregando admins...</div>';

    fetch('/api/admin-manage/group-admins/' + chipId + '/' + encodeURIComponent(groupId))
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                list.innerHTML = '<div class="ga-error">' + data.error + '</div>';
                return;
            }
            _amAdmins = data;
            amRenderAdmins();
            if (_amPanelMode === 'admins') document.getElementById('am-config').style.display = 'block';
        })
        .catch(err => {
            list.innerHTML = '<div class="ga-error">Erro: ' + err.message + '</div>';
        });

    // If in members mode, also load members
    if (_amPanelMode === 'members') {
        amLoadMembers();
    }
}

// ==================== AM ADMINS LIST ====================

function amFilterAdmins() { amRenderAdmins(); }

function amRenderAdmins() {
    const list = document.getElementById('am-admins-list');
    if (!list) return;
    const countEl = document.getElementById('am-admins-count');
    const search = (document.getElementById('am-admins-search')?.value || '').toLowerCase().trim();

    if (_amAdmins.length === 0) {
        list.innerHTML = '<div class="ga-empty">Selecione um grupo para ver os admins</div>';
        if (countEl) countEl.textContent = '';
        amHideSummary();
        return;
    }

    // Filter by search (DDD, phone number, or name)
    const filtered = search
        ? _amAdmins.filter(a => {
            const phone = (a.phone || '').toLowerCase();
            const name = (a.name || '').toLowerCase();
            const lid = (a.lid || '').toLowerCase();
            return phone.includes(search) || name.includes(search) || lid.includes(search);
        })
        : _amAdmins;

    if (countEl) countEl.textContent = '(' + filtered.length + (search ? '/' + _amAdmins.length : '') + ')';

    if (filtered.length === 0) {
        list.innerHTML = '<div class="ga-empty">Nenhum admin encontrado para "' + search + '"</div>';
        return;
    }

    list.innerHTML = filtered.map(a => {
        const checked = _amSelectedAdmins.has(a.jid) ? 'checked' : '';
        const isProtected = a.isMe || a.isSuper;
        const badge = a.isMe ? '<span class="am-badge am-badge-me">EU (ADM)</span>'
            : a.isSuper ? '<span class="am-badge am-badge-super">CRIADOR</span>'
            : '';
        const displayName = a.name || '';
        const displayPhone = a.phone || a.lid || '?';
        const hasRealPhone = a.phone && a.phone.length >= 10 && a.phone !== a.lid;
        const lidHint = !hasRealPhone && !a.name ? '<span class="am-lid-hint">ID interno</span>' : '';

        // Format phone with DDD highlight
        let phoneDisplay = displayPhone;
        if (hasRealPhone && displayPhone.length >= 12) {
            const countryCode = displayPhone.slice(0, 2);
            const ddd = displayPhone.slice(2, 4);
            const rest = displayPhone.slice(4);
            phoneDisplay = countryCode + ' <strong>(' + ddd + ')</strong> ' + rest;
        }

        if (isProtected) {
            return `<label class="ga-item am-protected">
                <input type="checkbox" disabled>
                <div class="ga-item-info">
                    <div class="ga-item-name">${displayName ? displayName + ' ' : ''}${badge}</div>
                    <div class="ga-item-meta">${phoneDisplay} · Protegido</div>
                </div>
            </label>`;
        }

        return `<label class="ga-item ${checked ? 'selected' : ''}">
            <input type="checkbox" ${checked} onchange="amToggleAdmin('${a.jid}')">
            <div class="ga-item-info">
                <div class="ga-item-name">${phoneDisplay} ${lidHint}</div>
                <div class="ga-item-meta">${displayName ? displayName + ' · ' : ''}Admin</div>
            </div>
        </label>`;
    }).join('');

    amUpdateSummary();
}

function amToggleAdmin(jid) {
    if (_amSelectedAdmins.has(jid)) _amSelectedAdmins.delete(jid);
    else _amSelectedAdmins.add(jid);
    amRenderAdmins();
}

function amSelectAllAdmins() {
    for (const a of _amAdmins) {
        if (!a.isMe && !a.isSuper) _amSelectedAdmins.add(a.jid);
    }
    amRenderAdmins();
}

function amDeselectAllAdmins() {
    _amSelectedAdmins.clear();
    amRenderAdmins();
}

// ==================== AM MODE ====================

function amSetMode(mode) {
    _amMode = mode;
    document.querySelectorAll('.am-mode-option').forEach(el => el.classList.remove('selected'));
    const radio = document.querySelector('input[name="am-mode"][value="' + mode + '"]');
    if (radio) {
        radio.checked = true;
        radio.closest('.am-mode-option').classList.add('selected');
    }
    amUpdateSummary();
}

// ==================== AM SUMMARY ====================

function amUpdateSummary() {
    const el = document.getElementById('am-summary');
    if (!el) return;

    const count = _amSelectedAdmins.size;
    if (count === 0 || !_amSelectedGroupId) {
        el.style.display = 'none';
        return;
    }

    const group = _amGroups.find(g => g.id === _amSelectedGroupId);
    const groupName = group?.subject || _amSelectedGroupId;
    const adminSelect = document.getElementById('am-admin-select');
    const adminText = adminSelect.options[adminSelect.selectedIndex]?.textContent || '?';
    const modeText = _amMode === 'demote' ? 'Rebaixar apenas' : 'Rebaixar + Remover';
    const estSeconds = count * 6;
    const estText = estSeconds > 60 ? Math.ceil(estSeconds / 60) + ' minutos' : estSeconds + ' segundos';

    el.style.display = 'block';
    el.innerHTML = `
        <div class="ga-summary-card">
            <div class="ga-summary-title">Resumo da Operacao</div>
            <div class="ga-summary-grid">
                <div class="ga-summary-row"><span>Instancia ADM:</span><strong>${adminText}</strong></div>
                <div class="ga-summary-row"><span>Grupo:</span><strong>${groupName}</strong></div>
                <div class="ga-summary-row"><span>Admins selecionados:</span><strong>${count}</strong></div>
                <div class="ga-summary-row"><span>Modo:</span><strong>${modeText}</strong></div>
                <div class="ga-summary-row"><span>Estimativa:</span><strong>~${estText}</strong></div>
            </div>
            ${_amMode === 'demote_remove' ? '<div class="am-warning-box">⚠️ ATENCAO: Os admins selecionados serao rebaixados E removidos do grupo!</div>' : ''}
            <button class="btn btn-danger" onclick="amStartOperation()" id="am-btn-start" style="margin-top:16px;width:100%">
                ${_amMode === 'demote' ? '⬇️ Rebaixar Admins' : '⬇️ Rebaixar + Remover'}
            </button>
        </div>`;
}

function amHideSummary() {
    const el = document.getElementById('am-summary');
    if (el) el.style.display = 'none';
}

// ==================== AM EXECUTION ====================

function amStartOperation() {
    const adminChipId = parseInt(document.getElementById('am-admin-select').value);
    if (!adminChipId) return showToast('Selecione uma instancia ADM', 'warning');
    if (_amSelectedAdmins.size === 0) return showToast('Selecione pelo menos 1 admin', 'warning');
    if (!_amSelectedGroupId) return showToast('Selecione um grupo', 'warning');

    const group = _amGroups.find(g => g.id === _amSelectedGroupId);
    const groupName = group?.subject || _amSelectedGroupId;

    // Double confirmation for demote_remove
    if (_amMode === 'demote_remove') {
        if (!confirm('CONFIRMACAO: Rebaixar E REMOVER ' + _amSelectedAdmins.size + ' admin(s) do grupo "' + groupName + '"?\n\nEsta acao NAO pode ser desfeita!')) {
            return;
        }
    }

    const items = [];
    for (const jid of _amSelectedAdmins) {
        const admin = _amAdmins.find(a => a.jid === jid);
        if (!admin) continue;
        items.push({
            jid: admin.jid,
            phone: admin.phone,
            group_id: _amSelectedGroupId,
            group_name: groupName,
            is_me: admin.isMe,
            is_super: admin.isSuper
        });
    }

    const config = {
        mode: _amMode,
        delayMin: 3, delayMax: 8,
        groupDelayMin: 15, groupDelayMax: 30
    };

    const btn = document.getElementById('am-btn-start');
    if (btn) { btn.disabled = true; btn.textContent = 'Iniciando...'; }

    fetch('/api/admin-manage/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminChipId, items, config })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            _amCurrentOpId = data.operationId;
            _amRunning = true;
            _amPaused = false;
            amShowExecutionUI(data.totalItems);
            showToast('Operacao iniciada!', 'success');
        } else {
            showToast(data.error || 'Erro ao iniciar', 'danger');
            if (btn) { btn.disabled = false; btn.textContent = _amMode === 'demote' ? '⬇️ Rebaixar Admins' : '⬇️ Rebaixar + Remover'; }
        }
    })
    .catch(err => {
        showToast('Erro: ' + err.message, 'danger');
        if (btn) { btn.disabled = false; btn.textContent = _amMode === 'demote' ? '⬇️ Rebaixar Admins' : '⬇️ Rebaixar + Remover'; }
    });
}

function amShowExecutionUI(totalItems) {
    document.getElementById('am-summary').style.display = 'none';
    document.getElementById('am-config').style.display = 'none';
    document.getElementById('am-execution').style.display = 'block';
    document.getElementById('am-report').style.display = 'none';
    document.getElementById('am-progress-text').textContent = '0/' + totalItems + ' (0%)';
    document.getElementById('am-progress-fill').style.width = '0%';
    document.getElementById('am-progress-stats').innerHTML = '';
    document.getElementById('am-log').innerHTML = '';
    document.getElementById('am-btn-pause').textContent = 'Pausar';
}

function amTogglePause() {
    if (_amPaused) {
        fetch('/api/admin-manage/resume', { method: 'POST' });
        _amPaused = false;
        document.getElementById('am-btn-pause').textContent = 'Pausar';
    } else {
        fetch('/api/admin-manage/pause', { method: 'POST' });
        _amPaused = true;
        document.getElementById('am-btn-pause').textContent = 'Retomar';
    }
}

function amStop() {
    openConfirmModal('Parar Operacao', 'Deseja parar a operacao? Itens ja processados serao mantidos.', 'Parar', () => {
        fetch('/api/admin-manage/stop', { method: 'POST' });
        _amRunning = false;
    });
}

// ==================== AM SOCKET LISTENERS ====================

socket.on('admin_manage_stats', (data) => {
    if (!_amRunning) return;
    document.getElementById('am-progress-text').textContent =
        data.processed + '/' + data.total + ' (' + data.percent + '%)';
    document.getElementById('am-progress-fill').style.width = data.percent + '%';

    let statsHtml = `<span class="ga-stat-item ga-stat-success">⬇️ ${data.demoteOk} rebaixados</span>`;
    if (data.removeOk > 0) statsHtml += `<span class="ga-stat-item ga-stat-fail">🚫 ${data.removeOk} removidos</span>`;
    if (data.demoteFail > 0) statsHtml += `<span class="ga-stat-item ga-stat-fail">❌ ${data.demoteFail} falhas</span>`;
    if (data.removeFail > 0) statsHtml += `<span class="ga-stat-item ga-stat-warn">⚠️ ${data.removeFail} remocao falhou</span>`;
    if (data.skipCount > 0) statsHtml += `<span class="ga-stat-item ga-stat-skip">⏭️ ${data.skipCount} protegidos</span>`;
    if (data.currentGroup) statsHtml += `<span class="ga-stat-item ga-stat-group">📂 ${data.currentGroup}</span>`;

    document.getElementById('am-progress-stats').innerHTML = statsHtml;
});

socket.on('admin_manage_log', (data) => {
    const logEl = document.getElementById('am-log');
    if (!logEl) return;

    const icons = {
        'demote_ok': '⬇️', 'demote_fail': '❌', 'remove_ok': '🚫',
        'remove_fail': '⚠️', 'skip': '⏭️', 'error': '❌',
        'warning': '⚠️', 'system': '🔄'
    };
    const icon = icons[data.type] || '📝';
    const time = new Date(data.timestamp || Date.now()).toLocaleTimeString('pt-BR');
    const cls = data.type === 'demote_ok' || data.type === 'remove_ok' ? 'ga-log-success'
        : data.type === 'demote_fail' || data.type === 'error' ? 'ga-log-error'
        : data.type === 'remove_fail' || data.type === 'warning' ? 'ga-log-warn'
        : data.type === 'skip' ? 'ga-log-info'
        : 'ga-log-info';

    const item = document.createElement('div');
    item.className = 'ga-log-item ' + cls;
    item.innerHTML = '<span class="ga-log-icon">' + icon + '</span><span class="ga-log-msg">' + data.message + '</span><span class="ga-log-time">' + time + '</span>';
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
});

socket.on('admin_manage_status', (data) => {
    if (data.status === 'completed' || data.status === 'stopped' || data.status === 'failed') {
        _amRunning = false;
        _amPaused = false;
    }
});

socket.on('admin_manage_complete', (summary) => {
    _amRunning = false;
    document.getElementById('am-execution').style.display = 'none';
    amShowReport(summary);
    showToast('Operacao concluida! ' + summary.demoteOk + ' rebaixados', 'success');
});

socket.on('invite_links_progress', (data) => {
    if (data.status === 'done') {
        // Reload cache from server
        fetch('/api/admin-manage/invite-links-cache')
            .then(r => r.json())
            .then(cache => { _amInviteLinksCache = cache || {}; amUpdateLinksBadge(); })
            .catch(() => {});
    } else {
        // Update badge with progress
        const btn = document.querySelector('.am-export-links-btn');
        if (btn) btn.innerHTML = '📋 Links... ' + data.done + '/' + data.total;
    }
});

// ==================== AM REPORT ====================

function amShowReport(summary) {
    const el = document.getElementById('am-report');
    el.style.display = 'block';

    const durationMin = Math.floor(summary.duration / 60);
    const durationSec = summary.duration % 60;
    const durationText = durationMin > 0 ? durationMin + 'min ' + durationSec + 's' : durationSec + 's';
    const modeText = summary.mode === 'demote' ? 'Rebaixar' : 'Rebaixar + Remover';
    const statusLabel = summary.status === 'completed' ? '✅ Concluida' : summary.status === 'stopped' ? '⏹ Parada' : '❌ Falhou';

    let gridHtml = `
        <div class="ga-report-stat"><div class="ga-report-value">${summary.total}</div><div class="ga-report-label">Total</div></div>
        <div class="ga-report-stat success"><div class="ga-report-value">${summary.demoteOk}</div><div class="ga-report-label">Rebaixados</div></div>`;

    if (summary.mode === 'demote_remove') {
        gridHtml += `<div class="ga-report-stat fail"><div class="ga-report-value">${summary.removeOk}</div><div class="ga-report-label">Removidos</div></div>`;
    }

    gridHtml += `
        <div class="ga-report-stat skip"><div class="ga-report-value">${summary.skipCount}</div><div class="ga-report-label">Protegidos</div></div>
        <div class="ga-report-stat fail"><div class="ga-report-value">${summary.demoteFail}</div><div class="ga-report-label">Falhas</div></div>`;

    if (summary.mode === 'demote_remove' && summary.removeFail > 0) {
        gridHtml += `<div class="ga-report-stat warn"><div class="ga-report-value">${summary.removeFail}</div><div class="ga-report-label">Remocao falhou</div></div>`;
    }

    el.innerHTML = `
        <div class="ga-report-card">
            <div class="ga-report-header">${statusLabel} — ${modeText}</div>
            <div class="ga-report-grid">${gridHtml}</div>
            <div class="ga-report-duration">Duracao: ${durationText}</div>
            <div class="ga-report-actions">
                <button class="btn btn-outline btn-sm" onclick="amExportCSV(${summary.operationId})">Exportar CSV</button>
                ${summary.demoteFail > 0 ? '<button class="btn btn-warning btn-sm" onclick="amRetry(' + summary.operationId + ')">Reexecutar falhas (' + summary.demoteFail + ')</button>' : ''}
                <button class="btn btn-primary btn-sm" onclick="amNewOperation()">Nova Operacao</button>
            </div>
        </div>`;
}

function amExportCSV(opId) {
    window.open('/api/admin-manage/operations/' + opId + '/csv', '_blank');
}

function amRetry(opId) {
    openConfirmModal('Reexecutar Falhas', 'Reexecutar apenas os itens que falharam?', 'Reexecutar', () => {
        fetch('/api/admin-manage/retry/' + opId, { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                _amCurrentOpId = data.operationId;
                _amRunning = true;
                _amPaused = false;
                amShowExecutionUI(data.retrying);
                showToast('Reexecutando ' + data.retrying + ' itens', 'success');
            } else {
                showToast(data.error || 'Erro', 'danger');
            }
        });
    });
}

function amNewOperation() {
    document.getElementById('am-report').style.display = 'none';
    document.getElementById('am-execution').style.display = 'none';
    document.getElementById('am-summary').style.display = 'none';
    document.getElementById('am-config').style.display = 'none';
    _amSelectedGroupId = null;
    _amAdmins = [];
    _amSelectedAdmins.clear();
    amRenderGroups();
    amRenderAdmins();
}

// ==================== AM HISTORY ====================

function loadAdminManageHistory() {
    const el = document.getElementById('am-history');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
    if (el.style.display === 'none') return;

    el.innerHTML = '<div class="ga-loading">Carregando historico...</div>';

    fetch('/api/admin-manage/operations?limit=20')
    .then(r => r.json())
    .then(ops => {
        if (ops.length === 0) {
            el.innerHTML = '<div class="ga-empty" style="padding:20px">Nenhuma operacao realizada ainda</div>';
            return;
        }
        el.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead><tr style="border-bottom:1px solid var(--border)">
                    <th class="rehab-th">Data</th>
                    <th class="rehab-th">ADM</th>
                    <th class="rehab-th">Total</th>
                    <th class="rehab-th">Rebaixados</th>
                    <th class="rehab-th">Removidos</th>
                    <th class="rehab-th">Falhas</th>
                    <th class="rehab-th">Status</th>
                    <th class="rehab-th">Acoes</th>
                </tr></thead>
                <tbody>${ops.map(op => {
                    const date = op.created_at ? new Date(op.created_at).toLocaleString('pt-BR') : '—';
                    const config = JSON.parse(op.config || '{}');
                    const statusCls = op.status === 'completed' ? 'ga-status-ok' : op.status === 'running' ? 'ga-status-run' : op.status === 'failed' ? 'ga-status-fail' : 'ga-status-other';
                    return `<tr style="border-bottom:1px solid rgba(0,0,0,0.03)">
                        <td style="padding:8px 14px;font-size:12px">${date}</td>
                        <td style="padding:8px 14px;font-size:12px">${op.admin_name || op.admin_phone || '—'}</td>
                        <td style="padding:8px 14px">${op.total_items}</td>
                        <td style="padding:8px 14px;color:var(--success)">${op.demote_ok || 0}</td>
                        <td style="padding:8px 14px;color:var(--danger)">${config.mode === 'demote_remove' ? (op.remove_ok || 0) : '—'}</td>
                        <td style="padding:8px 14px;color:var(--danger)">${(op.demote_fail || 0) + (op.remove_fail || 0)}</td>
                        <td style="padding:8px 14px"><span class="${statusCls}">${op.status}</span></td>
                        <td style="padding:8px 14px">
                            <button class="btn btn-outline btn-xs" onclick="amExportCSV(${op.id})">CSV</button>
                            ${(op.demote_fail || 0) > 0 ? '<button class="btn btn-warning btn-xs" onclick="amRetry(' + op.id + ')" style="margin-left:4px">Retry</button>' : ''}
                        </td>
                    </tr>`;
                }).join('')}</tbody>
            </table>
        </div>`;
    });
}
