// ==================== GROUP MANAGER — ADICIONAR CHIPS AOS GRUPOS ====================
// Motor de adicao em massa de chips aos grupos do cliente.
// Suporta dois modos:
//   - invite_link (RECOMENDADO): cada chip entra sozinho via link de convite
//   - admin_add (legado): admin adiciona os chips via groupParticipantsUpdate
// 100% aditivo — zero impacto no warming-engine e session-manager.

const db = require('../database/db');

// ==================== SAFETY PRESETS ====================

const PRESETS = {
    rapido: {
        label: 'Rapido',
        description: 'Para testes e grupos proprios. Delays curtos.',
        delayMin: 10, delayMax: 30,
        groupDelayMin: 60, groupDelayMax: 120,
        promoteDelayMin: 5, promoteDelayMax: 15,
        dailyLimitPerChip: 0, // sem limite
        color: '#ef4444'
    },
    normal: {
        label: 'Normal',
        description: 'Equilibrio entre velocidade e seguranca.',
        delayMin: 30, delayMax: 90,
        groupDelayMin: 120, groupDelayMax: 300,
        promoteDelayMin: 30, promoteDelayMax: 120,
        dailyLimitPerChip: 10,
        color: '#f59e0b'
    },
    seguro: {
        label: 'Seguro',
        description: 'Recomendado para chips novos. Delays longos.',
        delayMin: 60, delayMax: 180,
        groupDelayMin: 300, groupDelayMax: 600,
        promoteDelayMin: 120, promoteDelayMax: 600,
        dailyLimitPerChip: 5,
        color: '#22c55e'
    },
    ultra_seguro: {
        label: 'Ultra Seguro',
        description: 'Maximo cuidado. Operacao distribuida em varios dias.',
        delayMin: 180, delayMax: 600,
        groupDelayMin: 600, groupDelayMax: 1200,
        promoteDelayMin: 300, promoteDelayMax: 900,
        dailyLimitPerChip: 3,
        color: '#3b82f6'
    }
};

class GroupManager {
    constructor(sessionManager, io) {
        this.sessionManager = sessionManager;
        this.io = io;
        this._currentOperation = null;
        this._paused = false;
        this._stopped = false;
        this._pauseResolve = null;
        this._retryCount = {};
    }

    // ==================== WHATSAPP FUNCTIONS ====================

    _extractPhone(jid) {
        if (!jid) return '';
        return jid.split('@')[0].split(':')[0];
    }

    _isMe(participantId, sock) {
        const pClean = this._extractPhone(participantId);
        const myPhone = this._extractPhone(sock.user.id);
        if (pClean === myPhone) return true;
        if (sock.user.lid) {
            const myLid = this._extractPhone(sock.user.lid);
            if (pClean === myLid) return true;
        }
        return false;
    }

    async getAdminGroups(adminSessionId) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Instancia ADM nao conectada');

        const groups = await sock.groupFetchAllParticipating();
        console.log(`[GroupManager] Total groups: ${Object.keys(groups).length}`);

        const result = [];
        for (const [groupId, group] of Object.entries(groups)) {
            if (group.isCommunity) continue;
            result.push({
                id: groupId,
                subject: group.subject || 'Sem nome',
                size: group.participants.length,
                creation: group.creation,
                desc: group.desc || ''
            });
        }

