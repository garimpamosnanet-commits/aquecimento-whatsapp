const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'warming.json');

// ==================== JSON DATABASE ====================

function loadDb() {
    if (!fs.existsSync(DB_PATH)) {
        const initial = {
            chips: [],
            activity_log: [],
            warming_groups: [],
            warming_group_members: [],
            warming_config: [
                { id: 1, phase: 1, daily_limit: 50, min_delay_seconds: 60, max_delay_seconds: 300, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,location', description: 'Fase 1 (Dia 1-3): Inicio - textos e localizacao' },
                { id: 2, phase: 2, daily_limit: 150, min_delay_seconds: 30, max_delay_seconds: 180, active_hour_start: 8, active_hour_end: 23, enabled_actions: 'private_chat,audio,group_chat,location,image', description: 'Fase 2 (Dia 4-7): Medio - audio, grupos, imagem, localizacao' },
                { id: 3, phase: 3, daily_limit: 250, min_delay_seconds: 20, max_delay_seconds: 120, active_hour_start: 7, active_hour_end: 23, enabled_actions: 'private_chat,audio,group_chat,status,sticker,reaction,location,image', description: 'Fase 3 (Dia 8-12): Intenso - todos os tipos' },
                { id: 4, phase: 4, daily_limit: 200, min_delay_seconds: 30, max_delay_seconds: 180, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,status,sticker,reaction,location,image', description: 'Fase 4 (Dia 13-15): Finalizacao + manutencao' }
            ],
            proxies: [],
            folders: [],
            _nextId: { chips: 1, activity_log: 1, warming_groups: 1, proxies: 1, folders: 1 }
        };
        saveDb(initial);
        return initial;
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function saveDb(data) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function getDb() {
    const data = loadDb();
    // Migrate: update warming config to include location/image actions
    if (data.warming_config && data.warming_config[0] && !data.warming_config[0].enabled_actions.includes('location')) {
        data.warming_config = [
            { id: 1, phase: 1, daily_limit: 50, min_delay_seconds: 60, max_delay_seconds: 300, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,location', description: 'Fase 1 (Dia 1-3): Inicio - textos e localizacao' },
            { id: 2, phase: 2, daily_limit: 150, min_delay_seconds: 30, max_delay_seconds: 180, active_hour_start: 8, active_hour_end: 23, enabled_actions: 'private_chat,audio,group_chat,location,image', description: 'Fase 2 (Dia 4-7): Medio - audio, grupos, imagem, localizacao' },
            { id: 3, phase: 3, daily_limit: 250, min_delay_seconds: 20, max_delay_seconds: 120, active_hour_start: 7, active_hour_end: 23, enabled_actions: 'private_chat,audio,group_chat,status,sticker,reaction,location,image', description: 'Fase 3 (Dia 8-12): Intenso - todos os tipos' },
            { id: 4, phase: 4, daily_limit: 200, min_delay_seconds: 30, max_delay_seconds: 180, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,status,sticker,reaction,location,image', description: 'Fase 4 (Dia 13-15): Finalizacao + manutencao' }
        ];
        saveDb(data);
        console.log('[DB] Config migrada para incluir location/image');
    }
    // Migrate: add folders collection if missing
    if (!data.folders) {
        data.folders = [];
        if (!data._nextId.folders) data._nextId.folders = 1;
        saveDb(data);
        console.log('[DB] Migrated: added folders collection');
    }

    // Migrate: add rehabilitation config (phase 5) if missing
    if (data.warming_config && !data.warming_config.find(c => c.phase === 5)) {
        data.warming_config.push({
            id: 5, phase: 5, daily_limit: 30, min_delay_seconds: 180, max_delay_seconds: 600,
            active_hour_start: 9, active_hour_end: 20,
            enabled_actions: 'private_chat,location',
            description: 'Reabilitacao - recuperacao controlada'
        });
        saveDb(data);
        console.log('[DB] Config migrada: fase 5 (reabilitacao) adicionada');
    }

    // Migrate: add group_add collections if missing
    if (!data.group_add_operations) {
        data.group_add_operations = [];
        data.group_add_items = [];
        if (!data._nextId.group_add_operations) data._nextId.group_add_operations = 1;
        if (!data._nextId.group_add_items) data._nextId.group_add_items = 1;
        saveDb(data);
        console.log('[DB] Migrated: added group_add collections');
    }

    // Migrate: switch HTTP proxies to SOCKS5 (port 12323 -> 12324)
    if (data.proxies && data.proxies.length > 0 && data.proxies[0].url && data.proxies[0].url.startsWith('http://')) {
        let migrated = 0;
        for (const proxy of data.proxies) {
            if (proxy.url.startsWith('http://')) {
                proxy.url = proxy.url.replace('http://', 'socks5://').replace(':12323', ':12324');
                migrated++;
            }
        }
        if (migrated > 0) {
            saveDb(data);
            console.log(`[DB] ${migrated} proxies migrados de HTTP para SOCKS5`);
        }
    }

    // Migrate: add schedule and notifications config
    if (!data.settings) {
        data.settings = {
            schedule: { enabled: false, start_hour: 8, start_min: 0, stop_hour: 22, stop_min: 0 },
            notifications: { enabled: false, phone: '', events: ['disconnect', 'ban', 'phase_change', 'error', 'ready'] },
            proxy_rotation: { enabled: false, interval_hours: 6 },
            messages: []
        };
        if (!data._nextId.messages) data._nextId.messages = 1;
        saveDb(data);
        console.log('[DB] Migrated: added settings (schedule, notifications, proxy_rotation, messages)');
    }

    // Migrate: add expires_at to existing proxies (30 days from created_at)
    if (data.proxies && data.proxies.length > 0 && !data.proxies[0].expires_at) {
        for (const proxy of data.proxies) {
            const created = new Date(proxy.created_at || Date.now());
            proxy.expires_at = new Date(created.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        }
        saveDb(data);
        console.log(`[DB] Migrated: added expires_at to ${data.proxies.length} proxies`);
    }

    // Apply recommended safe warming config (force v2)
    if (data.warming_config && !data._warmingConfigV2) {
        const safeConfig = {
            1: { daily_limit: 15, min_delay_seconds: 120, max_delay_seconds: 360, active_hour_start: 9, active_hour_end: 20, enabled_actions: 'private_chat,location', description: 'Fase 1 (Dia 1-3): Inicio suave - textos e localizacao' },
            2: { daily_limit: 40, min_delay_seconds: 60, max_delay_seconds: 240, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,location', description: 'Fase 2 (Dia 4-7): Medio - audio e localizacao' },
            3: { daily_limit: 80, min_delay_seconds: 45, max_delay_seconds: 180, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,sticker', description: 'Fase 3 (Dia 8-14): Crescimento - grupos e stickers' },
            4: { daily_limit: 130, min_delay_seconds: 40, max_delay_seconds: 150, active_hour_start: 7, active_hour_end: 23, enabled_actions: 'private_chat,audio,group_chat,sticker,image', description: 'Fase 4 (Dia 15-21): Teto seguro - todos os tipos' },
            5: { daily_limit: 20, min_delay_seconds: 240, max_delay_seconds: 600, active_hour_start: 9, active_hour_end: 19, enabled_actions: 'private_chat,location', description: 'Reabilitacao - recuperacao controlada' }
        };
        for (const phase of Object.keys(safeConfig)) {
            const cfg = data.warming_config.find(c => c.phase === parseInt(phase));
            if (cfg) Object.assign(cfg, safeConfig[phase]);
        }
        data._warmingConfigV2 = true;
        saveDb(data);
        console.log('[DB] Warming config otimizado para modelo seguro');
    }

    // V3: Ultra-safe warming config — after 4 accounts restricted (2026-04-09)
    if (data.warming_config && !data._warmingConfigV3) {
        const ultraSafe = {
            1: { daily_limit: 10, min_delay_seconds: 180, max_delay_seconds: 480, active_hour_start: 9, active_hour_end: 20, enabled_actions: 'private_chat,location', description: 'Fase 1 (Dia 1-5): Ultra suave - poucos textos' },
            2: { daily_limit: 25, min_delay_seconds: 120, max_delay_seconds: 360, active_hour_start: 9, active_hour_end: 21, enabled_actions: 'private_chat,audio,location', description: 'Fase 2 (Dia 6-12): Suave - audio e localizacao' },
            3: { daily_limit: 50, min_delay_seconds: 90, max_delay_seconds: 240, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,location,sticker', description: 'Fase 3 (Dia 13-20): Moderado - grupos e stickers' },
            4: { daily_limit: 80, min_delay_seconds: 60, max_delay_seconds: 180, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,sticker,image,reaction', description: 'Fase 4 (Dia 21+): Teto seguro - todos os tipos' },
            5: { daily_limit: 10, min_delay_seconds: 300, max_delay_seconds: 720, active_hour_start: 10, active_hour_end: 18, enabled_actions: 'private_chat,location', description: 'Reabilitacao - ultra controlada' }
        };
        for (const phase of Object.keys(ultraSafe)) {
            const cfg = data.warming_config.find(c => c.phase === parseInt(phase));
            if (cfg) Object.assign(cfg, ultraSafe[phase]);
        }
        data._warmingConfigV3 = true;
        saveDb(data);
        console.log('[DB] Warming config V3: ultra-safe aplicado (4 contas restritas)');
    }

    // V4: Fix hours 8-22 ALL phases + reduce volumes after 3 restrictions + 1 ban (2026-04-08)
    if (data.warming_config && !data._warmingConfigV4) {
        const v4Config = {
            1: { daily_limit: 8, min_delay_seconds: 240, max_delay_seconds: 600, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,location', description: 'Fase 1 (Dia 1-5): Ultra suave - 8 msgs max' },
            2: { daily_limit: 18, min_delay_seconds: 150, max_delay_seconds: 420, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,location', description: 'Fase 2 (Dia 6-12): Suave - audio e localizacao' },
            3: { daily_limit: 35, min_delay_seconds: 120, max_delay_seconds: 300, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,location,sticker', description: 'Fase 3 (Dia 13-20): Moderado - grupos e stickers' },
            4: { daily_limit: 55, min_delay_seconds: 90, max_delay_seconds: 240, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,audio,group_chat,sticker,image,reaction', description: 'Fase 4 (Dia 21+): Teto seguro' },
            5: { daily_limit: 5, min_delay_seconds: 360, max_delay_seconds: 900, active_hour_start: 8, active_hour_end: 22, enabled_actions: 'private_chat,location', description: 'Reabilitacao - ultra controlada' }
        };
        for (const phase of Object.keys(v4Config)) {
            const cfg = data.warming_config.find(c => c.phase === parseInt(phase));
            if (cfg) Object.assign(cfg, v4Config[phase]);
        }
        data._warmingConfigV4 = true;
        saveDb(data);
        console.log('[DB] Warming config V4: horario 8-22 + volumes reduzidos (3 restricoes + 1 ban)');
    }

    // Force-enable notifications to CHIPS - KS Digital group (somente grupo)
    if (data.settings && !data._notifGroupOnlyV2) {
        data.settings.notifications.enabled = true;
        data.settings.notifications.phone = '';
        data.settings.notifications.events = ['disconnect', 'ban', 'phase_change', 'error', 'ready', 'daily_report'];
        data._notifGroupOnlyV2 = true;
        saveDb(data);
        console.log('[DB] Notificacoes ativadas (somente grupo)');
    }

    // Migrate: add daily_stats collection
    if (!data.daily_stats) {
        data.daily_stats = [];
        saveDb(data);
        console.log('[DB] Migrated: added daily_stats');
    }

    // Migrate: add admin_manage collections
    if (!data.admin_manage_operations) {
        data.admin_manage_operations = [];
        data.admin_manage_items = [];
        if (!data._nextId.admin_manage_operations) data._nextId.admin_manage_operations = 1;
        if (!data._nextId.admin_manage_items) data._nextId.admin_manage_items = 1;
        saveDb(data);
        console.log('[DB] Migrated: added admin_manage collections');
    }

    // Migrate: add group_done_marks (shared group tracking)
    if (!data.group_done_marks) {
        data.group_done_marks = {};  // { groupId: { done_at, done_by } }
        saveDb(data);
        console.log('[DB] Migrated: added group_done_marks');
    }

    // Migrate: add group_invite_links cache
    if (!data.group_invite_links) {
        data.group_invite_links = {};  // { groupId: { link, fetched_at } }
        saveDb(data);
        console.log('[DB] Migrated: added group_invite_links');
    }

    // Migrate: add group_add_daily_counts for safe mode
    if (!data.group_add_daily_counts) {
        data.group_add_daily_counts = {};  // { phone: { "2026-04-13": 3 } }
        saveDb(data);
        console.log('[DB] Migrated: added group_add_daily_counts');
    }

    return data;
}

function getSettings() {
    const data = loadDb();
    return data.settings || {};
}

function updateSettings(key, value) {
    const data = loadDb();
    if (!data.settings) data.settings = {};
    data.settings[key] = value;
    saveDb(data);
    return data.settings;
}

function addDailyStat(date, stats) {
    const data = loadDb();
    const existing = data.daily_stats.findIndex(s => s.date === date);
    if (existing >= 0) {
        data.daily_stats[existing] = { date, ...stats };
    } else {
        data.daily_stats.push({ date, ...stats });
    }
    // Keep last 30 days
    if (data.daily_stats.length > 30) data.daily_stats = data.daily_stats.slice(-30);
    saveDb(data);
}

function getDailyStats(days = 7) {
    const data = loadDb();
    return (data.daily_stats || []).slice(-days);
}

function getCustomMessages() {
    const data = loadDb();
    return data.settings?.messages || [];
}

function saveCustomMessages(messages) {
    const data = loadDb();
    if (!data.settings) data.settings = {};
    data.settings.messages = messages;
    saveDb(data);
}

function nextId(collection) {
    const data = loadDb();
    const id = data._nextId[collection] || 1;
    data._nextId[collection] = id + 1;
    saveDb(data);
    return id;
}

function now() {
    return new Date().toISOString();
}

// ==================== CHIPS ====================

function createChip(sessionId, name = '') {
    const data = loadDb();
    const id = data._nextId.chips || 1;
    data._nextId.chips = id + 1;
    const chip = {
        id, phone: null, name, status: 'disconnected', phase: 1,
        messages_sent: 0, messages_target: 2500,
        created_at: now(), connected_at: null, session_id: sessionId
    };
    data.chips.push(chip);
    saveDb(data);
    return chip;
}

function getChipById(id) {
    return loadDb().chips.find(c => c.id === id) || null;
}

function getChipBySession(sessionId) {
    return loadDb().chips.find(c => c.session_id === sessionId) || null;
}

function getAllChips() {
    return loadDb().chips.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function updateChipStatus(id, status) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === id);
    if (!chip) return null;
    chip.status = status;
    if (status === 'connected' && !chip.connected_at) chip.connected_at = now();
    saveDb(data);
    return chip;
}

function updateChipPhone(id, phone) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === id);
    if (chip) { chip.phone = phone; saveDb(data); }
}

function updateChipName(id, name) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === id);
    if (chip) { chip.name = name; saveDb(data); }
}

function updateChipField(id, field, value) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === id);
    if (chip) { chip[field] = value; saveDb(data); }
}

function incrementMessagesSent(id) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === id);
    if (chip) { chip.messages_sent++; saveDb(data); }
}

function updateChipPhase(id, phase) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === id);
    if (chip) { chip.phase = phase; saveDb(data); }
}

function deleteChip(id) {
    const data = loadDb();
    data.chips = data.chips.filter(c => c.id !== id);
    data.activity_log = data.activity_log.filter(a => a.chip_id !== id);
    saveDb(data);
}

function getChipStats() {
    const chips = loadDb().chips;
    return {
        total: chips.length,
        connected: chips.filter(c => c.status === 'connected' || c.status === 'warming' || c.status === 'rehabilitation').length,
        warming: chips.filter(c => c.status === 'warming').length,
        rehabilitation: chips.filter(c => c.status === 'rehabilitation').length,
        discarded: chips.filter(c => c.status === 'discarded').length,
        totalMessages: chips.reduce((sum, c) => sum + c.messages_sent, 0)
    };
}

// ==================== WARMING CONFIG ====================

function getWarmingConfig(phase) {
    return loadDb().warming_config.find(c => c.phase === phase) || null;
}

function getAllWarmingConfigs() {
    return loadDb().warming_config.sort((a, b) => a.phase - b.phase);
}

function updateWarmingConfig(phase, updates) {
    const data = loadDb();
    const config = data.warming_config.find(c => c.phase === phase);
    if (config) {
        Object.assign(config, updates);
        saveDb(data);
    }
}

// ==================== ACTIVITY LOG ====================

function logActivity(chipId, actionType, target = null, details = null, success = 1) {
    const data = loadDb();
    const id = data._nextId.activity_log || 1;
    data._nextId.activity_log = id + 1;
    data.activity_log.push({ id, chip_id: chipId, action_type: actionType, target, details, success, created_at: now() });
    // Keep only last 5000 entries to prevent file bloat
    if (data.activity_log.length > 5000) {
        data.activity_log = data.activity_log.slice(-5000);
    }
    saveDb(data);
}

function getRecentActivity(chipId = null, limit = 50) {
    const data = loadDb();
    let logs = data.activity_log;
    if (chipId) logs = logs.filter(a => a.chip_id === chipId);
    logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return logs.slice(0, limit).map(a => {
        const chip = data.chips.find(c => c.id === a.chip_id);
        return { ...a, phone: chip?.phone, name: chip?.name };
    });
}

function getTodayMessageCount(chipId) {
    const today = new Date().toISOString().slice(0, 10);
    return loadDb().activity_log.filter(a =>
        a.chip_id === chipId && a.created_at.startsWith(today)
    ).length;
}

// ==================== GROUPS ====================

function createWarmingGroup(groupJid, groupName, createdBy) {
    const data = loadDb();
    const id = data._nextId.warming_groups || 1;
    data._nextId.warming_groups = id + 1;
    data.warming_groups.push({ id, group_jid: groupJid, group_name: groupName, created_by: createdBy, member_count: 0, created_at: now() });
    saveDb(data);
    return id;
}

function addGroupMember(groupId, chipId) {
    const data = loadDb();
    const exists = data.warming_group_members.find(m => m.group_id === groupId && m.chip_id === chipId);
    if (!exists) {
        data.warming_group_members.push({ group_id: groupId, chip_id: chipId, joined_at: now() });
        const group = data.warming_groups.find(g => g.id === groupId);
        if (group) group.member_count = data.warming_group_members.filter(m => m.group_id === groupId).length;
        saveDb(data);
    }
}

function getWarmingGroups() {
    return loadDb().warming_groups.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getGroupMembers(groupId) {
    const data = loadDb();
    const memberIds = data.warming_group_members.filter(m => m.group_id === groupId).map(m => m.chip_id);
    return data.chips.filter(c => memberIds.includes(c.id));
}

// ==================== PROXIES ====================

function addProxy(url) {
    const data = loadDb();
    if (!data.proxies) data.proxies = [];
    if (!data._nextId.proxies) data._nextId.proxies = 1;
    const id = data._nextId.proxies;
    data._nextId.proxies = id + 1;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const proxy = { id, url, assigned_chip_id: null, status: 'available', created_at: now(), expires_at: expiresAt };
    data.proxies.push(proxy);
    saveDb(data);
    return proxy;
}

function addProxiesBulk(urls) {
    const data = loadDb();
    if (!data.proxies) data.proxies = [];
    if (!data._nextId.proxies) data._nextId.proxies = 1;
    const added = [];
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const url of urls) {
        const trimmed = url.trim();
        if (!trimmed) continue;
        const id = data._nextId.proxies;
        data._nextId.proxies = id + 1;
        const proxy = { id, url: trimmed, assigned_chip_id: null, status: 'available', created_at: now(), expires_at: expiresAt };
        data.proxies.push(proxy);
        added.push(proxy);
    }
    saveDb(data);
    return added;
}

function updateProxyExpiry(proxyId, expiresAt) {
    const data = loadDb();
    const proxy = (data.proxies || []).find(p => p.id === proxyId);
    if (!proxy) return null;
    proxy.expires_at = expiresAt;
    saveDb(data);
    return proxy;
}

function getAllProxies() {
    const data = loadDb();
    return (data.proxies || []).sort((a, b) => a.id - b.id);
}

function deleteProxy(id) {
    const data = loadDb();
    if (!data.proxies) return;
    data.proxies = data.proxies.filter(p => p.id !== id);
    saveDb(data);
}

function deleteAllProxies() {
    const data = loadDb();
    data.proxies = [];
    // Also clear proxy assignments from chips
    for (const chip of data.chips) {
        delete chip.proxy_id;
    }
    saveDb(data);
}

function assignProxyToChip(chipId) {
    const data = loadDb();
    if (!data.proxies || data.proxies.length === 0) return null;
    // Find first available proxy
    const proxy = data.proxies.find(p => !p.assigned_chip_id);
    if (!proxy) return null;
    proxy.assigned_chip_id = chipId;
    proxy.status = 'in_use';
    // Also save proxy_id on chip
    const chip = data.chips.find(c => c.id === chipId);
    if (chip) chip.proxy_id = proxy.id;
    saveDb(data);
    return proxy;
}

function releaseProxy(chipId) {
    const data = loadDb();
    if (!data.proxies) return;
    const proxy = data.proxies.find(p => p.assigned_chip_id === chipId);
    if (proxy) {
        proxy.assigned_chip_id = null;
        proxy.status = 'available';
    }
    const chip = data.chips.find(c => c.id === chipId);
    if (chip) delete chip.proxy_id;
    saveDb(data);
}

function getProxyForChip(chipId) {
    const data = loadDb();
    if (!data.proxies) return null;
    return data.proxies.find(p => p.assigned_chip_id === chipId) || null;
}

function updateProxyUrl(id, newUrl) {
    const data = loadDb();
    const proxy = (data.proxies || []).find(p => p.id === id);
    if (!proxy) return null;
    proxy.url = newUrl;
    saveDb(data);
    return proxy;
}

function getProxyStats() {
    const data = loadDb();
    const proxies = data.proxies || [];
    return {
        total: proxies.length,
        available: proxies.filter(p => !p.assigned_chip_id).length,
        in_use: proxies.filter(p => p.assigned_chip_id).length
    };
}

// ==================== FOLDERS ====================

function createFolder(name) {
    const data = loadDb();
    if (!data.folders) data.folders = [];
    if (!data._nextId.folders) data._nextId.folders = 1;
    const id = data._nextId.folders;
    data._nextId.folders = id + 1;
    const folder = { id, name, created_at: now() };
    data.folders.push(folder);
    saveDb(data);
    return folder;
}

function getAllFolders() {
    const data = loadDb();
    return (data.folders || []).sort((a, b) => a.id - b.id);
}

function updateFolder(id, name) {
    const data = loadDb();
    if (!data.folders) return null;
    const folder = data.folders.find(f => f.id === id);
    if (!folder) return null;
    folder.name = name;
    saveDb(data);
    return folder;
}

function deleteFolder(id) {
    const data = loadDb();
    if (!data.folders) return;
    data.folders = data.folders.filter(f => f.id !== id);
    // Unassign all chips from this folder
    for (const chip of data.chips) {
        if (chip.folder_id === id) delete chip.folder_id;
    }
    saveDb(data);
}

function assignChipToFolder(chipId, folderId) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === chipId);
    if (!chip) return null;
    if (folderId === null || folderId === undefined) {
        delete chip.folder_id;
    } else {
        chip.folder_id = folderId;
    }
    saveDb(data);
    return chip;
}

// ==================== REHABILITATION ====================

function enterRehabilitation(chipId, reason) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === chipId);
    if (!chip) return null;
    chip.rehab_reason = reason || 'manual';
    chip.rehab_started_at = now();
    chip.rehab_previous_phase = chip.phase;
    chip.phase = 5;
    chip.status = 'rehabilitation';
    saveDb(data);
    return chip;
}

