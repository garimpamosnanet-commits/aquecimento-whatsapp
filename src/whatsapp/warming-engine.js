const db = require('../database/db');
const MessageFactory = require('./message-factory');
const fs = require('fs');
const path = require('path');

class WarmingEngine {
    constructor(sessionManager, io) {
        this.sessionManager = sessionManager;
        this.io = io;
        this.activeTimers = new Map(); // chipId -> timeout
        this.running = false;
    }

    start() {
        this.running = true;
        console.log('[WarmingEngine] Motor de aquecimento iniciado');
        this.scheduleAllActive();
    }

    stop() {
        this.running = false;
        for (const [chipId, timer] of this.activeTimers) {
            clearTimeout(timer);
        }
        this.activeTimers.clear();
        console.log('[WarmingEngine] Motor de aquecimento parado');
    }

    startChip(chipId) {
        const chip = db.getChipById(chipId);
        if (!chip) return;

        db.updateChipStatus(chipId, 'warming');
        this.sessionManager.emitChipUpdate(chipId);
        this.scheduleNextAction(chipId);
        console.log(`[WarmingEngine] Aquecimento iniciado para chip ${chipId} (${chip.phone || chip.session_id})`);
    }

    stopChip(chipId) {
        if (this.activeTimers.has(chipId)) {
            clearTimeout(this.activeTimers.get(chipId));
            this.activeTimers.delete(chipId);
        }
        const chip = db.getChipById(chipId);
        if (chip && chip.status === 'warming') {
            db.updateChipStatus(chipId, 'connected');
            this.sessionManager.emitChipUpdate(chipId);
        }
        console.log(`[WarmingEngine] Aquecimento parado para chip ${chipId}`);
    }

    scheduleAllActive() {
        const chips = db.getAllChips();
        for (const chip of chips) {
            if (chip.status === 'warming') {
                this.scheduleNextAction(chip.id);
            }
        }
    }

    scheduleNextAction(chipId) {
        if (!this.running) return;

        const chip = db.getChipById(chipId);
        if (!chip || chip.status !== 'warming') return;

        const config = db.getWarmingConfig(chip.phase);
        if (!config) return;

        // Check if within active hours
        if (!MessageFactory.isActiveHour(config.active_hour_start, config.active_hour_end)) {
            // Schedule for next active hour
            const now = new Date();
            const nextActive = new Date();
            nextActive.setHours(config.active_hour_start, 0, 0, 0);
            if (nextActive <= now) nextActive.setDate(nextActive.getDate() + 1);
            const delay = nextActive - now;
            console.log(`[WarmingEngine] Chip ${chipId} fora do horario ativo. Proximo: ${nextActive.toLocaleTimeString()}`);
            this.activeTimers.set(chipId, setTimeout(() => this.scheduleNextAction(chipId), delay));
            return;
        }

        // Check daily limit
        const todayCount = db.getTodayMessageCount(chipId);
        if (todayCount >= config.daily_limit) {
            // Schedule for tomorrow
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(config.active_hour_start, 0, 0, 0);
            const delay = tomorrow - new Date();
            console.log(`[WarmingEngine] Chip ${chipId} atingiu limite diario (${todayCount}/${config.daily_limit}). Amanha.`);
            this.activeTimers.set(chipId, setTimeout(() => this.scheduleNextAction(chipId), delay));
            return;
        }

        // Random delay before next action
        const delay = MessageFactory.getRandomDelay(config.min_delay_seconds, config.max_delay_seconds);
        console.log(`[WarmingEngine] Chip ${chipId}: proxima acao em ${Math.round(delay / 1000)}s`);

        this.activeTimers.set(chipId, setTimeout(async () => {
            await this.executeAction(chipId);
            // Auto-upgrade phase based on days connected
            this.checkPhaseUpgrade(chipId);
            // Schedule next
            this.scheduleNextAction(chipId);
        }, delay));
    }

