const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');

// Media upload config
const mediaStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const type = req.params.type; // audios, images, stickers
        const dir = path.join(__dirname, '..', '..', 'media', type);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    }
});
const upload = multer({ storage: mediaStorage, limits: { fileSize: 10 * 1024 * 1024 } });

module.exports = function(sessionManager, warmingEngine, groupManager) {

    // ==================== CHIPS ====================

    // List all chips (with proxy info)
    router.get('/chips', (req, res) => {
        const chips = db.getAllChips().map(chip => {
            const proxy = db.getProxyForChip(chip.id);
            return { ...chip, proxy_ip: proxy ? proxy.url.replace(/.*@/, '').replace(/:.*/, '') : null };
        });
        res.json(chips);
    });

    // Get chip stats
    router.get('/stats', (req, res) => {
        res.json(db.getChipStats());
    });

    // Create new chip session (triggers QR code via WebSocket)
    router.post('/chips', async (req, res) => {
        try {
            const { name } = req.body || {};
            const chip = await sessionManager.createSession(name || '');
            res.json({ success: true, chip });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Rename chip
    router.put('/chips/:id/name', (req, res) => {
        const chip = db.getChipById(parseInt(req.params.id));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
        db.updateChipName(chip.id, name);
        sessionManager.emitChipUpdate(chip.id);
        res.json({ success: true });
    });

    // Disconnect chip
    router.post('/chips/:id/disconnect', async (req, res) => {
        const chip = db.getChipById(parseInt(req.params.id));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        warmingEngine.stopChip(chip.id);
        await sessionManager.disconnect(chip.session_id);
        res.json({ success: true });
    });

    // Delete chip
    router.delete('/chips/:id', async (req, res) => {
        const chip = db.getChipById(parseInt(req.params.id));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        warmingEngine.stopChip(chip.id);
        await sessionManager.deleteSession(chip.session_id);
        res.json({ success: true });
    });

    // ==================== WARMING ====================

    // Start warming for a chip
    router.post('/chips/:id/warming/start', (req, res) => {
        const chip = db.getChipById(parseInt(req.params.id));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        if (!sessionManager.isConnected(chip.session_id)) {
            return res.status(400).json({ error: 'Chip nao esta conectado' });
        }

        warmingEngine.startChip(chip.id);
        res.json({ success: true, message: `Aquecimento iniciado para ${chip.phone || chip.session_id}` });
    });

    // Stop warming for a chip
    router.post('/chips/:id/warming/stop', (req, res) => {
        const chip = db.getChipById(parseInt(req.params.id));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        warmingEngine.stopChip(chip.id);
        res.json({ success: true });
    });

    // Start warming for ALL connected chips
    router.post('/warming/start-all', (req, res) => {
        const chips = db.getAllChips();
        let started = 0;
        for (const chip of chips) {
            if (sessionManager.isConnected(chip.session_id) && chip.status !== 'warming') {
                warmingEngine.startChip(chip.id);
                started++;
            }
        }
        res.json({ success: true, started });
    });

    // Stop warming for ALL chips
    router.post('/warming/stop-all', (req, res) => {
        const chips = db.getAllChips();
        let stopped = 0;
        for (const chip of chips) {
            if (chip.status === 'warming') {
                warmingEngine.stopChip(chip.id);
                stopped++;
            }
        }
        res.json({ success: true, stopped });
    });

    // ==================== CONFIG ====================

    // Get warming configs
    router.get('/config', (req, res) => {
        res.json(db.getAllWarmingConfigs());
    });

    // Update warming config for a phase
    router.put('/config/:phase', (req, res) => {
        const phase = parseInt(req.params.phase);
        const updates = req.body;
        db.updateWarmingConfig(phase, updates);
        res.json({ success: true, config: db.getWarmingConfig(phase) });
    });

    // ==================== ACTIVITY ====================

    // Get recent activity
    router.get('/activity', (req, res) => {
        const { chipId, limit } = req.query;
        const activities = db.getRecentActivity(chipId ? parseInt(chipId) : null, parseInt(limit) || 50);
        res.json(activities);
    });

    // ==================== GROUPS ====================

    // List warming groups
    router.get('/groups', (req, res) => {
        res.json(db.getWarmingGroups());
    });

    // ==================== FOLDERS ====================

    // List all folders
    router.get('/folders', (req, res) => {
        res.json(db.getAllFolders());
    });

    // Create folder
    router.post('/folders', (req, res) => {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
        const folder = db.createFolder(name.trim());
        res.json({ success: true, folder });
    });

    // Rename folder
    router.put('/folders/:id', (req, res) => {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
        const folder = db.updateFolder(parseInt(req.params.id), name.trim());
        if (!folder) return res.status(404).json({ error: 'Pasta nao encontrada' });
        res.json({ success: true, folder });
    });

    // Delete folder (unassigns chips)
    router.delete('/folders/:id', (req, res) => {
        db.deleteFolder(parseInt(req.params.id));
        res.json({ success: true });
    });

    // Assign chip to folder
    router.put('/chips/:id/folder', (req, res) => {
        const chipId = parseInt(req.params.id);
        const { folder_id } = req.body;
        const chip = db.assignChipToFolder(chipId, folder_id);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        sessionManager.emitChipUpdate(chipId);
        res.json({ success: true, chip });
    });

    // ==================== TEST ====================

    // Send a test message between two chips
    router.post('/test-message', async (req, res) => {
        try {
            const chips = db.getAllChips().filter(c => c.status === 'warming' || c.status === 'connected');
            const connected = chips.filter(c => sessionManager.isConnected(c.session_id) && c.phone);
            if (connected.length < 2) {
                return res.status(400).json({ error: 'Precisa de pelo menos 2 chips conectados com numero' });
            }
            const sender = connected[0];
            const receiver = connected[1];
            const socket = sessionManager.getSocket(sender.session_id);
            if (!socket?.user) return res.status(400).json({ error: 'Socket do remetente nao encontrado' });

            const msg = 'Oi! Teste de aquecimento funcionando 🔥';
            const jid = receiver.phone + '@s.whatsapp.net';

            await socket.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, 1500));
            await socket.sendPresenceUpdate('paused', jid);
            await socket.sendMessage(jid, { text: msg });

            db.incrementMessagesSent(sender.id);
            db.logActivity(sender.id, 'private_chat', receiver.phone, msg);

            res.json({ success: true, from: sender.phone, to: receiver.phone, message: msg });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ==================== PROXIES ====================

    // List all proxies (sorted: in use first by chip name, then available)
    router.get('/proxies', (req, res) => {
        const proxies = db.getAllProxies();
        proxies.sort((a, b) => {
            const aUsed = a.assigned_chip_id ? 0 : 1;
            const bUsed = b.assigned_chip_id ? 0 : 1;
            if (aUsed !== bUsed) return aUsed - bUsed;
            if (a.assigned_chip_id && b.assigned_chip_id) {
                const chipA = db.getChipById(a.assigned_chip_id);
                const chipB = db.getChipById(b.assigned_chip_id);
                const nameA = (chipA?.name || '').toLowerCase();
                const nameB = (chipB?.name || '').toLowerCase();
                return nameA.localeCompare(nameB);
            }
            return 0;
        });
        res.json(proxies);
    });

    // Get proxy stats
    router.get('/proxies/stats', (req, res) => {
        res.json(db.getProxyStats());
    });

    // Add proxies (bulk - one per line)
    router.post('/proxies', (req, res) => {
        const { proxies } = req.body;
        if (!proxies || !Array.isArray(proxies)) {
            return res.status(400).json({ error: 'Envie um array de proxies' });
        }
        const added = db.addProxiesBulk(proxies);
        res.json({ success: true, added: added.length, proxies: added });
    });

    // Swap all proxy URLs (keeps assignments)
    router.put('/proxies/swap', (req, res) => {
        const { proxies } = req.body; // array of new URLs
        if (!proxies || !Array.isArray(proxies)) return res.status(400).json({ error: 'Array de proxies obrigatorio' });
        const current = db.getAllProxies();
        let updated = 0;
        for (let i = 0; i < Math.min(proxies.length, current.length); i++) {
            db.updateProxyUrl(current[i].id, proxies[i]);
            updated++;
        }
        res.json({ success: true, updated });
    });

    // Delete one proxy
    router.delete('/proxies/:id', (req, res) => {
        db.deleteProxy(parseInt(req.params.id));
        res.json({ success: true });
    });

    // Delete all proxies
    router.delete('/proxies', (req, res) => {
        db.deleteAllProxies();
        res.json({ success: true });
    });

    // ==================== REHABILITATION ====================

    // Get chips in rehabilitation
    router.get('/rehab', (req, res) => {
        const chips = db.getChipsInRehab().map(chip => {
            const proxy = db.getProxyForChip(chip.id);
            return {
                ...chip,
                proxy_ip: proxy ? proxy.url.replace(/.*@/, '').replace(/:.*/, '') : null,
                rehab_duration_min: chip.rehab_started_at ?
                    Math.round((Date.now() - new Date(chip.rehab_started_at).getTime()) / 60000) : null
            };
        });
        res.json(chips);
    });

    // Enter rehabilitation
    router.post('/chips/:id/rehab/enter', (req, res) => {
        const chipId = parseInt(req.params.id);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        if (chip.status !== 'warming' && chip.status !== 'connected') {
            return res.status(400).json({ error: 'Chip precisa estar conectado ou aquecendo' });
        }

        // Stop current warming if active
        warmingEngine.stopChip(chipId);

        const reason = (req.body && req.body.reason) || 'manual';
        const rehabChip = db.enterRehabilitation(chipId, reason);

        // Start rehabilitation schedule if connected
        if (sessionManager.isConnected(rehabChip.session_id)) {
            warmingEngine.startRehab(chipId);
        }

        sessionManager.emitChipUpdate(chipId);
        sessionManager.emitStats();
        res.json({ success: true, chip: rehabChip });
    });

    // Resume from rehabilitation (return to normal warming at phase 3)
    router.post('/chips/:id/rehab/resume', (req, res) => {
        const chipId = parseInt(req.params.id);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        if (chip.status !== 'rehabilitation') {
            return res.status(400).json({ error: 'Chip nao esta em reabilitacao' });
        }

        // Stop rehabilitation schedule
        warmingEngine.stopChip(chipId);

        // Exit rehabilitation - return to phase 3
        const resumed = db.exitRehabilitation(chipId, 3);

        // Restart normal warming
        if (sessionManager.isConnected(resumed.session_id)) {
            warmingEngine.startChip(chipId);
        }

        sessionManager.emitChipUpdate(chipId);
        sessionManager.emitStats();
        res.json({ success: true, chip: resumed });
    });

    // Discard chip
    router.post('/chips/:id/discard', (req, res) => {
        const chipId = parseInt(req.params.id);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        // Stop any active warming/rehab
        warmingEngine.stopChip(chipId);

        const discarded = db.markChipDiscarded(chipId);
        sessionManager.emitChipUpdate(chipId);
        sessionManager.emitStats();
        res.json({ success: true, chip: discarded });
    });

    // ==================== ADMIN INSTANCES ====================

    // List admin instances (connected)
    router.get('/admin-instances', (req, res) => {
        const admins = db.getAdminInstances().map(chip => ({
            ...chip,
            is_connected: sessionManager.isConnected(chip.session_id)
        }));
        res.json(admins);
    });

    // Set instance type (admin/warming)
    router.post('/chips/:id/set-type', (req, res) => {
        const chipId = parseInt(req.params.id);
        const { type } = req.body;
        if (!type || !['admin', 'warming'].includes(type)) {
            return res.status(400).json({ error: 'Tipo deve ser "admin" ou "warming"' });
        }
        const chip = db.setChipInstanceType(chipId, type);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        sessionManager.emitChipUpdate(chipId);
        res.json({ success: true, chip });
    });

    // Get groups where admin instance is administrator
    router.get('/admin-instances/:id/groups', async (req, res) => {
        const chipId = parseInt(req.params.id);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Instancia nao encontrada' });
        if (!sessionManager.isConnected(chip.session_id)) {
            return res.status(400).json({ error: 'Instancia nao esta conectada' });
        }
        try {
            const groups = await groupManager.getAdminGroups(chip.session_id);
            res.json(groups);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // List warming chips (for selection in group-add)
    router.get('/warming-chips', (req, res) => {
        res.json(db.getWarmingChipsForAdd());
    });

    // ==================== GROUP ADD OPERATIONS ====================

    // Start group add operation
    router.post('/group-add/start', async (req, res) => {
        if (groupManager.isRunning()) {
            return res.status(400).json({ error: 'Ja existe uma operacao em andamento' });
        }
        const { adminChipId, chipIds, manualNumbers, groups, config } = req.body;
        if (!adminChipId || !groups || groups.length === 0) {
            return res.status(400).json({ error: 'Instancia ADM e pelo menos 1 grupo sao obrigatorios' });
        }

        // Build list of phone numbers to add
        const phoneList = [];

        // From system chips
        if (chipIds && chipIds.length > 0) {
            for (const cid of chipIds) {
                const chip = db.getChipById(cid);
                if (chip && chip.phone) {
                    phoneList.push({ phone_number: chip.phone, source: 'chip', chip_id: chip.id });
                }
            }
        }

        // From manual numbers
        if (manualNumbers && manualNumbers.trim()) {
            const normalized = groupManager.normalizePhoneNumbers(manualNumbers);
            for (const num of normalized) {
                // Avoid duplicates with chip list
                if (!phoneList.find(p => p.phone_number === num)) {
                    phoneList.push({ phone_number: num, source: 'manual', chip_id: null });
                }
            }
        }

        if (phoneList.length === 0) {
            return res.status(400).json({ error: 'Nenhum numero valido para adicionar' });
        }

        // Create operation
        const operation = db.createAddOperation(adminChipId, config || {});

        // Create items (phone x group = cartesian product)
        const items = [];
        for (const group of groups) {
            for (const phone of phoneList) {
                items.push({
                    phone_number: phone.phone_number,
                    source: phone.source,
                    chip_id: phone.chip_id,
                    group_id: group.id,
                    group_name: group.subject || group.name || group.id
                });
            }
        }
        db.addOperationItems(operation.id, items);

        // Start execution in background
        groupManager.executeBulkGroupAdd(operation.id).catch(err => {
            console.error('[GroupAdd] Erro:', err);
        });

        res.json({ success: true, operationId: operation.id, totalItems: items.length });
    });

    // Pause operation
    router.post('/group-add/pause', (req, res) => {
        groupManager.pause();
        res.json({ success: true });
    });

    // Resume operation
    router.post('/group-add/resume', (req, res) => {
        groupManager.resume();
        res.json({ success: true });
    });

    // Stop operation
    router.post('/group-add/stop', (req, res) => {
        groupManager.stop();
        res.json({ success: true });
    });

    // List operations history
    router.get('/group-add/operations', (req, res) => {
        const limit = parseInt(req.query.limit) || 20;
        const ops = db.getAddOperations(limit).map(op => {
            const adminChip = db.getChipById(op.admin_chip_id);
            return { ...op, admin_name: adminChip?.name, admin_phone: adminChip?.phone };
        });
        res.json(ops);
    });

    // Get operation details
    router.get('/group-add/operations/:id', (req, res) => {
        const opId = parseInt(req.params.id);
        const op = db.getAddOperation(opId);
        if (!op) return res.status(404).json({ error: 'Operacao nao encontrada' });
        const items = db.getOperationItems(opId);
        const adminChip = db.getChipById(op.admin_chip_id);
        res.json({ ...op, items, admin_name: adminChip?.name, admin_phone: adminChip?.phone });
    });

    // Export CSV
    router.get('/group-add/operations/:id/csv', (req, res) => {
        const opId = parseInt(req.params.id);
        const op = db.getAddOperation(opId);
        if (!op) return res.status(404).json({ error: 'Operacao nao encontrada' });
        const items = db.getOperationItems(opId);

        let csv = 'Numero,Grupo,Origem,Status,Admin,Erro\n';
        for (const item of items) {
            const adminLabel = item.admin_promoted === 1 ? 'Sim' : item.admin_promoted === -1 ? 'Falhou' : 'Nao';
            csv += `${item.phone_number},"${(item.group_name || '').replace(/"/g, '""')}",${item.source},${item.status},${adminLabel},"${(item.error_message || item.admin_error || '').replace(/"/g, '""')}"\n`;
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=operacao_${opId}.csv`);
        res.send(csv);
    });

    // Retry failed items
    router.post('/group-add/retry/:id', async (req, res) => {
        if (groupManager.isRunning()) {
            return res.status(400).json({ error: 'Ja existe uma operacao em andamento' });
        }
        const opId = parseInt(req.params.id);
        const originalOp = db.getAddOperation(opId);
        if (!originalOp) return res.status(404).json({ error: 'Operacao nao encontrada' });

        const failedItems = db.getFailedItems(opId);
        if (failedItems.length === 0) {
            return res.status(400).json({ error: 'Nenhum item falhou nesta operacao' });
        }

        // Create new operation for retries
        const config = JSON.parse(originalOp.config || '{}');
        const retryOp = db.createAddOperation(originalOp.admin_chip_id, config);

        const items = failedItems.map(fi => ({
            phone_number: fi.phone_number,
            source: fi.source,
            chip_id: fi.chip_id,
            group_id: fi.group_id,
            group_name: fi.group_name
        }));
        db.addOperationItems(retryOp.id, items);

        groupManager.executeBulkGroupAdd(retryOp.id).catch(err => {
            console.error('[GroupAdd Retry] Erro:', err);
        });

        res.json({ success: true, operationId: retryOp.id, retrying: items.length });
    });

    // Validate manual numbers
    router.post('/group-add/validate-numbers', (req, res) => {
        const { numbers } = req.body;
        const normalized = groupManager.normalizePhoneNumbers(numbers || '');
        res.json({ valid: normalized, count: normalized.length });
    });

    // ==================== SETTINGS ====================

    router.get('/settings', (req, res) => {
        res.json(db.getSettings());
    });

    router.put('/settings/:key', (req, res) => {
        const { key } = req.params;
        const allowed = ['schedule', 'notifications', 'proxy_rotation'];
        if (!allowed.includes(key)) return res.status(400).json({ error: 'Chave invalida' });
        const result = db.updateSettings(key, req.body);
        res.json({ success: true, settings: result });
    });

    // ==================== DASHBOARD STATS ====================

    router.get('/dashboard/daily-stats', (req, res) => {
        const days = parseInt(req.query.days) || 7;
        res.json(db.getDailyStats(days));
    });

    router.get('/dashboard/summary', (req, res) => {
        const chips = db.getAllChips();
        const phases = { 1: 0, 2: 0, 3: 0, 4: 0 };
        let totalMsgs = 0;
        for (const c of chips) {
            if (c.phase >= 1 && c.phase <= 4) phases[c.phase]++;
            totalMsgs += c.messages_sent || 0;
        }
        const ready = chips.filter(c => c.phase >= 4 && c.status !== 'discarded').length;
        res.json({
            total: chips.length,
            connected: chips.filter(c => ['connected', 'warming'].includes(c.status)).length,
            warming: chips.filter(c => c.status === 'warming').length,
            ready,
            phases,
            totalMessages: totalMsgs,
            discarded: chips.filter(c => c.status === 'discarded').length,
            rehab: chips.filter(c => c.status === 'rehabilitation').length
        });
    });

    // ==================== MEDIA UPLOAD ====================

    router.post('/media/:type/upload', upload.array('files', 20), (req, res) => {
        const type = req.params.type;
        if (!['audios', 'images', 'stickers'].includes(type)) {
            return res.status(400).json({ error: 'Tipo invalido' });
        }
        const uploaded = (req.files || []).map(f => ({ name: f.originalname, saved: f.filename, size: f.size }));
        res.json({ success: true, uploaded, count: uploaded.length });
    });

    router.get('/media/:type', (req, res) => {
        const type = req.params.type;
        const dir = path.join(__dirname, '..', '..', 'media', type);
        if (!fs.existsSync(dir)) return res.json([]);
        const files = fs.readdirSync(dir).map(f => {
            const stat = fs.statSync(path.join(dir, f));
            return { name: f, size: stat.size, created: stat.birthtime };
        });
        res.json(files);
    });

    router.delete('/media/:type/:filename', (req, res) => {
        const { type, filename } = req.params;
        const filepath = path.join(__dirname, '..', '..', 'media', type, filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            return res.json({ success: true });
        }
        res.status(404).json({ error: 'Arquivo nao encontrado' });
    });

    // ==================== CUSTOM MESSAGES ====================

    router.get('/messages', (req, res) => {
        res.json(db.getCustomMessages());
    });

    router.put('/messages', (req, res) => {
        const { messages } = req.body;
        if (!Array.isArray(messages)) return res.status(400).json({ error: 'Formato invalido' });
        db.saveCustomMessages(messages);
        res.json({ success: true, count: messages.length });
    });

    // ==================== CHIP HISTORY/TIMELINE ====================

    router.get('/chips/:id/history', (req, res) => {
        const chipId = parseInt(req.params.id);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        const activities = db.getRecentActivity(chipId, 200);
        const timeline = [];

        // Add connection event
        if (chip.connected_at) {
            timeline.push({ type: 'connect', time: chip.connected_at, detail: 'Conectado ao WhatsApp' });
        }
        if (chip.created_at) {
            timeline.push({ type: 'create', time: chip.created_at, detail: 'Chip criado' });
        }
        if (chip.rehab_started_at) {
            timeline.push({ type: 'rehab', time: chip.rehab_started_at, detail: `Entrou em reabilitacao: ${chip.rehab_reason || ''}` });
        }

        // Group activities by hour for summary
        const hourMap = {};
        for (const a of activities) {
            const hour = (a.created_at || '').slice(0, 13);
            if (!hourMap[hour]) hourMap[hour] = { count: 0, actions: {}, errors: 0 };
            hourMap[hour].count++;
            hourMap[hour].actions[a.action_type] = (hourMap[hour].actions[a.action_type] || 0) + 1;
            if (!a.success) hourMap[hour].errors++;
        }

        for (const [hour, data] of Object.entries(hourMap)) {
            const topAction = Object.entries(data.actions).sort((a, b) => b[1] - a[1])[0];
            timeline.push({
                type: 'activity',
                time: hour + ':00:00.000Z',
                detail: `${data.count} acoes (${topAction ? topAction[0] + ': ' + topAction[1] : ''})${data.errors ? ' · ' + data.errors + ' erros' : ''}`
            });
        }

        timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

        res.json({
            chip,
            timeline: timeline.slice(0, 100),
            stats: {
                total_messages: chip.messages_sent || 0,
                phase: chip.phase,
                days_active: chip.connected_at ? Math.ceil((Date.now() - new Date(chip.connected_at).getTime()) / 86400000) : 0,
                status: chip.status
            }
        });
    });

    // ==================== TEST NOTIFICATION ====================

    router.post('/test-notification', async (req, res) => {
        const settings = db.getSettings();
        const n = settings.notifications;
        if (!n || !n.phone) return res.json({ success: false, error: 'Numero nao configurado' });
        try {
            const phone = n.phone.replace(/\D/g, '');
            const resp = await fetch('https://api.z-api.io/instances/3E9F26A4DCFB614A95626EB14D89919B/token/9CDF3623EFE3D71E8FAD8912/send-text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Client-Token': 'F7428e0211a2f428d96737ee23d06edb8S' },
                body: JSON.stringify({ phone, message: '🤖 *Aquecimento KS*\n\n✅ Teste de notificacao! Tudo funcionando.' })
            });
            res.json({ success: resp.ok });
        } catch (err) {
            res.json({ success: false, error: err.message });
        }
    });

    return router;
};
