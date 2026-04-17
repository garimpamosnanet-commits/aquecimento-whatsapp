const db = require('./database/db');

// Auto-reconnector: periodically retries chips that are 'disconnected' but
// still hold a phone number (i.e., they were connected before and their
// Baileys credentials are likely still valid). Complements the boot-time
// sessionManager.initialize() so chips that drop mid-session come back
// without manual intervention.
//
// Skips chips without a phone (never successfully connected — those need
// a fresh QR) and chips already in qr_pending or connected states.
class ChipReconnector {
    constructor(sessionManager, io) {
        this.sessionManager = sessionManager;
        this.io = io;
        this.timer = null;
        this._inflight = new Set();
        this._lastAttempt = new Map();
        this.CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 min
        this.MIN_RETRY_INTERVAL_MS = 5 * 60 * 1000; // backoff: 5 min between retries per chip
        this.MAX_PARALLEL = 3; // don't slam Baileys with 29 simultaneous sockets
    }

    start() {
        // First pass a bit after boot to let sessionManager.initialize() finish
        setTimeout(() => this.check(), 30 * 1000);
        this.timer = setInterval(() => this.check(), this.CHECK_INTERVAL_MS);
        console.log(`[Reconnector] Ativo — check a cada ${this.CHECK_INTERVAL_MS / 1000}s`);
    }

    async check() {
        const now = Date.now();
        const allChips = db.getAllChips();
        const candidates = allChips.filter(c =>
            c.status === 'disconnected' &&
            c.phone &&
            c.session_id &&
            !this._inflight.has(c.session_id) &&
            (!this._lastAttempt.get(c.session_id) || now - this._lastAttempt.get(c.session_id) >= this.MIN_RETRY_INTERVAL_MS)
        );

        if (candidates.length === 0) return;

        const batch = candidates.slice(0, this.MAX_PARALLEL);
        console.log(`[Reconnector] ${candidates.length} chips disconnected com phone; reconectando ${batch.length} nesta rodada`);

        await Promise.all(batch.map(chip => this._attempt(chip)));
    }

    async _attempt(chip) {
        this._inflight.add(chip.session_id);
        this._lastAttempt.set(chip.session_id, Date.now());
        try {
            // If the Baileys socket already exists and is just quiet, don't create another one
            if (this.sessionManager.isConnected(chip.session_id)) {
                console.log(`[Reconnector] Chip ${chip.id} (${chip.phone}) ja conectado — atualizando DB`);
                return;
            }
            console.log(`[Reconnector] Tentando reconectar chip ${chip.id} (${chip.phone})`);
            await this.sessionManager.connect(chip.session_id);
        } catch (err) {
            console.log(`[Reconnector] Falha em chip ${chip.id} (${chip.phone}): ${err.message}`);
        } finally {
            this._inflight.delete(chip.session_id);
        }
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = ChipReconnector;