        console.log(`[GroupManager] Groups (non-community): ${result.length}`);
        return result.sort((a, b) => (a.subject || '').localeCompare(b.subject || ''));
    }

    async getGroupParticipants(adminSessionId, groupId) {
        const sock = await this.getAdmSocket(adminSessionId, 'getGroupParticipants');

        const meta = await sock.groupMetadata(groupId);
        return (meta.participants || []).map(p => ({
            jid: p.id,
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
        }));
    }

    async isNumberOnWhatsApp(adminSessionId, phoneNumber) {
        let sock;
        try { sock = await this.getAdmSocket(adminSessionId, 'isNumberOnWhatsApp'); } catch(e) { return false; }
        if (!sock) return false;
        try {
            const jid = phoneNumber.replace(/\D/g, '') + '@s.whatsapp.net';
            const [result] = await sock.onWhatsApp(jid);
            return result?.exists || false;
        } catch (e) {
            console.log(`[GroupManager] Erro ao verificar numero ${phoneNumber}: ${e.message}`);
            return false;
        }
    }

    async addToGroup(adminSessionId, groupId, jid) {
        const sock = await this.getAdmSocket(adminSessionId, 'addToGroup');

        try {
            console.log(`[GroupManager] addToGroup: group=${groupId}, jid=${jid}`);
            const result = await sock.groupParticipantsUpdate(groupId, [jid], 'add');
            console.log(`[GroupManager] addToGroup result:`, JSON.stringify(result));

            const entry = result?.[0];
            const status = entry?.status || entry?.content?.attrs?.type;

            if (status === '200' || status === 200) return { success: true, alreadyMember: false };
            if (status === '409' || status === 409) return { success: false, alreadyMember: true };
            if (status === '403' || status === 403) return { success: false, alreadyMember: false, error: 'Numero bloqueou convites para grupos' };
            if (status === '408' || status === 408) return { success: false, alreadyMember: false, error: 'Saiu recentemente, so via convite' };

            return { success: true, alreadyMember: false };
        } catch (e) {
            console.log(`[GroupManager] addToGroup error:`, e.message);
            if (e.message?.includes('already') || e.output?.statusCode === 409) {
                return { success: false, alreadyMember: true };
            }
            return { success: false, alreadyMember: false, error: e.message };
        }
    }

    // Wait for ADM to reconnect (up to 60s)
    async waitForAdm(adminSessionId, label) {
        for (let i = 0; i < 12; i++) {
            const sock = this.sessionManager.getSocket(adminSessionId);
            if (sock?.user) return sock;
            const wait = (i + 1) * 5;
            console.log(`[GroupManager] ADM desconectado, aguardando reconexao... (${wait}s) [${label}]`);
            if (this.io) {
                this.io.emit('group_add_log', {
                    operationId: this._currentOperation, type: 'warning',
                    message: `ADM desconectado — aguardando reconexao (tentativa ${i + 1}/12)...`,
                    timestamp: new Date().toISOString()
                });
            }
            await this._delay(5000);
        }
        return null; // failed after 60s
    }

    async getAdmSocket(adminSessionId, label) {
        let sock = this.sessionManager.getSocket(adminSessionId);
        if (sock?.user) return sock;
        // ADM offline — wait for reconnect
        sock = await this.waitForAdm(adminSessionId, label);
        if (!sock) throw new Error('ADM desconectado por mais de 60s — operacao pausada');
        return sock;
    }

    async promoteToAdmin(adminSessionId, groupId, jid) {
        const sock = await this.getAdmSocket(adminSessionId, 'promote');
        try {
            await sock.groupParticipantsUpdate(groupId, [jid], 'promote');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ==================== INVITE LINK MODE ====================

    async joinViaInviteLink(chipSessionId, inviteCode, groupName) {
        const sock = this.sessionManager.getSocket(chipSessionId);
        if (!sock || !sock.user) {
            return { success: false, error: 'Chip nao conectado' };
        }
        try {
            console.log(`[GroupManager] joinViaInviteLink: chip=${chipSessionId}, code=${inviteCode}`);
            const groupJid = await sock.groupAcceptInvite(inviteCode);
            if (groupJid) {
                console.log(`[GroupManager] Chip entrou no grupo ${groupName} (${groupJid})`);
                return { success: true, groupJid, alreadyMember: false };
            }
            return { success: false, error: 'Sem resposta do servidor' };
        } catch (e) {
            const msg = e.message || '';
            console.log(`[GroupManager] joinViaInviteLink error: ${msg}`);
            if (msg.includes('already') || msg.includes('409') || msg.includes('conflict'))
                return { success: false, alreadyMember: true };
            if (msg.includes('not-authorized') || msg.includes('403'))
                return { success: false, error: 'Link expirado ou grupo restrito' };
            if (msg.includes('gone') || msg.includes('410'))
                return { success: false, error: 'Link de convite revogado' };
            return { success: false, error: msg };
        }
    }

    async getInviteCode(adminSessionId, groupId) {
        // Check cache first (12h TTL)
        const cached = db.getGroupInviteLinks();
        if (cached[groupId]?.link) {
            const age = Date.now() - new Date(cached[groupId].fetched_at).getTime();
            if (age < 12 * 60 * 60 * 1000) {
                return cached[groupId].link.split('/').pop();
            }
        }
        // Fetch fresh
        const sock = await this.getAdmSocket(adminSessionId, 'getInviteCode');
        const code = await sock.groupInviteCode(groupId);
        if (!code) throw new Error('Nao obteve codigo de convite');
        db.setGroupInviteLink(groupId, `https://chat.whatsapp.com/${code}`);
        return code;
    }

    // ==================== PHONE NORMALIZATION ====================

    normalizePhoneNumbers(text) {
        if (!text || !text.trim()) return [];
        const lines = text.split(/[\n,;]+/).map(l => l.trim()).filter(l => l);
        const normalized = new Set();
        for (const line of lines) {
            let digits = line.replace(/\D/g, '');
            if (!digits) continue;
            if (digits.length === 10 || digits.length === 11) {
                digits = '55' + digits;
            }
            if (digits.length >= 12 && digits.length <= 15) {
                normalized.add(digits);
            }
        }
        return Array.from(normalized);
    }

    // ==================== PROCESS ONE CHIP (ATOMIC FLOW) ====================

    async processOneChip(adminSessionId, groupId, jid, groupName, callbacks, options = {}) {
        const phone = jid.replace('@s.whatsapp.net', '');
        const mode = options.mode || 'admin_add';
        const promoteDelayMin = (options.promoteDelayMin || 2) * 1000;
        const promoteDelayMax = (options.promoteDelayMax || 3) * 1000;

        // STEP 1 — Check if already member
        try {
            const participants = await this.getGroupParticipants(adminSessionId, groupId);
            const found = participants.find(m => this._extractPhone(m.jid) === phone);

            if (found && found.isAdmin) {
                callbacks.onLog({ type: 'skip', message: `${phone} ja e membro E admin no grupo "${groupName}" — pulando` });
                return { status: 'skipped', adminPromoted: 1 };
            }

            if (found && !found.isAdmin) {
                callbacks.onLog({ type: 'info', message: `${phone} ja e membro de "${groupName}" mas NAO e admin — promovendo` });
                await this._delay(this._random(promoteDelayMin, promoteDelayMax));

                const promoteResult = await this.promoteToAdmin(adminSessionId, groupId, jid);
                if (promoteResult.success) {
                    callbacks.onLog({ type: 'admin', message: `${phone} promovido a ADMIN no grupo "${groupName}"` });
                    return { status: 'skipped', adminPromoted: 1 };
                } else {
                    callbacks.onLog({ type: 'admin_fail', message: `${phone} no grupo "${groupName}" mas falha ao promover: ${promoteResult.error}` });
                    return { status: 'skipped', adminPromoted: -1, adminError: promoteResult.error };
                }
            }
        } catch (e) {
            callbacks.onLog({ type: 'info', message: `Nao foi possivel verificar membros de "${groupName}" — tentando adicionar ${phone}` });
        }

        // STEP 2 — Add to group (mode-dependent)
        let addResult;

        if (mode === 'invite_link' && options.chipSessionId && options.inviteCode) {
            // INVITE LINK MODE: chip entra sozinho
            if (!this.sessionManager.isConnected(options.chipSessionId)) {
                callbacks.onLog({ type: 'error', message: `Chip ${phone} desconectado — nao pode entrar via link` });
                return { status: 'failed', error: 'Chip desconectado' };
            }
            callbacks.onLog({ type: 'info', message: `${phone} entrando no grupo "${groupName}" via link de convite...` });
            addResult = await this.joinViaInviteLink(options.chipSessionId, options.inviteCode, groupName);
        } else {
            // ADMIN ADD MODE (legado): admin adiciona
            addResult = await this.addToGroup(adminSessionId, groupId, jid);
        }

        if (addResult.alreadyMember) {
            callbacks.onLog({ type: 'skip', message: `${phone} ja e membro de "${groupName}" — verificando admin` });
            await this._delay(this._random(promoteDelayMin, promoteDelayMax));

            const promoteResult = await this.promoteToAdmin(adminSessionId, groupId, jid);
            if (promoteResult.success) {
                callbacks.onLog({ type: 'admin', message: `${phone} promovido a ADMIN no grupo "${groupName}"` });
                return { status: 'skipped', adminPromoted: 1 };
            } else {
                callbacks.onLog({ type: 'admin_fail', message: `${phone} ja no grupo "${groupName}" — falha ao promover: ${promoteResult.error}` });
                return { status: 'skipped', adminPromoted: -1, adminError: promoteResult.error };
            }
        }

        if (!addResult.success) {
            callbacks.onLog({ type: 'error', message: `Falha ao adicionar ${phone} em "${groupName}": ${addResult.error || 'erro desconhecido'}` });
            return { status: 'failed', error: addResult.error || 'Falha ao adicionar' };
        }

        const modeLabel = mode === 'invite_link' ? 'via link' : 'pelo admin';
        callbacks.onLog({ type: 'success', message: `${phone} entrou no grupo "${groupName}" (${modeLabel})` });

        // STEP 3 — Delay before promote (configurable)
        const promoteDelay = this._random(promoteDelayMin, promoteDelayMax);
        if (promoteDelay > 5000) {
            await this._delayWithCountdown(promoteDelay, 'Promovendo a admin');
        } else {
            await this._delay(promoteDelay);
        }

        // STEP 4 — Promote to admin
        const promoteResult = await this.promoteToAdmin(adminSessionId, groupId, jid);
        if (promoteResult.success) {
            callbacks.onLog({ type: 'admin', message: `${phone} promovido a ADMIN no grupo "${groupName}"` });
            return { status: 'success', adminPromoted: 1 };
        } else {
            callbacks.onLog({ type: 'admin_fail', message: `${phone} entrou em "${groupName}" mas FALHA ao promover: ${promoteResult.error}` });
            return { status: 'success', adminPromoted: -1, adminError: promoteResult.error };
        }
    }

    // ==================== MAIN ORCHESTRATOR ====================

    forceReset() {
        console.log(`[GroupManager] Force reset: _currentOperation was ${this._currentOperation}`);
        this._currentOperation = null;
        this._paused = false;
        this._stopped = false;
        this._retryCount = {};
        if (this._pauseResolve) this._pauseResolve();
        this._pauseResolve = null;
    }

    async executeBulkGroupAdd(operationId) {
        const operation = db.getAddOperation(operationId);
        if (!operation) throw new Error('Operacao nao encontrada');

        this._currentOperation = operationId;
        this._paused = false;
        this._stopped = false;
        this._retryCount = {};

        try {

        const config = JSON.parse(operation.config || '{}');
        const items = db.getOperationItems(operationId).filter(i => i.status === 'pending' || i.status === 'daily_skipped');
        const adminChip = db.getChipById(operation.admin_chip_id);
        if (!adminChip) throw new Error('Chip ADM nao encontrado');

        const adminSessionId = adminChip.session_id;
        const mode = config.mode || 'admin_add';
        const dailyLimit = config.dailyLimitPerChip || 0;

        // Update operation status
        db.updateAddOperation(operationId, { status: 'running', started_at: new Date().toISOString() });
        this.io.emit('group_add_status', { operationId, status: 'running', message: 'Iniciando adicao...' });

        // ==================== PHASE 0: PRE-FETCH INVITE CODES ====================
        const inviteCodes = {};
        if (mode === 'invite_link') {
            const uniqueGroups = [...new Set(items.map(i => i.group_id))];
            this.io.emit('group_add_log', {
                operationId, type: 'system',
                message: `Buscando links de convite para ${uniqueGroups.length} grupos...`,
                timestamp: new Date().toISOString()
            });

            for (let gi = 0; gi < uniqueGroups.length; gi++) {
                const groupId = uniqueGroups[gi];
                try {
                    inviteCodes[groupId] = await this.getInviteCode(adminSessionId, groupId);
                    this.io.emit('invite_codes_progress', {
                        done: gi + 1, total: uniqueGroups.length, status: 'running'
                    });
                } catch (e) {
                    console.log(`[GroupManager] Erro ao buscar invite code para ${groupId}: ${e.message}`);
                    this.io.emit('group_add_log', {
                        operationId, type: 'warning',
                        message: `Nao foi possivel obter link de convite do grupo ${groupId}: ${e.message}`,
                        timestamp: new Date().toISOString()
                    });
                }
                if (gi < uniqueGroups.length - 1) await this._delay(2000);
            }

            this.io.emit('invite_codes_progress', {
                done: uniqueGroups.length, total: uniqueGroups.length, status: 'done'
            });
            this.io.emit('group_add_log', {
                operationId, type: 'system',
                message: `Links obtidos: ${Object.keys(inviteCodes).length}/${uniqueGroups.length}`,
                timestamp: new Date().toISOString()
            });
        }

        // ==================== PHASE 0.5: RESOLVE CHIP SESSION IDS ====================
        const sessionLookup = {};
        if (mode === 'invite_link') {
            const connected = this.sessionManager.getConnectedSessions();
            for (const { sessionId, chip } of connected) {
                if (chip?.phone) {
                    sessionLookup[chip.phone] = sessionId;
                }
            }
            this.io.emit('group_add_log', {
                operationId, type: 'system',
                message: `Chips conectados mapeados: ${Object.keys(sessionLookup).length}`,
                timestamp: new Date().toISOString()
            });
        }

        // ==================== MAIN LOOP ====================

        // Group items by group_id for sequential processing
        const itemsByGroup = {};
        for (const item of items) {
            if (!itemsByGroup[item.group_id]) itemsByGroup[item.group_id] = [];
            itemsByGroup[item.group_id].push(item);
        }

        const groupIds = Object.keys(itemsByGroup);
        const allItems = db.getOperationItems(operationId); // all items for count
        let totalProcessed = operation.success_count + operation.fail_count + operation.skip_count;
        let successCount = operation.success_count || 0;
        let failCount = operation.fail_count || 0;
        let skipCount = operation.skip_count || 0;
        let adminPromotedCount = operation.admin_promoted_count || 0;
        let adminFailedCount = operation.admin_failed_count || 0;
        let dailySkippedCount = 0;

        const startTime = Date.now();
        const today = new Date().toISOString().split('T')[0];

        try {
            for (let gi = 0; gi < groupIds.length; gi++) {
                const groupId = groupIds[gi];
                const groupItems = itemsByGroup[groupId];
                const groupName = groupItems[0]?.group_name || groupId;

                // Check if we have invite code for this group (invite_link mode)
                if (mode === 'invite_link' && !inviteCodes[groupId]) {
                    // Try to fetch it one more time
                    try {
                        inviteCodes[groupId] = await this.getInviteCode(adminSessionId, groupId);
                    } catch (e) {
                        this.io.emit('group_add_log', {
                            operationId, type: 'error',
                            message: `Sem link de convite para "${groupName}" — pulando grupo`,
                            timestamp: new Date().toISOString()
                        });
                        // Mark all items for this group as failed
                        for (const item of groupItems) {
                            db.updateOperationItem(item.id, {
                                status: 'failed',
                                error_message: 'Sem link de convite disponivel',
                                processed_at: new Date().toISOString()
                            });
                            failCount++;
                            totalProcessed++;
                            this._emitProgress(operationId, item, 'failed', totalProcessed, allItems.length,
                                successCount, failCount, skipCount, adminPromotedCount, adminFailedCount, groupName);
                        }
                        continue;
                    }
                }

                this.io.emit('group_add_log', {
                    operationId, type: 'system',
                    message: `Processando grupo "${groupName}" (${gi + 1}/${groupIds.length})`,
                    timestamp: new Date().toISOString()
                });

                for (let ji = 0; ji < groupItems.length; ji++) {
                    // Check pause/stop
                    if (this._stopped) {
                        db.updateAddOperation(operationId, {
                            status: 'stopped',
                            success_count: successCount, fail_count: failCount,
                            skip_count: skipCount, admin_promoted_count: adminPromotedCount,
                            admin_failed_count: adminFailedCount
                        });
                        this.io.emit('group_add_status', { operationId, status: 'stopped', message: 'Operacao parada pelo usuario' });
                        this._currentOperation = null;
                        return;
                    }

                    if (this._paused) {
                        this.io.emit('group_add_status', { operationId, status: 'paused', message: 'Pausado' });
                        await this._waitForResume();
                        this.io.emit('group_add_status', { operationId, status: 'running', message: 'Retomando...' });
                    }

                    const item = groupItems[ji];
                    const jid = item.phone_number + '@s.whatsapp.net';

                    // ==================== DAILY LIMIT CHECK ====================
                    if (dailyLimit > 0) {
                        const todayCount = db.getChipDailyCount(item.phone_number, today);
                        if (todayCount >= dailyLimit) {
                            db.updateOperationItem(item.id, {
                                status: 'daily_skipped',
                                error_message: `Limite diario atingido (${todayCount}/${dailyLimit})`,
                                processed_at: null
                            });
                            dailySkippedCount++;

                            this.io.emit('group_add_log', {
                                operationId, type: 'warning',
                                message: `${item.phone_number} atingiu limite diario (${todayCount}/${dailyLimit} grupos) — adiado`,
                                timestamp: new Date().toISOString()
                            });
                            this.io.emit('group_add_daily_limit', {
                                operationId, phone: item.phone_number,
                                count: todayCount, limit: dailyLimit
                            });
                            continue; // skip this item, don't count as processed
                        }
                    }

                    // Validate number (manual only)
                    if (config.checkExists && item.source === 'manual') {
                        const exists = await this.isNumberOnWhatsApp(adminSessionId, item.phone_number);
                        if (!exists) {
                            db.updateOperationItem(item.id, {
                                status: 'failed',
                                error_message: 'Numero nao registrado no WhatsApp',
                                processed_at: new Date().toISOString()
                            });
                            failCount++;
                            totalProcessed++;
                            this._emitProgress(operationId, item, 'failed', totalProcessed, allItems.length,
                                successCount, failCount, skipCount, adminPromotedCount, adminFailedCount, groupName);
                            this.io.emit('group_add_log', {
                                operationId, type: 'error',
                                message: `${item.phone_number} nao registrado no WhatsApp`,
                                timestamp: new Date().toISOString()
                            });
                            continue;
                        }
                    }

                    // Process this chip
                    try {
                        const chipSessionId = item.chip_session_id || sessionLookup[item.phone_number] || null;

                        const result = await this.processOneChip(adminSessionId, groupId, jid, groupName, {
                            onLog: (log) => {
                                this.io.emit('group_add_log', {
                                    operationId, ...log, timestamp: new Date().toISOString()
                                });
                            }
                        }, {
                            mode,
                            chipSessionId,
                            inviteCode: inviteCodes[groupId],
                            promoteDelayMin: config.promoteDelayMin || 2,
                            promoteDelayMax: config.promoteDelayMax || 3
                        });

                        // Update item in DB
                        db.updateOperationItem(item.id, {
                            status: result.status,
                            admin_promoted: result.adminPromoted || 0,
                            admin_error: result.adminError || null,
                            error_message: result.error || null,
                            processed_at: new Date().toISOString()
                        });

                        if (result.status === 'success') {
                            successCount++;
                            // Increment daily count on successful join
                            if (dailyLimit > 0) {
                                db.incrementChipDailyCount(item.phone_number, today);
                            }
                        }
                        else if (result.status === 'failed') failCount++;
                        else if (result.status === 'skipped') skipCount++;

                        if (result.adminPromoted === 1) adminPromotedCount++;
                        else if (result.adminPromoted === -1) adminFailedCount++;

                    } catch (e) {
                        // Rate limit detection
                        const retryKey = `${groupId}_${item.phone_number}`;
                        if ((e.message?.includes('rate') || e.message?.includes('429') || e.message?.includes('too many')) && (this._retryCount[retryKey] || 0) < 3) {
                            this._retryCount[retryKey] = (this._retryCount[retryKey] || 0) + 1;
                            this.io.emit('group_add_log', {
                                operationId, type: 'warning',
                                message: `Rate limit detectado (tentativa ${this._retryCount[retryKey]}/3) — pausando por 5 minutos`,
                                timestamp: new Date().toISOString()
                            });
                            await this._delay(300000);
                            ji--;
                            continue;
                        }

                        db.updateOperationItem(item.id, {
                            status: 'failed',
                            error_message: e.message,
                            processed_at: new Date().toISOString()
                        });
                        failCount++;

                        this.io.emit('group_add_log', {
                            operationId, type: 'error',
                            message: `Erro ao processar ${item.phone_number}: ${e.message}`,
                            timestamp: new Date().toISOString()
                        });
                    }

                    totalProcessed++;
                    this._emitProgress(operationId, item, item.status || 'processed', totalProcessed, allItems.length,
                        successCount, failCount, skipCount, adminPromotedCount, adminFailedCount, groupName);

                    // Delay between additions
                    if (ji < groupItems.length - 1) {
                        const delay = this._random(
                            (config.delayMin || 5) * 1000,
                            (config.delayMax || 15) * 1000
                        );
                        if (delay > 5000) {
                            await this._delayWithCountdown(delay, 'Proximo chip');
                        } else {
                            await this._delay(delay);
                        }
                    }
                }

                // Delay between groups
                if (gi < groupIds.length - 1) {
                    const groupDelay = this._random(
                        (config.groupDelayMin || 30) * 1000,
                        (config.groupDelayMax || 60) * 1000
                    );
                    await this._delayWithCountdown(groupDelay, 'Proximo grupo');
                }
            }

            // Check if there are daily_skipped items remaining
            const pendingItems = db.getPendingItems(operationId);
            const duration = Math.round((Date.now() - startTime) / 1000);

            if (pendingItems.length > 0 && dailyLimit > 0) {
                // Paused due to daily limits — resume tomorrow
                db.updateAddOperation(operationId, {
                    status: 'paused_daily',
                    success_count: successCount, fail_count: failCount,
                    skip_count: skipCount, admin_promoted_count: adminPromotedCount,
                    admin_failed_count: adminFailedCount
                });

                this.io.emit('group_add_paused_daily', {
                    operationId,
                    pendingCount: pendingItems.length,
                    message: `Limite diario atingido. ${pendingItems.length} adicoes restantes. Retomar amanha.`
                });
                this.io.emit('group_add_status', {
                    operationId, status: 'paused_daily',
                    message: `Pausado — limite diario. ${pendingItems.length} restantes.`
                });

                const summary = {
                    operationId, status: 'paused_daily',
                    total: allItems.length, success: successCount, fail: failCount, skip: skipCount,
                    adminPromoted: adminPromotedCount, adminFailed: adminFailedCount,
                    pending: pendingItems.length, duration
                };
                this.io.emit('group_add_complete', summary);
            } else {
                // Fully completed
                db.updateAddOperation(operationId, {
                    status: 'completed',
                    success_count: successCount, fail_count: failCount,
                    skip_count: skipCount, admin_promoted_count: adminPromotedCount,
                    admin_failed_count: adminFailedCount,
                    completed_at: new Date().toISOString()
                });

                const summary = {
                    operationId, status: 'completed',
                    total: allItems.length, success: successCount, fail: failCount, skip: skipCount,
                    adminPromoted: adminPromotedCount, adminFailed: adminFailedCount,
                    duration
                };
                this.io.emit('group_add_complete', summary);
                this.io.emit('group_add_status', { operationId, status: 'completed', message: 'Operacao concluida!' });
            }

        } catch (e) {
            console.error('[GroupManager] Erro fatal na operacao:', e);
            db.updateAddOperation(operationId, {
                status: 'failed',
                success_count: successCount, fail_count: failCount,
                skip_count: skipCount, admin_promoted_count: adminPromotedCount,
                admin_failed_count: adminFailedCount
            });
            this.io.emit('group_add_status', { operationId, status: 'failed', message: 'Erro: ' + e.message });
        }

        } catch (outerErr) {
            console.error('[GroupManager] Erro antes da execucao:', outerErr);
            this.io.emit('group_add_status', { operationId, status: 'failed', message: 'Erro: ' + outerErr.message });
        } finally {
            this._currentOperation = null;
        }
    }

    // ==================== RESUME OPERATION ====================

    async resumeOperation(operationId) {
        const operation = db.getAddOperation(operationId);
        if (!operation) throw new Error('Operacao nao encontrada');
        if (operation.status !== 'paused_daily' && operation.status !== 'stopped') {
            throw new Error(`Operacao com status "${operation.status}" nao pode ser retomada`);
        }

        // Reset daily_skipped items back to pending
        const pendingItems = db.getPendingItems(operationId);
        for (const item of pendingItems) {
            if (item.status === 'daily_skipped') {
                db.updateOperationItem(item.id, { status: 'pending', error_message: null });
            }
        }

        console.log(`[GroupManager] Retomando operacao ${operationId} com ${pendingItems.length} items pendentes`);
        await this.executeBulkGroupAdd(operationId);
    }

    // ==================== CONTROL ====================

    pause() {
        if (this._currentOperation) this._paused = true;
    }

    resume() {
        if (this._paused && this._pauseResolve) {
            this._paused = false;
            this._pauseResolve();
            this._pauseResolve = null;
        }
    }

    stop() {
        this._stopped = true;
        if (this._paused && this._pauseResolve) {
            this._pauseResolve();
            this._pauseResolve = null;
        }
    }

    isRunning() {
        return this._currentOperation !== null;
    }

    // ==================== HELPERS ====================

    _emitProgress(operationId, item, status, processed, total, success, fail, skip, adminOk, adminFail, currentGroup) {
        this.io.emit('group_add_stats', {
            operationId, total, processed, success, fail, skip,
            adminOk, adminFail,
            percent: Math.round((processed / total) * 100),
            currentGroup
        });
        this.io.emit('group_add_progress', {
            operationId,
            number: item.phone_number,
            group: item.group_name || item.group_id,
            status,
            adminPromoted: item.admin_promoted || 0,
            message: ''
        });
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _delayWithCountdown(ms, label) {
        return new Promise(resolve => {
            const total = Math.round(ms / 1000);
            let remaining = total;
            const logId = `countdown_${Date.now()}`;

            // Emit initial
            this.io.emit('group_add_countdown', {
                operationId: this._currentOperation, logId, remaining, total, label
            });

            const interval = setInterval(() => {
                remaining--;
                if (remaining <= 0) {
                    clearInterval(interval);
                    this.io.emit('group_add_countdown', {
                        operationId: this._currentOperation, logId, remaining: 0, total, label, done: true
                    });
                    resolve();
                } else {
                    this.io.emit('group_add_countdown', {
                        operationId: this._currentOperation, logId, remaining, total, label
                    });
                }
            }, 1000);
        });
    }

    _random(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    _waitForResume() {
        return new Promise(resolve => {
            this._pauseResolve = resolve;
        });
    }
}

GroupManager.PRESETS = PRESETS;

module.exports = GroupManager;