function exitRehabilitation(chipId, targetPhase) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === chipId);
    if (!chip || chip.status !== 'rehabilitation') return null;
    chip.phase = targetPhase || 3;
    chip.status = 'connected';
    delete chip.rehab_reason;
    delete chip.rehab_started_at;
    delete chip.rehab_previous_phase;
    saveDb(data);
    return chip;
}

function markChipDiscarded(chipId) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === chipId);
    if (!chip) return null;
    chip.status = 'discarded';
    chip.discarded_at = now();
    delete chip.rehab_reason;
    delete chip.rehab_started_at;
    delete chip.rehab_previous_phase;
    saveDb(data);
    return chip;
}

function getChipsInRehab() {
    return loadDb().chips.filter(c => c.status === 'rehabilitation');
}

// ==================== INSTANCE TYPE ====================

function setChipInstanceType(chipId, instanceType) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === chipId);
    if (!chip) return null;
    chip.instance_type = instanceType; // 'warming' | 'admin'
    saveDb(data);
    return chip;
}

function getAdminInstances() {
    const data = loadDb();
    return data.chips.filter(c => c.instance_type === 'admin');
}

function getWarmingChipsForAdd() {
    const data = loadDb();
    return data.chips.filter(c =>
        (c.instance_type || 'warming') === 'warming' &&
        (c.status === 'warming' || c.status === 'connected' || c.status === 'rehabilitation') &&
        c.phone
    );
}