    async executeAction(chipId) {
        const chip = db.getChipById(chipId);
        if (!chip || chip.status !== 'warming') return;

        const config = db.getWarmingConfig(chip.phase);
        if (!config) return;

        const enabledActions = config.enabled_actions.split(',');
        const action = enabledActions[Math.floor(Math.random() * enabledActions.length)];

        try {
            switch (action) {
                case 'private_chat':
                    await this.doPrivateChat(chip);
                    break;
                case 'audio':
                    await this.doAudio(chip);
                    break;
                case 'group_chat':
                    await this.doGroupChat(chip);
                    break;
                case 'status':
                    await this.doStatus(chip);
                    break;
                case 'sticker':
                    await this.doSticker(chip);
                    break;
                case 'reaction':
                    await this.doReaction(chip);
                    break;
                default:
                    await this.doPrivateChat(chip);
            }
        } catch (err) {
            console.error(`[WarmingEngine] Erro na acao ${action} para chip ${chipId}:`, err.message);
            db.logActivity(chipId, action, null, err.message, 0);
            this.io.emit('activity', {
                chipId, action, success: false, error: err.message,
                time: new Date().toLocaleTimeString()
            });
        }
    }

    async doPrivateChat(chip) {
        // Pick a random connected chip to chat with
        const partner = this.getRandomPartner(chip.id);
        if (!partner) {
            console.log(`[WarmingEngine] Chip ${chip.id}: sem parceiro disponivel para chat privado`);
            return;
        }

        const socket = this.sessionManager.getSocket(chip.session_id);
        if (!socket?.user) return;

        const partnerJid = partner.phone + '@s.whatsapp.net';
        const flow = MessageFactory.getConversationFlow();

        // Send first message
        const msg = MessageFactory.getRandomMessage(flow[0]);

        // Simulate typing
        await socket.presenceSubscribe(partnerJid);
        await socket.sendPresenceUpdate('composing', partnerJid);
        await new Promise(r => setTimeout(r, MessageFactory.getTypingDelay(msg)));
        await socket.sendPresenceUpdate('paused', partnerJid);

        await socket.sendMessage(partnerJid, { text: msg });
        db.incrementMessagesSent(chip.id);
        db.logActivity(chip.id, 'private_chat', partner.phone, msg);

        this.io.emit('activity', {
            chipId: chip.id, action: 'private_chat',
            target: partner.phone, message: msg, success: true,
            time: new Date().toLocaleTimeString()
        });

        // If flow has more steps, the partner responds
        if (flow.length > 1) {
            const partnerSocket = this.sessionManager.getSocket(partner.session_id);
            if (partnerSocket?.user) {
                const chipJid = chip.phone + '@s.whatsapp.net';
                for (let i = 1; i < flow.length; i++) {
                    const delay = MessageFactory.getRandomDelay(5, 30);
                    await new Promise(r => setTimeout(r, delay));

                    const replyMsg = MessageFactory.getRandomMessage(flow[i]);
                    const sender = i % 2 === 1 ? partnerSocket : socket;
                    const targetJid = i % 2 === 1 ? chipJid : partnerJid;
                    const senderId = i % 2 === 1 ? partner.id : chip.id;
                    const targetPhone = i % 2 === 1 ? chip.phone : partner.phone;

                    await sender.sendPresenceUpdate('composing', targetJid);
                    await new Promise(r => setTimeout(r, MessageFactory.getTypingDelay(replyMsg)));
                    await sender.sendPresenceUpdate('paused', targetJid);

                    await sender.sendMessage(targetJid, { text: replyMsg });
                    db.incrementMessagesSent(senderId);
                    db.logActivity(senderId, 'private_chat', targetPhone, replyMsg);

                    this.io.emit('activity', {
                        chipId: senderId, action: 'private_chat',
                        target: targetPhone, message: replyMsg, success: true,
                        time: new Date().toLocaleTimeString()
                    });
                }
            }
        }

        this.sessionManager.emitChipUpdate(chip.id);
        this.sessionManager.emitStats();
    }

