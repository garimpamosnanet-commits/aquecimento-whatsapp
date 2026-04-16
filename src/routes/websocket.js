module.exports = function(io, sessionManager, warmingEngine, groupManager, adminManager) {

    // Track online users
    const onlineUsers = new Map(); // socketId -> { name, connectedAt }

    function broadcastOnlineUsers() {
        const users = [];
        for (const [sid, u] of onlineUsers) {
            if (!users.find(x => x.name === u.name)) users.push({ name: u.name, since: u.connectedAt });
        }
        io.emit('online_users', users);
    }

    function broadcastUserAction(userName, action, details) {
        io.emit('user_action', { user: userName, action, details, timestamp: new Date().toISOString() });
    }

    io.on('connection', (socket) => {
        const userName = socket.userName || 'Desconhecido';
        console.log(`[WebSocket] ${userName} conectado`);
        const db = require('../database/db');

        // Track online user
        onlineUsers.set(socket.id, { name: userName, connectedAt: new Date().toISOString() });
        broadcastOnlineUsers();
        broadcastUserAction(userName, 'login', 'Entrou na plataforma');

        socket.on('disconnect', () => {
            onlineUsers.delete(socket.id);
            broadcastOnlineUsers();
            console.log(`[WebSocket] ${userName} desconectou`);
        });

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
                console.log(`[WS] request_qr recebido (nome: ${name || 'vazio'})`);
                broadcastUserAction(userName, 'connect_chip', `Conectando chip "${name || 'novo'}"`);
                await sessionManager.createSession(name || '');
            } catch (err) {
                console.log(`[WS] request_qr ERRO: ${err.message}`);
                socket.emit('error', { message: err.message });
                socket.emit('qr_error', { error: err.message });
            }
        });

        // Reconnect a chip (reload QR)
        socket.on('reconnect_chip', async (data) => {
            const { sessionId } = data;
            console.log(`[WS] reconnect_chip: ${sessionId}`);
            try {
                const chip = db.getChipBySession(sessionId);
                if (!chip) {
                    socket.emit('error', { message: 'Sessao expirada. Clique novamente para criar nova.' });
                    return;
                }
                await sessionManager.connect(sessionId);
            } catch (err) {
                console.log(`[WS] reconnect_chip ERRO: ${err.message}`);
                socket.emit('error', { message: err.message });
                socket.emit('qr_error', { sessionId, error: err.message });
            }
        });

        // Request pairing code (connect via phone number)
        socket.on('request_pairing', async (data) => {
            const { sessionId, phone } = data;
            console.log(`[WS] request_pairing: ${sessionId}, phone: ${phone}`);
            try {
                await sessionManager.connectWithPhone(sessionId, phone);
            } catch (err) {
                console.log(`[WS] request_pairing ERRO: ${err.message}`);
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

        // Pause group add (optional operationId)
        socket.on('pause_group_add', (data) => {
            const opId = data?.operationId ? parseInt(data.operationId) : null;
            if (groupManager) groupManager.pause(opId);
        });

        // Resume group add (optional operationId)
        socket.on('resume_group_add', (data) => {
            const opId = data?.operationId ? parseInt(data.operationId) : null;
            if (groupManager) groupManager.resume(opId);
        });

        // Stop group add (optional operationId)
        socket.on('stop_group_add', (data) => {
            const opId = data?.operationId ? parseInt(data.operationId) : null;
            if (groupManager) groupManager.stop(opId);
        });

        // Resume paused_daily or stopped operation
        socket.on('resume_group_add_operation', async (data) => {
            const { operationId } = data;
            const op = db.getAddOperation(operationId);
            if (op && groupManager.isRunning(op.admin_chip_id)) {
                socket.emit('group_add_status', { operationId, status: 'error', message: 'Este ADM ja esta executando outra operacao' });
                return;
            }
            groupManager.resumeOperation(operationId).catch(err => {
                socket.emit('group_add_status', { operationId, status: 'failed', message: err.message });
            });
        });

        // ==================== ADMIN MANAGE ====================

        socket.on('pause_admin_manage', () => {
            if (adminManager) adminManager.pause();
        });

        socket.on('resume_admin_manage', () => {
            if (adminManager) adminManager.resume();
        });

        socket.on('stop_admin_manage', () => {
            if (adminManager) adminManager.stop();
        });

        socket.on('disconnect', () => {
            console.log('[WebSocket] Cliente desconectado');
        });
    });
};
