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

// In-memory log buffer for debugging
const _debugLogs = [];
const MAX_DEBUG_LOGS = 200;
function debugLog(msg) {
    const ts = new Date().toISOString().substr(11, 12);
    const entry = `[${ts}] ${msg}`;
    console.log(entry);
    _debugLogs.push(entry);
    if (_debugLogs.length > MAX_DEBUG_LOGS) _debugLogs.shift();
}

class SessionManager {
    constructor(io, notifier) {
        this.io = io;
        this.notifier = notifier;
        this.sessions = new Map(); // sessionId -> { socket, chip }
        this.reconnectTimers = new Map();
    }

    getDebugLogs() {
        return _debugLogs.slice();
    }

    async initialize() {
        // Reconnect all previously connected chips
        const chips = db.getAllChips();
        for (const chip of chips) {
            if (chip.status === 'connected' || chip.status === 'warming' || chip.status === 'rehabilitation') {
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
        debugLog(`[SessionManager] Criando sessao ${sessionId} (nome: ${name || 'sem nome'})`);
        const chip = db.createChip(sessionId, name);
        // Auto-assign proxy if available
        const proxy = db.assignProxyToChip(chip.id);
        if (proxy) {
            debugLog(`[SessionManager] Proxy atribuido ao chip ${chip.id}: ${proxy.url}`);
        }
        try {
            await this.connect(sessionId);
        } catch (err) {
            debugLog(`[SessionManager] ERRO ao conectar ${sessionId}: ${err.message}`);
            this.io.emit('qr_error', { sessionId, chipId: chip.id, error: err.message });
            throw err;
        }
        return chip;
    }

    async connect(sessionId) {
        debugLog(`[SM] connect(${sessionId})`);
        // Clean up existing session if any
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            if (existing.socket) {
                try { existing.socket.end(); } catch(e) {}
            }
            this.sessions.delete(sessionId);
        }

        // Clear any pending reconnect timer
        if (this.reconnectTimers.has(sessionId)) {
            clearTimeout(this.reconnectTimers.get(sessionId));
            this.reconnectTimers.delete(sessionId);
        }

        const sessionPath = path.join(SESSIONS_DIR, sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        // Get version with fallback (fetchLatestBaileysVersion can fail/timeout)
        let version;
        try {
            const result = await Promise.race([
                fetchLatestBaileysVersion(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('version timeout')), 5000))
            ]);
            version = result.version;
            debugLog(`[SM] Baileys version: ${JSON.stringify(version)}`);
        } catch (e) {
            version = [2, 3000, 1015901307];
            debugLog(`[SM] Version fetch failed (${e.message}), using fallback: ${JSON.stringify(version)}`);
        }

        // Check for proxy
        const chip = db.getChipBySession(sessionId);
        if (!chip) {
            debugLog(`[SM] ERRO: chip nao encontrado para ${sessionId}`);
            throw new Error('Chip nao encontrado no banco de dados');
        }
        const proxyData = db.getProxyForChip(chip.id);
        const agent = proxyData ? createProxyAgent(proxyData.url) : undefined;

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
            debugLog(`[SM] Proxy ativo para ${sessionId}`);
        }

        debugLog(`[SM] Criando socket para ${sessionId}...`);
        let socket;
        try {
            socket = makeWASocket(socketOptions);
        } catch (e) {
            debugLog(`[SM] ERRO makeWASocket: ${e.message}`);
            this.io.emit('qr_error', { sessionId, chipId: chip.id, error: `Falha ao criar socket: ${e.message}` });
            throw e;
        }
        debugLog(`[SM] Socket criado OK para ${sessionId}`);

        this.sessions.set(sessionId, { socket, chip });

        // QR Code event
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            debugLog(`[SessionManager] connection.update para ${sessionId}: connection=${connection}, qr=${qr ? 'SIM' : 'NAO'}, error=${lastDisconnect?.error?.message || 'none'}`);

