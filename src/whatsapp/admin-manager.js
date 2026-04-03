// ==================== ADMIN MANAGER — GERENCIAR ADMINS DOS GRUPOS ====================
// Motor para rebaixar/remover admins dos grupos do cliente.
// Usa a instancia ADM do cliente para demote/remove.
// Triple protection: ADM instance NEVER demoted/removed.

const db = require('../database/db');

class AdminManager {
    constructor(sessionManager, io) {
        this.sessionManager = sessionManager;
        this.io = io;
        this._currentOperation = null;
        this._paused = false;
        this._stopped = false;
        this._pauseResolve = null;
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

    async getGroupAdmins(adminSessionId, groupId) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Instancia ADM nao conectada');

        const meta = await sock.groupMetadata(groupId);
        const admins = [];

        for (const p of (meta.participants || [])) {
            if (p.admin === 'admin' || p.admin === 'superadmin') {
                const isMe = this._isMe(p.id, sock);
                const lid = this._extractPhone(p.id);

                // Try to resolve LID to phone number
                let phone = lid;
                let name = p.notify || null;

                // Check Baileys store for contact info
                try {
                    if (sock.store && sock.store.contacts) {
                        const contact = sock.store.contacts[p.id];
                        if (contact) {
                            name = contact.notify || contact.name || contact.verifiedName || name;
                            if (contact.id && contact.id.includes('@s.whatsapp.net')) {
                                phone = this._extractPhone(contact.id);
                            }
                        }
                    }
                } catch (e) { /* ignore store errors */ }

                // If it's me, use known phone
                if (isMe) {
                    phone = this._extractPhone(sock.user.id);
                    name = name || 'EU (ADM)';
                }

                admins.push({
                    jid: p.id,
                    lid,
                    phone,
                    name,
                    isSuper: p.admin === 'superadmin',
                    isMe
                });
            }
        }

        return admins;
    }

    async demoteFromAdmin(adminSessionId, groupId, jid) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Socket ADM nao disponivel');

