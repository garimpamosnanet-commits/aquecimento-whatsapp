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
            _nextId: { chips: 1, activity_log: 1, warming_groups: 1, proxies: 1 }
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

    return data;
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
    if (status === 'connected') chip.connected_at = now();
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
        connected: chips.filter(c => c.status === 'connected' || c.status === 'warming').length,
        warming: chips.filter(c => c.status === 'warming').length,
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
    const proxy = { id, url, assigned_chip_id: null, status: 'available', created_at: now() };
    data.proxies.push(proxy);
    saveDb(data);
    return proxy;
}

function addProxiesBulk(urls) {
    const data = loadDb();
    if (!data.proxies) data.proxies = [];
    if (!data._nextId.proxies) data._nextId.proxies = 1;
    const added = [];
    for (const url of urls) {
        const trimmed = url.trim();
        if (!trimmed) continue;
        const id = data._nextId.proxies;
        data._nextId.proxies = id + 1;
        const proxy = { id, url: trimmed, assigned_chip_id: null, status: 'available', created_at: now() };
        data.proxies.push(proxy);
        added.push(proxy);
    }
    saveDb(data);
    return added;
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
    updateProxyUrl
};