// ==================== GROUP ADD OPERATIONS ====================

function createAddOperation(adminChipId, config) {
    const data = loadDb();
    if (!data.group_add_operations) data.group_add_operations = [];
    if (!data._nextId.group_add_operations) data._nextId.group_add_operations = 1;
    const id = data._nextId.group_add_operations;
    data._nextId.group_add_operations = id + 1;
    const op = {
        id, admin_chip_id: adminChipId, status: 'pending',
        total_additions: 0, success_count: 0, fail_count: 0, skip_count: 0,
        admin_promoted_count: 0, admin_failed_count: 0,
        config: JSON.stringify(config || {}),
        started_at: null, completed_at: null, created_at: now()
    };
    data.group_add_operations.push(op);
    saveDb(data);
    return op;
}

function getAddOperation(id) {
    const data = loadDb();
    return (data.group_add_operations || []).find(o => o.id === id) || null;
}

function updateAddOperation(id, updates) {
    const data = loadDb();
    const op = (data.group_add_operations || []).find(o => o.id === id);
    if (!op) return null;
    Object.assign(op, updates);
    saveDb(data);
    return op;
}

function getAddOperations(limit) {
    const data = loadDb();
    const ops = (data.group_add_operations || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return limit ? ops.slice(0, limit) : ops;
}

function addOperationItems(operationId, items) {
    const data = loadDb();
    if (!data.group_add_items) data.group_add_items = [];
    if (!data._nextId.group_add_items) data._nextId.group_add_items = 1;
    const added = [];
    for (const item of items) {
        const id = data._nextId.group_add_items;
        data._nextId.group_add_items = id + 1;
        const record = {
            id, operation_id: operationId,
            phone_number: item.phone_number,
            source: item.source || 'chip',
            chip_id: item.chip_id || null,
            chip_session_id: item.chip_session_id || null,
            group_id: item.group_id,
            group_name: item.group_name || null,
            status: 'pending',
            admin_promoted: 0,
            admin_error: null,
            error_message: null,
            processed_at: null
        };
        data.group_add_items.push(record);
        added.push(record);
    }
    // Update total on operation
    const op = data.group_add_operations.find(o => o.id === operationId);
    if (op) op.total_additions = added.length;
    saveDb(data);
    return added;
}

function getOperationItems(operationId) {
    const data = loadDb();
    return (data.group_add_items || []).filter(i => i.operation_id === operationId);
}

function updateOperationItem(id, updates) {
    const data = loadDb();
    const item = (data.group_add_items || []).find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, updates);
    saveDb(data);
    return item;
}

