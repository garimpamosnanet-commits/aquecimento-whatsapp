// ==================== ADMIN MANAGER — GERENCIAR ADMINS DOS GRUPOS ====================
// Motor para rebaixar/remover admins dos grupos do cliente.
// Usa a instancia ADM do cliente para demote/remove.
// Triple protection: ADM instance NEVER demoted/removed.

const db = require('../database/db');
const { getBinaryNodeChild, getBinaryNodeChildren, isJidUser, isLidUser, jidNormalizedUser } = require('@whiskeysockets/baileys');

class AdminManager {
    constructor(sessionManager, io) {
        this.sessionManager = sessionManager;
        this.io = io;
        this._currentOperation = null;
        this._paused = false;
        this._stopped = false;
        this._pauseResolve = null;
        this._lidCache = {}; // LID JID -> phone number cache
        this._lastDebugAttrs = null; // Store last raw attrs for debug endpoint
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

    // ==================== GET GROUP ADMINS (RAW QUERY) ====================

    // ==================== RAW GROUP QUERY (shared) ====================

    async _getRawParticipants(adminSessionId, groupId) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Instancia ADM nao conectada');

        const rawResult = await sock.query({
            tag: 'iq',
            attrs: { type: 'get', xmlns: 'w:g2', to: groupId },
            content: [{ tag: 'query', attrs: { request: 'interactive' } }]
        });

        const groupNode = getBinaryNodeChild(rawResult, 'group');
        return { participants: getBinaryNodeChildren(groupNode, 'participant'), sock };
    }

    _resolveParticipant(p, sock) {
        const attrs = p.attrs || {};
        const isMe = this._isMe(attrs.jid, sock);
        const lid = isLidUser(attrs.jid) ? this._extractPhone(attrs.jid) : (attrs.lid ? this._extractPhone(attrs.lid) : '');
        const type = attrs.type || 'member'; // 'admin', 'superadmin', or undefined (member)

        let phone = '';
        const phoneCandidate = attrs.phone_number || attrs.pn || attrs.phone || attrs.number || attrs.participant_pn || null;

        if (phoneCandidate) {
            const normalized = jidNormalizedUser(phoneCandidate);
            phone = normalized ? this._extractPhone(normalized) : phoneCandidate.replace(/[^0-9]/g, '');
        } else if (isJidUser(attrs.jid)) {
            phone = this._extractPhone(attrs.jid);
        }

        if (!phone && Array.isArray(p.content)) {
            for (const child of p.content) {
                if (child.tag === 'pn' || child.tag === 'phone' || child.tag === 'contact') {
                    const val = child.attrs?.val || child.attrs?.value || (typeof child.content === 'string' ? child.content : '');
                    if (val && val.length >= 10) {
                        phone = val.replace(/[^0-9]/g, '');
                    }
                }
            }
        }

        if (!phone) {
            for (const [key, val] of Object.entries(attrs)) {
                if (key === 'jid' || key === 'lid' || key === 'type') continue;
                const strVal = String(val);
                const digits = strVal.replace(/[^0-9]/g, '');
                if (digits.length >= 10 && digits.length <= 15) {
                    phone = digits;
                    break;
                }
            }
        }

        if (phone && phone !== lid) {
            this._lidCache[attrs.jid] = phone;
        } else if (this._lidCache[attrs.jid]) {
            phone = this._lidCache[attrs.jid];
        }

        let name = null;
        if (isMe) {
            phone = this._extractPhone(sock.user.id);
            name = 'EU (ADM)';
        }

        return {
            jid: attrs.jid,
            lid,
            phone: phone || lid,
            name,
            type, // 'admin', 'superadmin', or 'member'
            isSuper: type === 'superadmin',
            isAdmin: type === 'admin' || type === 'superadmin',
            isMe
        };
    }

    // ==================== GET GROUP ADMINS ====================

    async getGroupAdmins(adminSessionId, groupId) {
        const { participants, sock } = await this._getRawParticipants(adminSessionId, groupId);

        const admins = [];
        for (const p of participants) {
            const attrs = p.attrs || {};
            if (attrs.type !== 'admin' && attrs.type !== 'superadmin') continue;
            admins.push(this._resolveParticipant(p, sock));
        }
        return admins;
    }

    // ==================== GET GROUP MEMBERS (non-admins only) ====================

    async getGroupMembers(adminSessionId, groupId) {
        const { participants, sock } = await this._getRawParticipants(adminSessionId, groupId);

        const members = [];
        for (const p of participants) {
            const attrs = p.attrs || {};
            if (attrs.type === 'admin' || attrs.type === 'superadmin') continue;
            members.push(this._resolveParticipant(p, sock));
        }
        return members;
    }

    // Debug: get last raw attrs (accessible via API)
    getLastDebugAttrs() {
        return this._lastDebugAttrs;
    }

    async getGroupInviteLink(adminSessionId, groupId) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Instancia ADM nao conectada');