        try {
            await sock.groupParticipantsUpdate(groupId, [jid], 'demote');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async removeFromGroup(adminSessionId, groupId, jid) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Socket ADM nao disponivel');

        try {
            await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ==================== MAIN ORCHESTRATOR ====================

    async executeAdminManage(operationId) {
        const operation = db.getAdminManageOperation(operationId);
        if (!operation) throw new Error('Operacao nao encontrada');

        this._currentOperation = operationId;
        this._paused = false;
        this._stopped = false;

        const config = JSON.parse(operation.config || '{}');
        const items = db.getAdminManageItems(operationId);
        const adminChip = db.getChipById(operation.admin_chip_id);
        if (!adminChip) throw new Error('Chip ADM nao encontrado');

        const adminSessionId = adminChip.session_id;
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Instancia ADM nao conectada');

        // Update operation status
        db.updateAdminManageOperation(operationId, { status: 'running', started_at: new Date().toISOString() });
        this.io.emit('admin_manage_status', { operationId, status: 'running', message: 'Iniciando...' });

        // Group items by group_id
        const itemsByGroup = {};
        for (const item of items) {
            if (!itemsByGroup[item.group_id]) itemsByGroup[item.group_id] = [];
            itemsByGroup[item.group_id].push(item);
        }

        const groupIds = Object.keys(itemsByGroup);
        let totalProcessed = 0;
        let demoteOk = 0;
        let demoteFail = 0;
        let removeOk = 0;
        let removeFail = 0;
        let skipCount = 0;

        const startTime = Date.now();

        try {
            for (let gi = 0; gi < groupIds.length; gi++) {
                const groupId = groupIds[gi];
                const groupItems = itemsByGroup[groupId];
                const groupName = groupItems[0]?.group_name || groupId;

                this.io.emit('admin_manage_log', {
                    operationId, type: 'system',
                    message: `Processando grupo "${groupName}" (${gi + 1}/${groupIds.length})`,
                    timestamp: new Date().toISOString()
                });

                for (let ji = 0; ji < groupItems.length; ji++) {
                    // Check pause/stop
                    if (this._stopped) {
                        this._finishOperation(operationId, 'stopped', demoteOk, demoteFail, removeOk, removeFail, skipCount);
                        this._currentOperation = null;
                        return;
                    }

                    if (this._paused) {
                        this.io.emit('admin_manage_status', { operationId, status: 'paused', message: 'Pausado' });
                        await this._waitForResume();
                        this.io.emit('admin_manage_status', { operationId, status: 'running', message: 'Retomando...' });
                    }

                    const item = groupItems[ji];

                    // TRIPLE PROTECTION: Never demote/remove the ADM instance itself
                    if (item.is_me) {
                        db.updateAdminManageItem(item.id, {
                            status: 'skipped',
                            error_message: 'Instancia ADM (protegida)',
                            processed_at: new Date().toISOString()
                        });
                        skipCount++;
                        totalProcessed++;
                        this._emitProgress(operationId, totalProcessed, items.length, demoteOk, demoteFail, removeOk, removeFail, skipCount, groupName);
                        this.io.emit('admin_manage_log', {
                            operationId, type: 'skip',
                            message: `${item.phone} e a instancia ADM — PROTEGIDO, pulando`,
                            timestamp: new Date().toISOString()
                        });
                        continue;
                    }

                    // SUPERADMIN PROTECTION
                    if (item.is_super) {
                        db.updateAdminManageItem(item.id, {
                            status: 'skipped',
                            error_message: 'Superadmin (criador do grupo)',
                            processed_at: new Date().toISOString()
                        });
                        skipCount++;
                        totalProcessed++;
                        this._emitProgress(operationId, totalProcessed, items.length, demoteOk, demoteFail, removeOk, removeFail, skipCount, groupName);
                        this.io.emit('admin_manage_log', {
                            operationId, type: 'skip',
                            message: `${item.phone} e superadmin (criador) em "${groupName}" — pulando`,
                            timestamp: new Date().toISOString()
                        });
                        continue;
                    }

                    try {
                        // STEP 1: Demote
                        const demoteResult = await this.demoteFromAdmin(adminSessionId, groupId, item.jid);

                        if (demoteResult.success) {
                            demoteOk++;
                            this.io.emit('admin_manage_log', {
                                operationId, type: 'demote_ok',
                                message: `${item.phone} rebaixado de admin em "${groupName}"`,
                                timestamp: new Date().toISOString()
                            });

                            db.updateAdminManageItem(item.id, { demote_status: 'success' });

                            // STEP 2: Remove if mode requires it
                            if (config.mode === 'demote_remove') {
                                await this._delay(this._random(2000, 4000));

                                const removeResult = await this.removeFromGroup(adminSessionId, groupId, item.jid);
                                if (removeResult.success) {
                                    removeOk++;
                                    db.updateAdminManageItem(item.id, {
                                        status: 'success',
                                        remove_status: 'success',
                                        processed_at: new Date().toISOString()
                                    });
                                    this.io.emit('admin_manage_log', {
                                        operationId, type: 'remove_ok',
                                        message: `${item.phone} removido do grupo "${groupName}"`,
                                        timestamp: new Date().toISOString()
                                    });
                                } else {
                                    removeFail++;
                                    db.updateAdminManageItem(item.id, {
                                        status: 'partial',
                                        remove_status: 'failed',
                                        error_message: removeResult.error,
                                        processed_at: new Date().toISOString()
                                    });
                                    this.io.emit('admin_manage_log', {
                                        operationId, type: 'remove_fail',
                                        message: `${item.phone} rebaixado mas FALHA ao remover de "${groupName}": ${removeResult.error}`,
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            } else {
                                // Demote only mode
                                db.updateAdminManageItem(item.id, {
                                    status: 'success',
                                    processed_at: new Date().toISOString()
                                });
                            }
                        } else {
                            demoteFail++;
                            db.updateAdminManageItem(item.id, {
                                status: 'failed',
                                demote_status: 'failed',
                                error_message: demoteResult.error,
                                processed_at: new Date().toISOString()
                            });
                            this.io.emit('admin_manage_log', {
                                operationId, type: 'demote_fail',
                                message: `FALHA ao rebaixar ${item.phone} em "${groupName}": ${demoteResult.error}`,
                                timestamp: new Date().toISOString()
                            });
                        }

                    } catch (e) {
                        // Rate limit detection
                        if (e.message?.includes('rate') || e.message?.includes('429') || e.message?.includes('too many')) {
                            this.io.emit('admin_manage_log', {
                                operationId, type: 'warning',
                                message: 'Rate limit detectado — pausando por 5 minutos',
                                timestamp: new Date().toISOString()
                            });
                            await this._delay(300000);
                            ji--;
                            continue;
                        }

                        demoteFail++;
                        db.updateAdminManageItem(item.id, {
                            status: 'failed',
                            error_message: e.message,
                            processed_at: new Date().toISOString()
                        });
                        this.io.emit('admin_manage_log', {
                            operationId, type: 'error',
                            message: `Erro ao processar ${item.phone}: ${e.message}`,
                            timestamp: new Date().toISOString()
                        });
                    }

                    totalProcessed++;
                    this._emitProgress(operationId, totalProcessed, items.length, demoteOk, demoteFail, removeOk, removeFail, skipCount, groupName);

                    // Anti-ban delay between actions
                    if (ji < groupItems.length - 1) {
                        const delay = this._random(
                            (config.delayMin || 3) * 1000,
                            (config.delayMax || 8) * 1000
                        );
                        await this._delay(delay);
                    }
                }

                // Delay between groups
                if (gi < groupIds.length - 1) {
                    const groupDelay = this._random(
                        (config.groupDelayMin || 15) * 1000,
                        (config.groupDelayMax || 30) * 1000
                    );
                    this.io.emit('admin_manage_log', {
                        operationId, type: 'system',
                        message: `Aguardando ${Math.round(groupDelay / 1000)}s antes do proximo grupo...`,
                        timestamp: new Date().toISOString()
                    });
                    await this._delay(groupDelay);
                }
            }

            // Completed
            const duration = Math.round((Date.now() - startTime) / 1000);
            db.updateAdminManageOperation(operationId, {
                status: 'completed',
                demote_ok: demoteOk, demote_fail: demoteFail,
                remove_ok: removeOk, remove_fail: removeFail,
                skip_count: skipCount,
                completed_at: new Date().toISOString()
            });

            const summary = {
                operationId, status: 'completed',
                total: items.length, demoteOk, demoteFail, removeOk, removeFail, skipCount,
                duration, mode: config.mode
            };

            this.io.emit('admin_manage_complete', summary);
            this.io.emit('admin_manage_status', { operationId, status: 'completed', message: 'Operacao concluida!' });

        } catch (e) {
            console.error('[AdminManager] Erro fatal na operacao:', e);
            this._finishOperation(operationId, 'failed', demoteOk, demoteFail, removeOk, removeFail, skipCount);
            this.io.emit('admin_manage_status', { operationId, status: 'failed', message: 'Erro: ' + e.message });
        }

        this._currentOperation = null;
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

    _finishOperation(operationId, status, demoteOk, demoteFail, removeOk, removeFail, skipCount) {
        db.updateAdminManageOperation(operationId, {
            status,
            demote_ok: demoteOk, demote_fail: demoteFail,
            remove_ok: removeOk, remove_fail: removeFail,
            skip_count: skipCount
        });
    }

    _emitProgress(operationId, processed, total, demoteOk, demoteFail, removeOk, removeFail, skipCount, currentGroup) {
        this.io.emit('admin_manage_stats', {
            operationId, total, processed,
            demoteOk, demoteFail, removeOk, removeFail, skipCount,
            percent: Math.round((processed / total) * 100),
            currentGroup
        });
    }

    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _random(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    _waitForResume() {
        return new Promise(resolve => { this._pauseResolve = resolve; });
    }
}

module.exports = AdminManager;