function getFailedItems(operationId) {
    const data = loadDb();
    return (data.group_add_items || []).filter(i => i.operation_id === operationId && i.status === 'failed');
}

// ==================== ADMIN MANAGE OPERATIONS ====================

function createAdminManageOperation(adminChipId, config) {
    const data = loadDb();
    if (!data.admin_manage_operations) data.admin_manage_operations = [];
    if (!data._nextId.admin_manage_operations) data._nextId.admin_manage_operations = 1;
    const id = data._nextId.admin_manage_operations;
    data._nextId.admin_manage_operations = id + 1;
    const op = {
        id, admin_chip_id: adminChipId, status: 'pending',
        total_items: 0, demote_ok: 0, demote_fail: 0,
        remove_ok: 0, remove_fail: 0, skip_count: 0,
        config: JSON.stringify(config || {}),
        started_at: null, completed_at: null, created_at: now()
    };
    data.admin_manage_operations.push(op);
    saveDb(data);
    return op;
}

function getAdminManageOperation(id) {
    const data = loadDb();
    return (data.admin_manage_operations || []).find(o => o.id === id) || null;
}

function updateAdminManageOperation(id, updates) {
    const data = loadDb();
    const op = (data.admin_manage_operations || []).find(o => o.id === id);
    if (!op) return null;
    Object.assign(op, updates);
    saveDb(data);
    return op;
}

