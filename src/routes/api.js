const express = require('express');
const router = express.Router();
const db = require('../database/db');

module.exports = function(sessionManager, warmingEngine) {

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
        const chip = db.getChipById(req.params.id);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Nome obrigatorio' });
        db.updateChipName(chip.id, name);
        sessionManager.emitChipUpdate(chip.id);
        res.json({ success: true });
    });

    // Disconnect chip
    router.post('/chips/:id/disconnect', async (req, res) => {
        const chip = db.getChipById(req.params.id);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        warmingEngine.stopChip(chip.id);
        await sessionManager.disconnect(chip.session_id);
        res.json({ success: true });
    });

    // Delete chip
    router.delete('/chips/:id', async (req, res) => {
        const chip = db.getChipById(req.params.id);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });

        warmingEngine.stopChip(chip.id);
        await sessionManager.deleteSession(chip.session_id);
        res.json({ success: true });
    });

    // ==================== WARMING ====================

    // Start warming for a chip
    router.post('/chips/:id/warming/start', (req, res) => {
        const chip = db.getChipById(req.params.id);
        if (!chip) return res.status(404).json({ error: 'Chip nao encontrado' });
        if (!sessionManager.isConnected(chip.session_id)) {
            return res.status(400).json({ error: 'Chip nao esta conectado' });
        }

        warmingEngine.startChip(chip.id);
        res.json({ success: true, message: `Aquecimento iniciado para ${chip.phone || chip.session_id}` });
    });

    // Stop warming for a chip
    router.post('/chips/:id/warming/stop', (req, res) => {
        const chip = db.getChipById(req.params.id);
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

    return router;
};
