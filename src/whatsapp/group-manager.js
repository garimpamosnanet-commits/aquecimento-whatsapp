// ==================== GROUP MANAGER — ADICIONAR CHIPS AOS GRUPOS ====================
// Motor de adicao em massa de chips aos grupos do cliente.
// Usa a instancia ADM do cliente para adicionar e promover a admin.
// 100% aditivo — zero impacto no warming-engine e session-manager.

const db = require('../database/db');

class GroupManager {
    constructor(sessionManager, io) {
        this.sessionManager = sessionManager;
        this.io = io;
        this._currentOperation = null; // operacao em execucao
        this._paused = false;
        this._stopped = false;
        this._pauseResolve = null;
    }

    // ==================== WHATSAPP FUNCTIONS ====================

    // Extract phone number from any JID format
    // '5543920001520:12@s.whatsapp.net' → '5543920001520'
    // '5543920001520@s.whatsapp.net' → '5543920001520'
    // '5543920001520' → '5543920001520'
    _extractPhone(jid) {
        if (!jid) return '';
        return jid.split('@')[0].split(':')[0];
    }

    // Check if a participant JID matches our user (supports both phone and LID formats)
    _isMe(participantId, sock) {
        const pClean = this._extractPhone(participantId);
        // Match against phone-based JID
        const myPhone = this._extractPhone(sock.user.id);
        if (pClean === myPhone) return true;
        // Match against LID-based JID (new WhatsApp format: 97092785676537@lid)
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
        const myPhone = this._extractPhone(sock.user.id);
        const myLid = sock.user.lid ? this._extractPhone(sock.user.lid) : null;

        console.log(`[GroupManager] Admin phone: ${myPhone}, LID: ${myLid}, total groups: ${Object.keys(groups).length}`);

        const result = [];
        for (const [groupId, group] of Object.entries(groups)) {
            const me = group.participants.find(p => this._isMe(p.id, sock));
            if (me && (me.admin === 'admin' || me.admin === 'superadmin')) {
                result.push({
                    id: groupId,
                    subject: group.subject || 'Sem nome',
                    size: group.participants.length,
                    creation: group.creation,
                    desc: group.desc || ''
                });
            }
        }

        console.log(`[GroupManager] Admin groups found: ${result.length} of ${Object.keys(groups).length} total`);
        return result.sort((a, b) => (a.subject || '').localeCompare(b.subject || ''));
    }

    async getGroupParticipants(adminSessionId, groupId) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Instancia ADM nao conectada');