function getAdminManageOperations(limit) {
    const data = loadDb();
    const ops = (data.admin_manage_operations || []).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return limit ? ops.slice(0, limit) : ops;
}

function addAdminManageItems(operationId, items) {
    const data = loadDb();
    if (!data.admin_manage_items) data.admin_manage_items = [];
    if (!data._nextId.admin_manage_items) data._nextId.admin_manage_items = 1;
    const added = [];
    for (const item of items) {
        const id = data._nextId.admin_manage_items;
        data._nextId.admin_manage_items = id + 1;
        const record = {
            id, operation_id: operationId,
            jid: item.jid,
            phone: item.phone,
            group_id: item.group_id,
            group_name: item.group_name || null,
            is_me: item.is_me || false,
            is_super: item.is_super || false,
            status: 'pending',
            demote_status: null,
            remove_status: null,
            error_message: null,
            processed_at: null
        };
        data.admin_manage_items.push(record);
        added.push(record);
    }
    const op = data.admin_manage_operations.find(o => o.id === operationId);
    if (op) op.total_items = added.length;
    saveDb(data);
    return added;
}

function getAdminManageItems(operationId) {
    const data = loadDb();
    return (data.admin_manage_items || []).filter(i => i.operation_id === operationId);
}

function updateAdminManageItem(id, updates) {
    const data = loadDb();
    const item = (data.admin_manage_items || []).find(i => i.id === id);
    if (!item) return null;
    Object.assign(item, updates);
    saveDb(data);
    return item;
}