        const code = await sock.groupInviteCode(groupId);
        if (!code) throw new Error('Nao foi possivel obter o link de convite');
        const link = `https://chat.whatsapp.com/${code}`;

        // Cache in DB
        db.setGroupInviteLink(groupId, link);
        return link;
    }

    // Fetch all invite links in background with rate limit protection
    async fetchAllInviteLinks(adminSessionId, groups) {
        if (this._fetchingLinks) return; // Already running
        this._fetchingLinks = true;

        const cached = db.getGroupInviteLinks();
        const total = groups.length;
        let done = 0;
        let errors = 0;

        console.log(`[AdminManager] Fetching invite links for ${total} groups in background...`);
        this.io.emit('invite_links_progress', { done: 0, total, status: 'running' });

        for (const g of groups) {
            // Skip if already cached (less than 24h old)
            if (cached[g.id] && cached[g.id].link && cached[g.id].fetched_at) {
                const age = Date.now() - new Date(cached[g.id].fetched_at).getTime();
                if (age < 24 * 60 * 60 * 1000) {
                    done++;
                    continue;
                }
            }

            // Fetch with retry
            let success = false;
            let retries = 0;
            while (!success && retries <= 4) {
                try {
                    const sock = this.sessionManager.getSocket(adminSessionId);
                    if (!sock || !sock.user) throw new Error('Desconectado');
                    const code = await sock.groupInviteCode(g.id);
                    if (code) {
                        db.setGroupInviteLink(g.id, `https://chat.whatsapp.com/${code}`);
                        success = true;
                    } else {
                        throw new Error('Codigo vazio');
                    }
                } catch (err) {
                    if (err.message && err.message.includes('rate') && retries < 4) {
                        retries++;
                        const wait = retries * 15000; // 15s, 30s, 45s, 60s
                        console.log(`[AdminManager] Rate limit on invite link, waiting ${wait/1000}s...`);
                        await this._delay(wait);
                    } else {
                        errors++;
                        console.log(`[AdminManager] Failed invite link for ${g.id}: ${err.message}`);
                        success = true; // Skip this one
                    }
                }
            }

            done++;
            if (done % 5 === 0 || done === total) {
                this.io.emit('invite_links_progress', { done, total, errors, status: done === total ? 'done' : 'running' });
            }

            // 2.5s delay between each to avoid rate limit
            if (done < total) await this._delay(2500);
        }

        this._fetchingLinks = false;
        console.log(`[AdminManager] Invite links done: ${done}/${total} (${errors} errors)`);
        this.io.emit('invite_links_progress', { done, total, errors, status: 'done' });
    }

    async addToGroup(adminSessionId, groupId, jid) {
        const sock = this.sessionManager.getSocket(adminSessionId);
        if (!sock || !sock.user) throw new Error('Socket ADM nao disponivel');

        try {
            const result = await sock.groupParticipantsUpdate(groupId, [jid], 'add');
            // result is array, check status
            const status = result?.[0]?.status || result?.[0]?.content?.attrs?.type;
            if (status === '403') return { success: false, error: 'Numero bloqueou convites de grupo' };
            if (status === '409') return { success: false, error: 'Ja esta no grupo' };
            if (status === '408') return { success: false, error: 'Numero saiu recentemente, nao pode ser adicionado agora' };
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
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

    forceReset() {
        console.log(`[AdminManager] Force reset: _currentOperation was ${this._currentOperation}`);
        this._currentOperation = null;
        this._paused = false;
        this._stopped = false;
        this._retryCount = {};
        // Resolve any hanging pause promise to prevent memory leak
        if (this._pauseResolve) {
            this._pauseResolve();
        }
        this._pauseResolve = null;
    }

    async executeAdminManage(operationId) {
        const operation = db.getAdminManageOperation(operationId);
        if (!operation) throw new Error('Operacao nao encontrada');

        this._currentOperation = operationId;
        this._paused = false;
        this._stopped = false;
        this._retryCount = {};

        try {

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
                        // Rate limit detection (max 3 retries per item)
                        const retryKey = `${groupId}_${item.jid}`;
                        if (!this._retryCount) this._retryCount = {};
                        if ((e.message?.includes('rate') || e.message?.includes('429') || e.message?.includes('too many')) && (this._retryCount[retryKey] || 0) < 3) {
                            this._retryCount[retryKey] = (this._retryCount[retryKey] || 0) + 1;
                            this.io.emit('admin_manage_log', {
                                operationId, type: 'warning',
                                message: `Rate limit detectado (tentativa ${this._retryCount[retryKey]}/3) — pausando por 5 minutos`,
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

        } catch (outerErr) {
            console.error('[AdminManager] Erro antes da execucao:', outerErr);
            this.io.emit('admin_manage_status', { operationId, status: 'failed', message: 'Erro: ' + outerErr.message });
        } finally {
            this._currentOperation = null;
        }
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