        const meta = await sock.groupMetadata(groupId);
        return (meta.participants || []).map(p => ({
            jid: p.id,
            isAdmin: p.admin === 'admin' || p.admin === 'superadmin'
        }));
    }

    async isNumberOnWhatsApp(adminSessionId, phoneNumber) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) return false;

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
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Socket ADM nao disponivel');

        try {
            console.log(`[GroupManager] addToGroup: group=${groupId}, jid=${jid}`);
            const result = await sock.groupParticipantsUpdate(groupId, [jid], 'add');
            console.log(`[GroupManager] addToGroup result:`, JSON.stringify(result));

            // Baileys returns array of results per participant
            const entry = result?.[0];
            const status = entry?.status || entry?.content?.attrs?.type;

            // Status 200 = added successfully
            if (status === '200' || status === 200) {
                return { success: true, alreadyMember: false };
            }
            // Status 409 = already in group
            if (status === '409' || status === 409) {
                return { success: false, alreadyMember: true };
            }
            // Status 403 = blocked invites
            if (status === '403' || status === 403) {
                return { success: false, alreadyMember: false, error: 'Numero bloqueou convites para grupos' };
            }
            // Status 408 = recently left, can only be added via invite
            if (status === '408' || status === 408) {
                return { success: false, alreadyMember: false, error: 'Saiu recentemente, so via convite' };
            }

            // If no error thrown, assume success (some Baileys versions don't return status)
            return { success: true, alreadyMember: false };
        } catch (e) {
            console.log(`[GroupManager] addToGroup error:`, e.message);
            if (e.message?.includes('already') || e.output?.statusCode === 409) {
                return { success: false, alreadyMember: true };
            }
            return { success: false, alreadyMember: false, error: e.message };
        }
    }

    async promoteToAdmin(adminSessionId, groupId, jid) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Socket ADM nao disponivel');

        try {
            await sock.groupParticipantsUpdate(groupId, [jid], 'promote');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ==================== PHONE NORMALIZATION ====================

    normalizePhoneNumbers(text) {
        if (!text || !text.trim()) return [];
        const lines = text.split(/[\n,;]+/).map(l => l.trim()).filter(l => l);
        const normalized = new Set();

        for (const line of lines) {
            // Remove all non-digits
            let digits = line.replace(/\D/g, '');
            if (!digits) continue;

            // Add country code if missing
            if (digits.length === 10 || digits.length === 11) {
                digits = '55' + digits;
            }
            // Remove leading + (already stripped by \D removal)
            if (digits.length >= 12 && digits.length <= 15) {
                normalized.add(digits);
            }
        }

        return Array.from(normalized);
    }

    // ==================== PROCESS ONE CHIP (ATOMIC FLOW) ====================

    async processOneChip(adminSessionId, groupId, jid, groupName, callbacks) {
        const phone = jid.replace('@s.whatsapp.net', '');

        // STEP 1 — Check if already member
        try {
            const participants = await this.getGroupParticipants(adminSessionId, groupId);
            const found = participants.find(m => this._extractPhone(m.jid) === phone);

            if (found && found.isAdmin) {
                // Already member AND admin — skip entirely
                callbacks.onLog({ type: 'skip', message: `${phone} ja e membro E admin no grupo "${groupName}" — pulando` });
                return { status: 'skipped', adminPromoted: 1 };
            }

            if (found && !found.isAdmin) {
                // Already member but NOT admin — promote directly
                callbacks.onLog({ type: 'info', message: `${phone} ja e membro de "${groupName}" mas NAO e admin — promovendo` });

                await this._delay(this._random(2000, 3000));

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
            // If can't check participants, proceed with add attempt
            callbacks.onLog({ type: 'info', message: `Nao foi possivel verificar membros de "${groupName}" — tentando adicionar ${phone}` });
        }

        // STEP 2 — Add to group
        const addResult = await this.addToGroup(adminSessionId, groupId, jid);

        if (addResult.alreadyMember) {
            // Was already member — try to promote
            callbacks.onLog({ type: 'skip', message: `${phone} ja e membro de "${groupName}" — verificando admin` });

            await this._delay(this._random(2000, 3000));

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

        callbacks.onLog({ type: 'success', message: `${phone} adicionado ao grupo "${groupName}"` });

        // STEP 3 — Delay before promote (2-3s)
        await this._delay(this._random(2000, 3000));

        // STEP 4 — Promote the SAME jid to admin
        const promoteResult = await this.promoteToAdmin(adminSessionId, groupId, jid);
        if (promoteResult.success) {
            callbacks.onLog({ type: 'admin', message: `${phone} promovido a ADMIN no grupo "${groupName}"` });
            return { status: 'success', adminPromoted: 1 };
        } else {
            callbacks.onLog({ type: 'admin_fail', message: `${phone} adicionado em "${groupName}" mas FALHA ao promover a admin: ${promoteResult.error}` });
            return { status: 'success', adminPromoted: -1, adminError: promoteResult.error };
        }
    }

    // ==================== MAIN ORCHESTRATOR ====================

    async executeBulkGroupAdd(operationId) {
        const operation = db.getAddOperation(operationId);
        if (!operation) throw new Error('Operacao nao encontrada');

        this._currentOperation = operationId;
        this._paused = false;
        this._stopped = false;

        const config = JSON.parse(operation.config || '{}');
        const items = db.getOperationItems(operationId);
        const adminChip = db.getChipById(operation.admin_chip_id);
        if (!adminChip) throw new Error('Chip ADM nao encontrado');

        const adminSessionId = adminChip.session_id;

        // Update operation status
        db.updateAddOperation(operationId, { status: 'running', started_at: new Date().toISOString() });
        this.io.emit('group_add_status', { operationId, status: 'running', message: 'Iniciando adicao...' });

        // Group items by group_id for sequential processing
        const itemsByGroup = {};
        for (const item of items) {
            if (!itemsByGroup[item.group_id]) itemsByGroup[item.group_id] = [];
            itemsByGroup[item.group_id].push(item);
        }

        const groupIds = Object.keys(itemsByGroup);
        let totalProcessed = 0;
        let successCount = 0;
        let failCount = 0;
        let skipCount = 0;
        let adminPromotedCount = 0;
        let adminFailedCount = 0;

        const startTime = Date.now();

        try {
            for (let gi = 0; gi < groupIds.length; gi++) {
                const groupId = groupIds[gi];
                const groupItems = itemsByGroup[groupId];
                const groupName = groupItems[0]?.group_name || groupId;

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

                    // Validate number exists on WhatsApp (only for manual numbers — system chips are already connected)
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
                            this._emitProgress(operationId, item, 'failed', totalProcessed, items.length,
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
                        const result = await this.processOneChip(adminSessionId, groupId, jid, groupName, {
                            onLog: (log) => {
                                this.io.emit('group_add_log', {
                                    operationId, ...log, timestamp: new Date().toISOString()
                                });
                            }
                        });

                        // Update item in DB
                        const itemUpdate = {
                            status: result.status,
                            admin_promoted: result.adminPromoted || 0,
                            admin_error: result.adminError || null,
                            error_message: result.error || null,
                            processed_at: new Date().toISOString()
                        };
                        db.updateOperationItem(item.id, itemUpdate);

                        // Update counters
                        if (result.status === 'success') successCount++;
                        else if (result.status === 'failed') failCount++;
                        else if (result.status === 'skipped') skipCount++;

                        if (result.adminPromoted === 1) adminPromotedCount++;
                        else if (result.adminPromoted === -1) adminFailedCount++;

                    } catch (e) {
                        // Rate limit detection
                        if (e.message?.includes('rate') || e.message?.includes('429') || e.message?.includes('too many')) {
                            this.io.emit('group_add_log', {
                                operationId, type: 'warning',
                                message: 'Rate limit detectado — pausando por 5 minutos',
                                timestamp: new Date().toISOString()
                            });
                            await this._delay(300000); // 5 min
                            ji--; // Retry this item
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
                    this._emitProgress(operationId, item, item.status || 'processed', totalProcessed, items.length,
                        successCount, failCount, skipCount, adminPromotedCount, adminFailedCount, groupName);

                    // Delay between additions
                    if (ji < groupItems.length - 1) {
                        const delay = this._random(
                            (config.delayMin || 5) * 1000,
                            (config.delayMax || 15) * 1000
                        );
                        await this._delay(delay);
                    }
                }

                // Delay between groups
                if (gi < groupIds.length - 1) {
                    const groupDelay = this._random(
                        (config.groupDelayMin || 30) * 1000,
                        (config.groupDelayMax || 60) * 1000
                    );
                    this.io.emit('group_add_log', {
                        operationId, type: 'system',
                        message: `Aguardando ${Math.round(groupDelay / 1000)}s antes do proximo grupo...`,
                        timestamp: new Date().toISOString()
                    });
                    await this._delay(groupDelay);
                }
            }

            // Completed
            const duration = Math.round((Date.now() - startTime) / 1000);
            db.updateAddOperation(operationId, {
                status: 'completed',
                success_count: successCount,
                fail_count: failCount,
                skip_count: skipCount,
                admin_promoted_count: adminPromotedCount,
                admin_failed_count: adminFailedCount,
                completed_at: new Date().toISOString()
            });

            const summary = {
                operationId, status: 'completed',
                total: items.length, success: successCount, fail: failCount, skip: skipCount,
                adminPromoted: adminPromotedCount, adminFailed: adminFailedCount,
                duration
            };

            this.io.emit('group_add_complete', summary);
            this.io.emit('group_add_status', { operationId, status: 'completed', message: 'Operacao concluida!' });

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

        this._currentOperation = null;
    }

    // ==================== CONTROL ====================

    pause() {
        if (this._currentOperation) {
            this._paused = true;
        }
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

    _random(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    _waitForResume() {
        return new Promise(resolve => {
            this._pauseResolve = resolve;
        });
    }
}

module.exports = GroupManager;