function getFailedAdminManageItems(operationId) {
    const data = loadDb();
    return (data.admin_manage_items || []).filter(i => i.operation_id === operationId && i.status === 'failed');
}

// ==================== GROUP DONE MARKS ====================

function getGroupDoneMarks() {
    const data = loadDb();
    return data.group_done_marks || {};
}

function setGroupDoneMark(groupId, done, userName) {
    const data = loadDb();
    if (!data.group_done_marks) data.group_done_marks = {};
    if (done) {
        data.group_done_marks[groupId] = { done_at: new Date().toISOString(), done_by: userName || 'unknown' };
    } else {
        delete data.group_done_marks[groupId];
    }
    saveDb(data);
    return data.group_done_marks;
}

// ==================== GROUP INVITE LINKS CACHE ====================

function getGroupInviteLinks() {
    const data = loadDb();
    return data.group_invite_links || {};
}

function setGroupInviteLink(groupId, link) {
    const data = loadDb();
    if (!data.group_invite_links) data.group_invite_links = {};
    data.group_invite_links[groupId] = { link, fetched_at: new Date().toISOString() };
    saveDb(data);
}

function setGroupInviteLinksBulk(linksMap) {
    const data = loadDb();
    if (!data.group_invite_links) data.group_invite_links = {};
    for (const [groupId, link] of Object.entries(linksMap)) {
        data.group_invite_links[groupId] = { link, fetched_at: new Date().toISOString() };
    }
    saveDb(data);
    return data.group_invite_links;
}

