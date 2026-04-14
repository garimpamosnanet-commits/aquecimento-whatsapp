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

module.exports = function(sessionManager, warmingEngine, groupManager, adminManager) {

    // ==================== DEBUG ====================
    router.get('/debug/logs', (req, res) => {
        const logs = sessionManager.getDebugLogs();
        res.json({ count: logs.length, logs });
    });

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

    // Update connected_at date
    router.put('/chips/:id/connected_at', (req, res) => {
        const chip = db.getChipById(parseInt(req.params.id));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        const { connected_at } = req.body;
        if (!connected_at) return res.status(400).json({ error: 'connected_at obrigatorio' });
        const data = db._loadDb();
        const c = data.chips.find(x => x.id === chip.id);
        if (c) { c.connected_at = connected_at; db._saveDb(data); }
        sessionManager.emitChipUpdate(chip.id);
        res.json({ success: true });
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

    // Assign proxy to a specific chip (without reconnecting)
    router.post('/proxies/assign/:chipId', (req, res) => {
        const chipId = parseInt(req.params.chipId);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        const existing = db.getProxyForChip(chipId);
        if (existing) return res.json({ success: true, message: 'Chip ja tem proxy', proxy: existing });
        const proxy = db.assignProxyToChip(chipId);
        if (!proxy) return res.status(400).json({ error: 'Sem proxy disponivel' });
        res.json({ success: true, proxy });
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

    // Debug: show raw participant attrs from last getGroupAdmins call
    router.get('/debug/raw-attrs', (req, res) => {
        res.json(adminManager.getLastDebugAttrs() || { message: 'No data yet. Click a group in Gerenciar Admins first.' });
    });

    // Debug: raw group data to diagnose group fetching issues
    router.get('/debug/raw-groups/:chipId', async (req, res) => {
        const chipId = parseInt(req.params.chipId);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        const sock = sessionManager.getSocket(chip.session_id);
        if (!sock || !sock.user) return res.status(400).json({ error: 'Socket nao conectado' });
        try {
            const groups = await sock.groupFetchAllParticipating();
            const totalGroups = Object.keys(groups).length;
            const myPhone = sock.user.id?.split('@')[0]?.split(':')[0];
            const myLid = sock.user.lid?.split('@')[0]?.split(':')[0];

            // Deep inspect: check all group metadata fields
            const sample = Object.entries(groups).slice(0, 5).map(([gid, g]) => {
                // Check all possible ways to identify "me" in the group
                const allAdmins = g.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin');
                return {
                    id: gid,
                    subject: g.subject,
                    participantCount: g.participants.length,
                    admins: allAdmins.map(p => ({ id: p.id, admin: p.admin })),
                    groupKeys: Object.keys(g).filter(k => k !== 'participants'),
                    me: g.me || null,
                    owner: g.owner || null
                };
            });
            res.json({ totalGroups, myPhone, myLid, userJid: sock.user.id, userLid: sock.user.lid, sample });
        } catch (err) {
            res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0, 3) });
        }
    });

    // ==================== GROUP INVITE LINKS ====================

    // Get single invite link (tries cache first, then fetches)
    router.get('/admin-manage/invite-link/:chipId/:groupId', async (req, res) => {
        try {
            // Try cache first
            const cached = db.getGroupInviteLinks();
            const groupId = req.params.groupId;
            if (cached[groupId] && cached[groupId].link) {
                return res.json({ link: cached[groupId].link, cached: true });
            }
            // Fetch live
            const chip = db.getChipById(parseInt(req.params.chipId));
            if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
            const link = await adminManager.getGroupInviteLink(chip.session_id, groupId);
            res.json({ link, cached: false });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get all cached invite links
    router.get('/admin-manage/invite-links-cache', (req, res) => {
        res.json(db.getGroupInviteLinks());
    });

    // Trigger background fetch of all invite links
    router.post('/admin-manage/fetch-all-invite-links', async (req, res) => {
        const { chipId, groups } = req.body;
        if (!chipId || !groups) return res.status(400).json({ error: 'chipId and groups required' });
        const chip = db.getChipById(parseInt(chipId));
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        // Fire and forget — runs in background
        adminManager.fetchAllInviteLinks(chip.session_id, groups).catch(err => {
            console.error('[API] Error fetching invite links:', err.message);
        });

        res.json({ ok: true, message: 'Buscando links em background...' });
    });

    // ==================== GROUP DONE MARKS ====================

    router.get('/group-done-marks', (req, res) => {
        res.json(db.getGroupDoneMarks());
    });

    router.post('/group-done-marks', (req, res) => {
        const { groupId, done } = req.body;
        if (!groupId) return res.status(400).json({ error: 'groupId required' });
        const marks = db.setGroupDoneMark(groupId, !!done, req.userName || 'unknown');
        res.json(marks);
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
                const chip = phone.chip_id ? db.getChipById(phone.chip_id) : null;
                items.push({
                    phone_number: phone.phone_number,
                    source: phone.source,
                    chip_id: phone.chip_id,
                    chip_session_id: chip?.session_id || null,
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

    // Force reset stuck operation
    router.post('/group-add/force-reset', (req, res) => {
        groupManager.forceReset();
        res.json({ success: true, message: 'Operacao resetada' });
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

    // Get safety presets
    router.get('/group-add/presets', (req, res) => {
        const GroupManager = require('../whatsapp/group-manager');
        res.json(GroupManager.PRESETS);
    });

    // Resume paused_daily or stopped operation
    router.post('/group-add/resume-operation/:id', async (req, res) => {
        if (groupManager.isRunning()) {
            return res.status(400).json({ error: 'Ja existe uma operacao em andamento' });
        }
        const opId = parseInt(req.params.id);
        const op = db.getAddOperation(opId);
        if (!op) return res.status(404).json({ error: 'Operacao nao encontrada' });
        if (op.status !== 'paused_daily' && op.status !== 'stopped') {
            return res.status(400).json({ error: `Operacao com status "${op.status}" nao pode ser retomada` });
        }
        const pending = db.getPendingItems(opId);
        if (pending.length === 0) {
            return res.status(400).json({ error: 'Nenhum item pendente nesta operacao' });
        }

        groupManager.resumeOperation(opId).catch(err => {
            console.error('[GroupAdd Resume] Erro:', err);
        });

        res.json({ success: true, operationId: opId, pendingItems: pending.length });
    });

    // Get daily counts for today
    router.get('/group-add/daily-counts', (req, res) => {
        const today = new Date().toISOString().split('T')[0];
        res.json(db.getAllDailyCounts(today));
    });

    // ==================== CLIENT TAGS ====================

    router.put('/chips/:id/client-tag', (req, res) => {
        const chipId = parseInt(req.params.id);
        const { clientTag } = req.body;
        const chip = db.setChipClientTag(chipId, clientTag || null);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        res.json({ success: true, chip });
    });

    // Bulk set client tag (multiple chips at once)
    router.put('/chips/bulk-client-tag', (req, res) => {
        const { chipIds, clientTag } = req.body;
        if (!chipIds || !Array.isArray(chipIds)) return res.status(400).json({ error: 'chipIds obrigatorio' });
        const updated = [];
        for (const id of chipIds) {
            const chip = db.setChipClientTag(id, clientTag || null);
            if (chip) updated.push(chip);
        }
        res.json({ success: true, updated: updated.length });
    });

    // List all unique client tags
    router.get('/client-tags', (req, res) => {
        res.json(db.getAllClientTags());
    });

    // Get chips filtered by client tag
    router.get('/chips-by-tag/:tag', (req, res) => {
        res.json(db.getChipsByClientTag(req.params.tag));
    });

    // Get group-add history per group (which groups already had chips added)
    router.get('/group-add/group-history', (req, res) => {
        const ops = db.getAddOperations(100);
        const groupStats = {}; // groupId -> { count, lastDate, successCount }

        for (const op of ops) {
            if (op.status !== 'completed' && op.status !== 'paused_daily' && op.status !== 'stopped') continue;
            const items = db.getOperationItems(op.id);
            for (const item of items) {
                if (item.status === 'success' || item.status === 'skipped') {
                    if (!groupStats[item.group_id]) {
                        groupStats[item.group_id] = { count: 0, successCount: 0, groupName: item.group_name, lastDate: null };
                    }
                    groupStats[item.group_id].count++;
                    if (item.status === 'success') groupStats[item.group_id].successCount++;
                    const d = item.processed_at || op.completed_at;
                    if (d && (!groupStats[item.group_id].lastDate || d > groupStats[item.group_id].lastDate)) {
                        groupStats[item.group_id].lastDate = d;
                    }
                }
            }
        }
        res.json(groupStats);
    });

    // Cleanup: merge orphaned external_warmed chips with connected chips
    router.post('/chips/cleanup-orphans', (req, res) => {
        // Brazilian phone matching (with/without 9th digit)
        function phonesMatch(a, b) {
            if (!a || !b) return false;
            if (a === b) return true;
            const strip = (p) => p.startsWith('55') && p.length >= 12 ? p.slice(2) : p;
            const na = strip(a), nb = strip(b);
            if (na === nb) return true;
            if (na.length === 11 && nb.length === 10) return na.slice(0, 2) + na.slice(3) === nb.slice(0, 2) + nb.slice(2);
            if (nb.length === 11 && na.length === 10) return nb.slice(0, 2) + nb.slice(3) === na.slice(0, 2) + na.slice(2);
            return false;
        }

        const allChips = db.getAllChips();
        const extChips = allChips.filter(c => c.origin === 'external_warmed' && (c.status === 'disconnected' || c.session_id?.startsWith('ext_')));
        let cleaned = 0;

        for (const ext of extChips) {
            if (!ext.phone) continue;
            // Find a connected chip with the same phone (handles BR 9th digit)
            const connected = allChips.find(c => c.id !== ext.id && phonesMatch(c.phone, ext.phone) && (c.status === 'connected' || c.status === 'warming'));
            if (connected) {
                // Transfer metadata to connected chip
                if (ext.client_tag && !connected.client_tag) db.setChipClientTag(connected.id, ext.client_tag);
                if (ext.fornecedor && !connected.fornecedor) db.updateChipField(connected.id, 'fornecedor', ext.fornecedor);
                if (ext.folder_id && !connected.folder_id) db.assignChipToFolder(connected.id, ext.folder_id);
                if (!connected.origin) db.updateChipField(connected.id, 'origin', 'external_warmed');
                // Fix name
                const last4 = ext.phone.slice(-4);
                const label = ext.client_tag || (ext.folder_id ? (db.getAllFolders().find(f => f.id === ext.folder_id)?.name || '') : '');
                if (label && (!connected.name || connected.name.startsWith('Chip '))) {
                    db.updateChipName(connected.id, `${label} - ${last4}`);
                }
                // Delete orphan
                db.deleteChip(ext.id);
                cleaned++;
            }
        }
        sessionManager.emitStats();
        res.json({ success: true, cleaned, remaining: db.getAllChips().filter(c => c.origin === 'external_warmed').length });
    });

    // SCAN: Cross-reference chips vs groups (which chips are in which groups)
    router.post('/chips/scan-groups', async (req, res) => {
        const { chipIds, adminChipId } = req.body;
        if (!chipIds || !Array.isArray(chipIds) || chipIds.length === 0) {
            return res.status(400).json({ error: 'chipIds obrigatorio' });
        }
        if (!adminChipId) {
            return res.status(400).json({ error: 'adminChipId obrigatorio' });
        }

        const adminChip = db.getChipById(adminChipId);
        if (!adminChip || !sessionManager.isConnected(adminChip.session_id)) {
            return res.status(400).json({ error: 'ADM nao conectado' });
        }

        try {
            // 1. Get all groups from ADM
            const admSock = sessionManager.getSocket(adminChip.session_id);
            const allGroups = await admSock.groupFetchAllParticipating();
            const groups = [];
            for (const [gid, g] of Object.entries(allGroups)) {
                if (g.isCommunity) continue;
                groups.push({
                    id: gid,
                    subject: g.subject || 'Sem nome',
                    size: g.participants?.length || 0,
                    participants: (g.participants || []).map(p => ({
                        phone: p.id.split(':')[0].split('@')[0],
                        admin: p.admin === 'admin' || p.admin === 'superadmin'
                    }))
                });
            }

            // 2. For each chip, check which groups they're in
            const results = [];
            for (const chipId of chipIds) {
                const chip = db.getChipById(chipId);
                if (!chip || !chip.phone) continue;

                const chipPhone = chip.phone;
                // Brazilian phone matching: strip 55, handle 9th digit
                const normalize = (p) => {
                    let n = p.startsWith('55') && p.length >= 12 ? p.slice(2) : p;
                    if (n.length === 11 && n[2] === '9') n = n.slice(0, 2) + n.slice(3);
                    return n;
                };
                const chipNorm = normalize(chipPhone);

                const chipGroups = [];
                const missingGroups = [];

                for (const g of groups) {
                    const found = g.participants.find(p => {
                        const pNorm = normalize(p.phone);
                        return pNorm === chipNorm;
                    });

                    if (found) {
                        chipGroups.push({
                            groupId: g.id,
                            subject: g.subject,
                            isAdmin: found.admin,
                            status: found.admin ? 'admin' : 'member'
                        });
                    } else {
                        missingGroups.push({
                            groupId: g.id,
                            subject: g.subject,
                            size: g.size
                        });
                    }
                }

                results.push({
                    chipId: chip.id,
                    phone: chipPhone,
                    name: chip.name || chipPhone,
                    inGroups: chipGroups.length,
                    asAdmin: chipGroups.filter(g => g.isAdmin).length,
                    asMember: chipGroups.filter(g => !g.isAdmin).length,
                    missing: missingGroups.length,
                    totalGroups: groups.length,
                    groups: chipGroups,
                    missingGroups
                });
            }

            // 3. Summary
            const groupNames = groups.map(g => ({ id: g.id, subject: g.subject, size: g.size }));

            res.json({
                success: true,
                totalGroups: groups.length,
                totalChips: results.length,
                chips: results,
                groups: groupNames
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Get groups a chip is member of
    router.get('/chips/:id/groups', async (req, res) => {
        const chipId = parseInt(req.params.id);
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        if (!chip.session_id || !sessionManager.isConnected(chip.session_id)) {
            return res.status(400).json({ error: 'Chip nao conectado' });
        }

        try {
            const sock = sessionManager.getSocket(chip.session_id);
            if (!sock || !sock.user) return res.status(400).json({ error: 'Socket nao disponivel' });

            const groups = await sock.groupFetchAllParticipating();
            const result = [];
            for (const [groupId, group] of Object.entries(groups)) {
                if (group.isCommunity) continue;
                // Check if this chip is admin in the group
                const me = sock.user.id.split(':')[0];
                const myParticipant = (group.participants || []).find(p => p.id.split(':')[0] === me || p.id.split('@')[0] === me);
                const isAdmin = myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin';
                result.push({
                    id: groupId,
                    subject: group.subject || 'Sem nome',
                    size: group.participants?.length || 0,
                    isAdmin
                });
            }
            res.json({ phone: chip.phone, groups: result.sort((a, b) => a.subject.localeCompare(b.subject)), total: result.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ==================== CADASTRO CHIPS AQUECIDOS ====================

    router.post('/chips/register-warmed', (req, res) => {
        const { numbers, clientTag, fornecedor } = req.body;
        if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
            return res.status(400).json({ error: 'Nenhum numero fornecido' });
        }

        // Auto-create folder for client if it doesn't exist
        let folderId = null;
        if (clientTag) {
            const folders = db.getAllFolders();
            const existing = folders.find(f => f.name.toLowerCase() === clientTag.toLowerCase());
            if (existing) {
                folderId = existing.id;
            } else {
                const newFolder = db.createFolder(clientTag);
                folderId = newFolder.id;
                console.log(`[Register] Pasta criada automaticamente: "${clientTag}" (id: ${folderId})`);
            }
        }

        const registered = [];
        for (const phone of numbers) {
            // Check if phone already exists
            const existingChip = db.getAllChips().find(c => c.phone === phone);
            if (existingChip) {
                // Just update tags if already exists
                if (clientTag) db.setChipClientTag(existingChip.id, clientTag);
                if (fornecedor) db.updateChipField(existingChip.id, 'fornecedor', fornecedor);
                db.updateChipField(existingChip.id, 'origin', 'external_warmed');
                if (folderId) db.assignChipToFolder(existingChip.id, folderId);
                registered.push({ phone, status: 'updated', chipId: existingChip.id });
                continue;
            }

            // Create new chip entry (no session, disconnected)
            const sessionId = `ext_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
            const last4 = phone.slice(-4);
            // Name from folder (pasta) name, fallback to clientTag
            let label = clientTag || '';
            if (folderId) {
                const folder = db.getAllFolders().find(f => f.id === folderId);
                if (folder) label = folder.name;
            }
            const chipName = label ? `${label} - ${last4}` : last4;
            const chip = db.createChip(sessionId, chipName);
            db.updateChipPhone(chip.id, phone);
            db.updateChipField(chip.id, 'origin', 'external_warmed');
            db.updateChipField(chip.id, 'phase', 4); // Already warmed
            if (clientTag) db.setChipClientTag(chip.id, clientTag);
            if (fornecedor) db.updateChipField(chip.id, 'fornecedor', fornecedor);
            if (folderId) db.assignChipToFolder(chip.id, folderId);
            registered.push({ phone, status: 'created', chipId: chip.id });
        }

        sessionManager.emitStats();
        res.json({ success: true, registered, total: registered.length, folderId, folderName: clientTag });
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
        try {
            const files = fs.readdirSync(dir).map(f => {
                try {
                    const stat = fs.statSync(path.join(dir, f));
                    return { name: f, size: stat.size, created: stat.birthtime };
                } catch (e) {
                    return { name: f, size: 0, created: null };
                }
            });
            res.json(files);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    router.delete('/media/:type/:filename', (req, res) => {
        const { type, filename } = req.params;
        const filepath = path.join(__dirname, '..', '..', 'media', type, filename);
        try {
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
                return res.json({ success: true });
            }
            res.status(404).json({ error: 'Arquivo nao encontrado' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
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
        try {
            const ZAPI_BASE = 'https://api.z-api.io/instances/3E9F26A4DCFB614A95626EB14D89919B/token/9CDF3623EFE3D71E8FAD8912';
            const GROUP_ID = '120363429056734446-group';
            const msg = '🤖 *Aquecimento KS*\n\n✅ Teste de notificacao! Tudo funcionando.\n\nVoce recebera alertas aqui quando:\n• ⚠️ Chip desconectar\n• 🚨 Chip for banido\n• 📈 Chip mudar de fase\n• ✅ Chip ficar pronto\n• ❌ Erros criticos';
            const resp = await fetch(`${ZAPI_BASE}/send-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Client-Token': 'F7428e0211a2f428d96737ee23d06edb8S' },
                body: JSON.stringify({ phone: GROUP_ID, message: msg })
            });
            res.json({ success: resp.ok });
        } catch (err) {
            res.json({ success: false, error: err.message });
        }
    });

    // ==================== ADMIN MANAGE (GERENCIAR ADMINS) ====================

    // Get admins of a specific group
    router.get('/admin-manage/group-admins/:chipId/:groupId', async (req, res) => {
        const chipId = parseInt(req.params.chipId);
        const groupId = req.params.groupId;
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Instancia nao encontrada' });
        if (!sessionManager.isConnected(chip.session_id)) {
            return res.status(400).json({ error: 'Instancia nao esta conectada' });
        }
        try {
            const admins = await adminManager.getGroupAdmins(chip.session_id, groupId);
            res.json(admins);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get members (non-admins) of a specific group
    router.get('/admin-manage/group-members/:chipId/:groupId', async (req, res) => {
        const chipId = parseInt(req.params.chipId);
        const groupId = req.params.groupId;
        const chip = db.getChipById(chipId);
        if (!chip) return res.status(404).json({ error: 'Instancia nao encontrada' });
        if (!sessionManager.isConnected(chip.session_id)) {
            return res.status(400).json({ error: 'Instancia nao esta conectada' });
        }
        try {
            const members = await adminManager.getGroupMembers(chip.session_id, groupId);
            res.json(members);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Add member to group
    router.post('/admin-manage/add-member', async (req, res) => {
        const { chipId, groupId, number } = req.body;
        if (!chipId || !groupId || !number) return res.status(400).json({ error: 'chipId, groupId and number required' });
        const chip = db.getChipById(parseInt(chipId));
        if (!chip) return res.status(404).json({ error: 'Instancia nao encontrada' });
        try {
            const jid = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            const result = await adminManager.addToGroup(chip.session_id, groupId, jid);
            res.json({ ...result, jid });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Promote member to admin
    router.post('/admin-manage/promote', async (req, res) => {
        const { chipId, groupId, jid } = req.body;
        if (!chipId || !groupId || !jid) return res.status(400).json({ error: 'chipId, groupId and jid required' });
        const chip = db.getChipById(parseInt(chipId));
        if (!chip) return res.status(404).json({ error: 'Instancia nao encontrada' });
        try {
            const result = await adminManager.promoteToAdmin(chip.session_id, groupId, jid);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Start admin manage operation
    router.post('/admin-manage/start', async (req, res) => {
        if (adminManager.isRunning()) {
            return res.status(400).json({ error: 'Ja existe uma operacao em andamento' });
        }
        const { adminChipId, items, config } = req.body;
        if (!adminChipId || !items || items.length === 0) {
            return res.status(400).json({ error: 'Instancia ADM e pelo menos 1 admin sao obrigatorios' });
        }

        const operation = db.createAdminManageOperation(adminChipId, config || {});
        db.addAdminManageItems(operation.id, items);

        adminManager.executeAdminManage(operation.id).catch(err => {
            console.error('[AdminManage] Erro:', err);
        });

        res.json({ success: true, operationId: operation.id, totalItems: items.length });
    });

    // Pause
    router.post('/admin-manage/pause', (req, res) => {
        adminManager.pause();
        res.json({ success: true });
    });

    // Resume
    router.post('/admin-manage/resume', (req, res) => {
        adminManager.resume();
        res.json({ success: true });
    });

    // Stop
    router.post('/admin-manage/stop', (req, res) => {
        adminManager.stop();
        res.json({ success: true });
    });

    // Force reset stuck operation
    router.post('/admin-manage/force-reset', (req, res) => {
        adminManager.forceReset();
        res.json({ success: true, message: 'Operacao resetada' });
    });

    // Operations history
    router.get('/admin-manage/operations', (req, res) => {
        const limit = parseInt(req.query.limit) || 20;
        const ops = db.getAdminManageOperations(limit).map(op => {
            const adminChip = db.getChipById(op.admin_chip_id);
            return { ...op, admin_name: adminChip?.name, admin_phone: adminChip?.phone };
        });
        res.json(ops);
    });

    // Operation details
    router.get('/admin-manage/operations/:id', (req, res) => {
        const opId = parseInt(req.params.id);
        const op = db.getAdminManageOperation(opId);
        if (!op) return res.status(404).json({ error: 'Operacao nao encontrada' });
        const items = db.getAdminManageItems(opId);
        const adminChip = db.getChipById(op.admin_chip_id);
        res.json({ ...op, items, admin_name: adminChip?.name, admin_phone: adminChip?.phone });
    });

    // Export CSV
    router.get('/admin-manage/operations/:id/csv', (req, res) => {
        const opId = parseInt(req.params.id);
        const op = db.getAdminManageOperation(opId);
        if (!op) return res.status(404).json({ error: 'Operacao nao encontrada' });
        const items = db.getAdminManageItems(opId);
        const config = JSON.parse(op.config || '{}');

        let csv = 'Numero,Grupo,Rebaixar,Remover,Status,Erro\n';
        for (const item of items) {
            const demoteLabel = item.demote_status === 'success' ? 'OK' : item.demote_status === 'failed' ? 'Falhou' : 'N/A';
            const removeLabel = config.mode === 'demote_remove' ? (item.remove_status === 'success' ? 'OK' : item.remove_status === 'failed' ? 'Falhou' : 'N/A') : 'N/A';
            csv += `${item.phone},"${(item.group_name || '').replace(/"/g, '""')}",${demoteLabel},${removeLabel},${item.status},"${(item.error_message || '').replace(/"/g, '""')}"\n`;
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=admin_manage_${opId}.csv`);
        res.send(csv);
    });

    // Retry failed items
    router.post('/admin-manage/retry/:id', async (req, res) => {
        if (adminManager.isRunning()) {
            return res.status(400).json({ error: 'Ja existe uma operacao em andamento' });
        }
        const opId = parseInt(req.params.id);
        const originalOp = db.getAdminManageOperation(opId);
        if (!originalOp) return res.status(404).json({ error: 'Operacao nao encontrada' });

        const failedItems = db.getFailedAdminManageItems(opId);
        if (failedItems.length === 0) {
            return res.status(400).json({ error: 'Nenhum item falhou nesta operacao' });
        }

        const config = JSON.parse(originalOp.config || '{}');
        const retryOp = db.createAdminManageOperation(originalOp.admin_chip_id, config);

        const items = failedItems.map(fi => ({
            jid: fi.jid, phone: fi.phone,
            group_id: fi.group_id, group_name: fi.group_name,
            is_me: fi.is_me, is_super: fi.is_super
        }));
        db.addAdminManageItems(retryOp.id, items);

        adminManager.executeAdminManage(retryOp.id).catch(err => {
            console.error('[AdminManage Retry] Erro:', err);
        });

        res.json({ success: true, operationId: retryOp.id, retrying: items.length });
    });

    return router;
};
