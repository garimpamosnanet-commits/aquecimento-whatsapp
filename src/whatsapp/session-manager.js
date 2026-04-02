const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const db = require('../database/db');

// Proxy support
let HttpsProxyAgent, SocksProxyAgent;
try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch(e) {}
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch(e) {}

function createProxyAgent(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        if (proxyUrl.startsWith('socks')) {
            return SocksProxyAgent ? new SocksProxyAgent(proxyUrl) : undefined;
        }
        return HttpsProxyAgent ? new HttpsProxyAgent(proxyUrl) : undefined;
    } catch(e) {
        console.log(`[Proxy] Erro ao criar agent: ${e.message}`);
        return undefined;
    }
}

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');
const logger = pino({ level: 'silent' });

class SessionManager {
    constructor(io) {
        this.io = io;
        this.sessions = new Map(); // sessionId -> { socket, chip }
        this.reconnectTimers = new Map();
    }

    async initialize() {
        // Reconnect all previously connected chips
        const chips = db.getAllChips();
        for (const chip of chips) {
            if (chip.status === 'connected' || chip.status === 'warming') {
                const sessionPath = path.join(SESSIONS_DIR, chip.session_id);
                if (fs.existsSync(sessionPath)) {
                    console.log(`[SessionManager] Reconectando ${chip.session_id} (${chip.phone || 'sem numero'})...`);
                    await this.connect(chip.session_id);
                    // Small delay between reconnections to avoid overwhelming
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
    }

    async createSession(name = '') {
        const sessionId = `chip_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const chip = db.createChip(sessionId, name);
        // Auto-assign proxy if available
        const proxy = db.assignProxyToChip(chip.id);
        if (proxy) {
            console.log(`[SessionManager] Proxy atribuido ao chip ${chip.id}: ${proxy.url}`);
        }
        await this.connect(sessionId);
        return chip;
    }

    async connect(sessionId) {
        // Clean up existing session if any
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.socket) {
                existing.socket.end();
            }
        }

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        // Check for proxy
        const chip = db.getChipBySession(sessionId);
        const proxyData = chip ? db.getProxyForChip(chip.id) : null;
        const agent = proxyData ? createProxyAgent(proxyData.url) : undefined;
        if (agent) {
            console.log(`[SessionManager] Usando proxy para ${sessionId}: ${proxyData.url.replace(/\/\/.*@/, '//***@')}`);
        }

        const socketOptions = {
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: ['Aquecimento', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: true,
            generateHighQualityLinkPreview: false
        };

        if (agent) {
            socketOptions.agent = agent;
        }

        const socket = makeWASocket(socketOptions);

        this.sessions.set(sessionId, { socket, chip });

        // QR Code event
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                db.updateChipStatus(chip.id, 'qr_pending');
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                this.io.emit('qr', { sessionId, chipId: chip.id, qr: qrDataUrl });
                this.emitChipUpdate(chip.id);
            }

            if (connection === 'open') {
                console.log(`[SessionManager] ${sessionId} conectado!`);
                db.updateChipStatus(chip.id, 'connected');

                // Get phone number from socket
                const phoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0];
                if (phoneNumber) {
                    db.updateChipPhone(chip.id, phoneNumber);
                }

                // Get push name
                const pushName = socket.user?.name;
                if (pushName && !chip.name) {
                    db.updateChipName(chip.id, pushName);
                }

                this.io.emit('connected', { sessionId, chipId: chip.id, phone: phoneNumber });
                this.emitChipUpdate(chip.id);
                this.emitStats();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = DisconnectReason;

                console.log(`[SessionManager] ${sessionId} desconectado. Code: ${statusCode}`);

                if (statusCode === reason.loggedOut) {
                    // User logged out - clean session
                    db.updateChipStatus(chip.id, 'disconnected');
                    this.sessions.delete(sessionId);
                    // Remove session files
                    const sessionPath = path.join(SESSIONS_DIR, sessionId);
                    if (fs.existsSync(sessionPath)) {
                        fs.rmSync(sessionPath, { recursive: true });
                    }
                    this.io.emit('logged_out', { sessionId, chipId: chip.id });
                } else if (statusCode !== reason.connectionClosed) {
                    // Try to reconnect after delay
                    const delay = Math.min(5000 + Math.random() * 5000, 30000);
                    console.log(`[SessionManager] Reconectando ${sessionId} em ${Math.round(delay / 1000)}s...`);
                    const timer = setTimeout(() => this.connect(sessionId), delay);
                    this.reconnectTimers.set(sessionId, timer);
                }

                this.emitChipUpdate(chip.id);
                this.emitStats();
            }
        });

        socket.ev.on('creds.update', saveCreds);

        // Track incoming messages for reactions
        socket.ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    this.io.emit('message_received', {
                        sessionId,
                        chipId: chip.id,
                        from: msg.key.remoteJid
                    });
                }
            }
        });

        return socket;
    }

    async disconnect(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            if (session.socket) {
                session.socket.end();
            }
            const chip = db.getChipBySession(sessionId);
            if (chip) {
                db.updateChipStatus(chip.id, 'disconnected');
                this.emitChipUpdate(chip.id);
            }
            this.sessions.delete(sessionId);

            // Clear reconnect timer
            if (this.reconnectTimers.has(sessionId)) {
                clearTimeout(this.reconnectTimers.get(sessionId));
                this.reconnectTimers.delete(sessionId);
            }
        }
        this.emitStats();
    }

    async disconnectAll() {
        for (const [sessionId] of this.sessions) {
            await this.disconnect(sessionId);
        }
    }

    async deleteSession(sessionId) {
        await this.disconnect(sessionId);
        const chip = db.getChipBySession(sessionId);
        if (chip) {
            db.releaseProxy(chip.id);
            db.deleteChip(chip.id);
        }
        // Remove session files
        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true });
        }
        this.emitStats();
    }

    getSocket(sessionId) {
        return this.sessions.get(sessionId)?.socket;
    }

    getConnectedSessions() {
        const connected = [];
        for (const [sessionId, { socket, chip }] of this.sessions) {
            if (socket?.user) {
                connected.push({ sessionId, chip: db.getChipBySession(sessionId) });
            }
        }
        return connected;
    }

    isConnected(sessionId) {
        const session = this.sessions.get(sessionId);
        return session?.socket?.user ? true : false;
    }

    emitChipUpdate(chipId) {
        const chip = db.getChipById(chipId);
        if (chip) {
            const proxy = db.getProxyForChip(chip.id);
            chip.proxy_ip = proxy ? proxy.url.replace(/.*@/, '').replace(/:.*/, '') : null;
            this.io.emit('chip_update', chip);
        }
    }

    emitStats() {
        this.io.emit('stats', db.getChipStats());
    }
}

module.exports = SessionManager;