// ==================== CLIENT TAG ====================

function setChipClientTag(chipId, clientTag) {
    const data = loadDb();
    const chip = data.chips.find(c => c.id === chipId);
    if (!chip) return null;
    chip.client_tag = clientTag || null;
    saveDb(data);
    return chip;
}

function getChipsByClientTag(clientTag) {
    const data = loadDb();
    return data.chips.filter(c => c.client_tag === clientTag);
}

function getChipsByFolder(folderId) {
    const data = loadDb();
    return data.chips.filter(c => c.folder_id === folderId);
}

function getAllClientTags() {
    const data = loadDb();
    const tags = new Set();
    for (const chip of data.chips) {
        if (chip.client_tag) tags.add(chip.client_tag);
    }
    return Array.from(tags).sort();
}

// ==================== GROUP ADD DAILY COUNTS ====================

function getChipDailyCount(phone, date) {
    const data = loadDb();
    if (!data.group_add_daily_counts) return 0;
    return data.group_add_daily_counts[phone]?.[date] || 0;
}

function incrementChipDailyCount(phone, date) {
    const data = loadDb();
    if (!data.group_add_daily_counts) data.group_add_daily_counts = {};
    if (!data.group_add_daily_counts[phone]) data.group_add_daily_counts[phone] = {};
    data.group_add_daily_counts[phone][date] = (data.group_add_daily_counts[phone][date] || 0) + 1;
    saveDb(data);
    return data.group_add_daily_counts[phone][date];
}

