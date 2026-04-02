module.exports = function(io, sessionManager, warmingEngine, groupManager) {

    io.on('connection', (socket) => {
        console.log('[WebSocket] Cliente conectado');
        const db = require('../database/db');

        // Send initial data (with proxy info)
        socket.emit('stats', db.getChipStats());
        const chipsWithProxy = db.getAllChips().map(chip => {
            const proxy = db.getProxyForChip(chip.id);
            return { ...chip, proxy_ip: proxy ? proxy.url.replace(/.*@/, '').replace(/:.*/, '') : null };
        });
        socket.emit('chips_list', chipsWithProxy);
        socket.emit('folders_list', db.getAllFolders());

        // Request new QR code connection
        socket.on('request_qr', async (data) => {
            try {
                const { name } = data || {};
                await sessionManager.createSession(name || '');
            } catch (err) {
                socket.emit('error', { message: err.message });
            }
        });

        // Reconnect a chip
        socket.on('reconnect_chip', async (data) => {
            const { sessionId } = data;
            try {
                await sessionManager.connect(sessionId);
            } catch (err) {
                socket.emit('error', { message: err.message });
            }
        });

        // Start warming single chip
        socket.on('start_warming', (data) => {
            const { chipId } = data;
            const chip = db.getChipById(chipId);
            if (chip && sessionManager.isConnected(chip.session_id)) {
                warmingEngine.startChip(chipId);
            }
        });

        // Stop warming single chip
        socket.on('stop_warming', (data) => {
            const { chipId } = data;
            warmingEngine.stopChip(chipId);
        });

        // Start all
        socket.on('start_all', () => {
            const chips = db.getAllChips();
            for (const chip of chips) {
                if (sessionManager.isConnected(chip.session_id) && chip.status !== 'warming') {
                    warmingEngine.startChip(chip.id);
                }
            }
        });

        // Stop all
        socket.on('stop_all', () => {
            const chips = db.getAllChips();
            for (const chip of chips) {
                if (chip.status === 'warming') {
                    warmingEngine.stopChip(chip.id);
                }
            }
        });

        // Disconnect chip
        socket.on('disconnect_chip', async (data) => {
            const { chipId } = data;
            const chip = db.getChipById(chipId);
            if (chip) {
                warmingEngine.stopChip(chipId);
                await sessionManager.disconnect(chip.session_id);
            }
        });

        // Delete chip
        socket.on('delete_chip', async (data) => {
            const { chipId } = data;
            const chip = db.getChipById(chipId);
            if (chip) {
                warmingEngine.stopChip(chipId);
                await sessionManager.deleteSession(chip.session_id);
                io.emit('chip_deleted', { chipId });
            }
        });

        // Delete chip by session (used when reloading QR)
        socket.on('delete_chip_by_session', async (data) => {
            const { sessionId } = data;
            if (sessionId) {
                const chip = db.getChipBySession(sessionId);
                if (chip) {
                    warmingEngine.stopChip(chip.id);
                    await sessionManager.deleteSession(sessionId);
                    io.emit('chip_deleted', { chipId: chip.id });
                }
            }
        });

        // Enter rehabilitation
        socket.on('enter_rehab', (data) => {
            const { chipId, reason } = data;
            const chip = db.getChipById(chipId);
            if (chip && (chip.status === 'warming' || chip.status === 'connected')) {
                warmingEngine.stopChip(chipId);
                db.enterRehabilitation(chipId, reason || 'manual');
                if (sessionManager.isConnected(chip.session_id)) {
                    warmingEngine.startRehab(chipId);
                }
                sessionManager.emitChipUpdate(chipId);
                io.emit('stats', db.getChipStats());
            }
        });

        // Exit rehabilitation (resume warming)
        socket.on('exit_rehab', (data) => {
            const { chipId } = data;
            const chip = db.getChipById(chipId);
            if (chip && chip.status === 'rehabilitation') {
                warmingEngine.stopChip(chipId);
                db.exitRehabilitation(chipId, 3);
                if (sessionManager.isConnected(chip.session_id)) {
                    warmingEngine.startChip(chipId);
                }
                sessionManager.emitChipUpdate(chipId);
                io.emit('stats', db.getChipStats());
            }
        });

        // Discard chip
        socket.on('discard_chip', (data) => {
            const { chipId } = data;
            const chip = db.getChipById(chipId);
            if (chip) {
                warmingEngine.stopChip(chipId);
                db.markChipDiscarded(chipId);
                sessionManager.emitChipUpdate(chipId);
                io.emit('stats', db.getChipStats());
            }
        });

        // ==================== GROUP ADD ====================

        // Fetch admin groups
        socket.on('fetch_admin_groups', async (data) => {
            const { chipId } = data;
            try {
                const chip = db.getChipById(chipId);
                if (!chip || !sessionManager.isConnected(chip.session_id)) {
                    socket.emit('admin_groups_list', { error: 'Instancia nao conectada', groups: [] });
                    return;
                }
                const groups = await groupManager.getAdminGroups(chip.session_id);
                socket.emit('admin_groups_list', { groups });
            } catch (err) {
                socket.emit('admin_groups_list', { error: err.message, groups: [] });
            }
        });

        // Start group add
        socket.on('start_group_add', async (data) => {
            // This is handled via REST API (/api/group-add/start)
            // But provide WebSocket fallback
            socket.emit('group_add_status', { status: 'info', message: 'Use o botao na interface para iniciar' });
        });

        // Pause group add
        socket.on('pause_group_add', () => {
            if (groupManager) groupManager.pause();
        });

        // Resume group add
        socket.on('resume_group_add', () => {
            if (groupManager) groupManager.resume();
        });

        // Stop group add
        socket.on('stop_group_add', () => {
            if (groupManager) groupManager.stop();
        });

        socket.on('disconnect', () => {
            console.log('[WebSocket] Cliente desconectado');
        });
    });
};