            if (qr) {
                debugLog(`[SessionManager] QR recebido para ${sessionId}, convertendo...`);
                db.updateChipStatus(chip.id, 'qr_pending');
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                debugLog(`[SessionManager] QR convertido, emitindo via socket.io...`);
                this.io.emit('qr', { sessionId, chipId: chip.id, qr: qrDataUrl });
                this.emitChipUpdate(chip.id);
                debugLog(`[SessionManager] QR emitido para ${sessionId}`);
            }

            if (connection === 'open') {
                debugLog(`[SessionManager] ${sessionId} conectado!`);
                db.updateChipStatus(chip.id, 'connected');

                // Get phone number from socket
                const phoneNumber = socket.user?.id?.split(':')[0] || socket.user?.id?.split('@')[0];
                if (phoneNumber) {
                    db.updateChipPhone(chip.id, phoneNumber);
                }

                // Get push name (only if user hasn't set a custom name)
                const pushName = socket.user?.name;
                const freshChip = db.getChipById(chip.id);
                if (pushName && freshChip && !freshChip.name) {
                    db.updateChipName(chip.id, pushName);
                }

                // Get profile picture
                try {
                    const jid = socket.user?.id;
                    if (jid) {
                        const ppUrl = await socket.profilePictureUrl(jid, 'image');
                        if (ppUrl) {
                            db.updateChipField(chip.id, 'profile_pic', ppUrl);
                        }
                    }
                } catch (e) {
                    // No profile pic or privacy setting - ignore
                    debugLog(`[SessionManager] Sem foto de perfil para ${sessionId}`);
                }

                this.io.emit('connected', { sessionId, chipId: chip.id, phone: phoneNumber });
                this.emitChipUpdate(chip.id);
                this.emitStats();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = DisconnectReason;
                const currentChip = db.getChipById(chip.id);
                const wasInQRPhase = currentChip && currentChip.status === 'qr_pending';

                debugLog(`[SessionManager] ${sessionId} desconectado. Code: ${statusCode}, wasQR: ${wasInQRPhase}, error: ${lastDisconnect?.error?.message || 'none'}`);

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
                    // Notify — possible ban
                    if (this.notifier) {
                        const name = chip.name || chip.phone || sessionId;
                        if (statusCode === 401 || statusCode === 440) {
                            this.notifier.chipBanned(name);
                        } else {
                            this.notifier.chipDisconnected(name);
                        }
                    }
                } else if (wasInQRPhase) {
                    // QR phase — auto-reconnect after short delay (keeps QR rotating)
                    debugLog(`[SM] ${sessionId} QR expirou, auto-reconectando em 3s...`);
                    this.sessions.delete(sessionId);
                    const timer = setTimeout(() => this.connect(sessionId), 3000);
                    this.reconnectTimers.set(sessionId, timer);
                } else if (statusCode !== reason.connectionClosed) {
                    // Already authenticated chip — try to reconnect after delay
                    const delay = Math.min(5000 + Math.random() * 5000, 30000);
                    debugLog(`[SessionManager] Reconectando ${sessionId} em ${Math.round(delay / 1000)}s...`);
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

    async connectWithPhone(sessionId, phoneNumber) {
        debugLog(`[SM] connectWithPhone(${sessionId}, ${phoneNumber})`);
        const session = this.sessions.get(sessionId);
        if (!session || !session.socket) {
            throw new Error('Sessao nao encontrada. Crie a sessao primeiro.');
        }
        const { socket, chip } = session;

        // Clean phone number: remove +, spaces, dashes
        const cleanPhone = phoneNumber.replace(/[\s\-\+\(\)]/g, '');
        debugLog(`[SM] Requesting pairing code for ${cleanPhone}...`);

        try {
            const code = await socket.requestPairingCode(cleanPhone);
            debugLog(`[SM] Pairing code received: ${code}`);
            this.io.emit('pairing_code', {
                sessionId,
                chipId: chip.id,
                code: code
            });
            return code;
        } catch (e) {
            debugLog(`[SM] ERRO pairing code: ${e.message}`);
            this.io.emit('qr_error', { sessionId, chipId: chip.id, error: `Erro ao gerar codigo: ${e.message}` });
            throw e;
        }
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