    async doAudio(chip) {
        const audioPath = MessageFactory.getRandomMedia('audios');
        if (!audioPath) {
            // Fallback to private chat
            return this.doPrivateChat(chip);
        }

        const partner = this.getRandomPartner(chip.id);
        if (!partner) return;

        const socket = this.sessionManager.getSocket(chip.session_id);
        if (!socket?.user) return;

        const partnerJid = partner.phone + '@s.whatsapp.net';
        const audioBuffer = fs.readFileSync(audioPath);

        await socket.sendPresenceUpdate('recording', partnerJid);
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));

        await socket.sendMessage(partnerJid, {
            audio: audioBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true
        });

        db.incrementMessagesSent(chip.id);
        db.logActivity(chip.id, 'audio', partner.phone, path.basename(audioPath));

        this.io.emit('activity', {
            chipId: chip.id, action: 'audio',
            target: partner.phone, message: '🎤 Audio enviado', success: true,
            time: new Date().toLocaleTimeString()
        });

        this.sessionManager.emitChipUpdate(chip.id);
    }

    async doGroupChat(chip) {
        const socket = this.sessionManager.getSocket(chip.session_id);
        if (!socket?.user) return;

        // Try to find existing warming groups or create one
        const groups = db.getWarmingGroups();
        let targetGroup = null;

        if (groups.length > 0) {
            targetGroup = groups[Math.floor(Math.random() * groups.length)];
        } else {
            // Create a new warming group with available chips
            const connectedChips = this.sessionManager.getConnectedSessions();
            if (connectedChips.length < 2) return;

            const participants = connectedChips
                .filter(s => s.chip.id !== chip.id)
                .slice(0, Math.min(4, connectedChips.length - 1))
                .map(s => s.chip.phone + '@s.whatsapp.net');

            if (participants.length === 0) return;

            try {
                const groupName = MessageFactory.getGroupName();
                const group = await socket.groupCreate(groupName, participants);
                const groupId = db.createWarmingGroup(group.id, groupName, chip.id);
                db.addGroupMember(groupId, chip.id);
                for (const s of connectedChips.filter(s => s.chip.id !== chip.id).slice(0, 4)) {
                    db.addGroupMember(groupId, s.chip.id);
                }
                targetGroup = { group_jid: group.id, group_name: groupName, id: groupId };

                db.logActivity(chip.id, 'group_create', groupName, `Grupo criado com ${participants.length} membros`);
                this.io.emit('activity', {
                    chipId: chip.id, action: 'group_create',
                    target: groupName, message: `Grupo criado com ${participants.length} membros`, success: true,
                    time: new Date().toLocaleTimeString()
                });
            } catch (err) {
                console.error(`[WarmingEngine] Erro ao criar grupo:`, err.message);
                return;
            }
        }

        if (!targetGroup) return;

        // Send message to group
        const msg = MessageFactory.getGroupMessage();
        await socket.sendPresenceUpdate('composing', targetGroup.group_jid);
        await new Promise(r => setTimeout(r, MessageFactory.getTypingDelay(msg)));

        await socket.sendMessage(targetGroup.group_jid, { text: msg });
        db.incrementMessagesSent(chip.id);
        db.logActivity(chip.id, 'group_chat', targetGroup.group_name, msg);

        this.io.emit('activity', {
            chipId: chip.id, action: 'group_chat',
            target: targetGroup.group_name, message: msg, success: true,
            time: new Date().toLocaleTimeString()
        });

        this.sessionManager.emitChipUpdate(chip.id);
    }

    async doStatus(chip) {
        const socket = this.sessionManager.getSocket(chip.session_id);
        if (!socket?.user) return;

        const statusText = MessageFactory.getStatusText();

        try {
            await socket.sendMessage('status@broadcast', { text: statusText });
            db.incrementMessagesSent(chip.id);
            db.logActivity(chip.id, 'status', 'status@broadcast', statusText);

            this.io.emit('activity', {
                chipId: chip.id, action: 'status',
                target: 'Status', message: statusText, success: true,
                time: new Date().toLocaleTimeString()
            });
        } catch (err) {
            // Status might fail, fallback to chat
            return this.doPrivateChat(chip);
        }

        this.sessionManager.emitChipUpdate(chip.id);
    }

    async doSticker(chip) {
        const stickerPath = MessageFactory.getRandomMedia('stickers');
        if (!stickerPath) return this.doPrivateChat(chip);

        const partner = this.getRandomPartner(chip.id);
        if (!partner) return;

        const socket = this.sessionManager.getSocket(chip.session_id);
        if (!socket?.user) return;

        const partnerJid = partner.phone + '@s.whatsapp.net';

        await socket.sendMessage(partnerJid, {
            sticker: fs.readFileSync(stickerPath)
        });

        db.incrementMessagesSent(chip.id);
        db.logActivity(chip.id, 'sticker', partner.phone, 'Sticker enviado');

        this.io.emit('activity', {
            chipId: chip.id, action: 'sticker',
            target: partner.phone, message: '🏷️ Sticker enviado', success: true,
            time: new Date().toLocaleTimeString()
        });

        this.sessionManager.emitChipUpdate(chip.id);
    }

    async doReaction(chip) {
        // React to a random partner - just send a message and react to own for simplicity
        const partner = this.getRandomPartner(chip.id);
        if (!partner) return this.doPrivateChat(chip);

        const socket = this.sessionManager.getSocket(chip.session_id);
        if (!socket?.user) return;

        // Send a message first, then react from partner
        const partnerJid = partner.phone + '@s.whatsapp.net';
        const msg = MessageFactory.getRandomMessage('casual');

        const sent = await socket.sendMessage(partnerJid, { text: msg });
        db.incrementMessagesSent(chip.id);

        // Partner reacts
        const partnerSocket = this.sessionManager.getSocket(partner.session_id);
        if (partnerSocket?.user) {
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 5000));
            const emoji = MessageFactory.getRandomReaction();
            await partnerSocket.sendMessage(chip.phone + '@s.whatsapp.net', {
                react: { text: emoji, key: sent.key }
            });
            db.logActivity(partner.id, 'reaction', chip.phone, emoji);
        }

        db.logActivity(chip.id, 'private_chat', partner.phone, msg);

        this.io.emit('activity', {
            chipId: chip.id, action: 'reaction',
            target: partner.phone, message: '👍 Mensagem + Reação', success: true,
            time: new Date().toLocaleTimeString()
        });

        this.sessionManager.emitChipUpdate(chip.id);
    }

    getRandomPartner(excludeChipId) {
        const connected = this.sessionManager.getConnectedSessions();
        const partners = connected.filter(s => s.chip.id !== excludeChipId && s.chip.phone);
        if (partners.length === 0) return null;
        return partners[Math.floor(Math.random() * partners.length)].chip;
    }

    checkPhaseUpgrade(chipId) {
        const chip = db.getChipById(chipId);
        if (!chip || !chip.connected_at) return;

        const connectedDate = new Date(chip.connected_at);
        const now = new Date();
        const daysDiff = Math.floor((now - connectedDate) / (1000 * 60 * 60 * 24));

        let newPhase = chip.phase;
        if (daysDiff >= 13) newPhase = 4;
        else if (daysDiff >= 8) newPhase = 3;
        else if (daysDiff >= 4) newPhase = 2;
        else newPhase = 1;

        if (newPhase !== chip.phase) {
            db.updateChipPhase(chipId, newPhase);
            console.log(`[WarmingEngine] Chip ${chipId} avancou para fase ${newPhase} (${daysDiff} dias)`);
            this.io.emit('phase_change', { chipId, phase: newPhase, days: daysDiff });
            this.sessionManager.emitChipUpdate(chipId);
        }
    }
}

module.exports = WarmingEngine;