function getAllDailyCounts(date) {
    const data = loadDb();
    if (!data.group_add_daily_counts) return {};
    const result = {};
    for (const [phone, dates] of Object.entries(data.group_add_daily_counts)) {
        if (dates[date]) result[phone] = dates[date];
    }
    return result;
}

function getPendingItems(operationId) {
    const data = loadDb();
    return (data.group_add_items || []).filter(i =>
        i.operation_id === operationId && (i.status === 'pending' || i.status === 'daily_skipped')
    );
}

module.exports = {
    getDb,
    createChip, getChipById, getChipBySession, getAllChips,
    updateChipStatus, updateChipPhone, updateChipName, updateChipField,
    incrementMessagesSent, updateChipPhase, deleteChip, getChipStats,
    getWarmingConfig, getAllWarmingConfigs, updateWarmingConfig,
    logActivity, getRecentActivity, getTodayMessageCount,
    createWarmingGroup, addGroupMember, getWarmingGroups, getGroupMembers,
    addProxy, addProxiesBulk, getAllProxies, deleteProxy, deleteAllProxies,
    assignProxyToChip, releaseProxy, getProxyForChip, getProxyStats,
    updateProxyUrl, updateProxyExpiry,
    createFolder, getAllFolders, updateFolder, deleteFolder, assignChipToFolder,
    enterRehabilitation, exitRehabilitation, markChipDiscarded, getChipsInRehab,
    setChipInstanceType, getAdminInstances, getWarmingChipsForAdd,
    createAddOperation, getAddOperation, updateAddOperation, getAddOperations,
    addOperationItems, getOperationItems, updateOperationItem, getFailedItems,
    getSettings, updateSettings, addDailyStat, getDailyStats,
    getCustomMessages, saveCustomMessages,
    createAdminManageOperation, getAdminManageOperation, updateAdminManageOperation,
    getAdminManageOperations, addAdminManageItems, getAdminManageItems,
    updateAdminManageItem, getFailedAdminManageItems,
    getGroupDoneMarks, setGroupDoneMark,
    getGroupInviteLinks, setGroupInviteLink, setGroupInviteLinksBulk,
    setChipClientTag, getChipsByClientTag, getChipsByFolder, getAllClientTags,
    getChipDailyCount, incrementChipDailyCount, getAllDailyCounts, getPendingItems,
    _loadDb: loadDb, _saveDb: saveDb
};
