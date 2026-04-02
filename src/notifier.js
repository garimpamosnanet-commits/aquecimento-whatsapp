const db = require('./database/db');

const ZAPI_BASE = 'https://api.z-api.io/instances/3E9F26A4DCFB614A95626EB14D89919B/token/9CDF3623EFE3D71E8FAD8912';
const ZAPI_CLIENT_TOKEN = 'F7428e0211a2f428d96737ee23d06edb8S';
const GROUP_ID = '120363429056734446-group'; // 🤖 CHIPS - KS Digital

class Notifier {
    constructor(io) {
        this.io = io;
        this._lastNotified = new Map();
        this.DEBOUNCE_MS = 300000; // 5 min between same notification
    }

    async notify(event, message) {
        const settings = db.getSettings();
        const config = settings.notifications;
        if (!config || !config.enabled) return;
        if (!config.events || !config.events.includes(event)) return;

        // Debounce same message
        const key = event + ':' + message;
        const last = this._lastNotified.get(key);
        if (last && Date.now() - last < this.DEBOUNCE_MS) return;
        this._lastNotified.set(key, Date.now());

        const fullMsg = `🤖 *Aquecimento KS*\n\n${message}`;

        // Send to group
        await this._sendToGroup(fullMsg);

        // Also send to personal number if configured
        if (config.phone) {
            await this._sendToPhone(config.phone, fullMsg);
        }
    }

    async _sendToGroup(message) {
        try {
            const resp = await fetch(`${ZAPI_BASE}/send-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN },
                body: JSON.stringify({ phone: GROUP_ID, message })
            });
            if (!resp.ok) console.log('[Notifier] Z-API grupo erro:', resp.status);
        } catch (err) {
            console.error('[Notifier] Erro grupo:', err.message);
        }
    }

    async _sendToPhone(phone, message) {
        try {
            const clean = phone.replace(/\D/g, '');
            if (!clean) return;
            const resp = await fetch(`${ZAPI_BASE}/send-text`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Client-Token': ZAPI_CLIENT_TOKEN },
                body: JSON.stringify({ phone: clean, message })
            });
            if (!resp.ok) console.log('[Notifier] Z-API phone erro:', resp.status);
        } catch (err) {
            console.error('[Notifier] Erro phone:', err.message);
        }
    }

    // Convenience methods
    chipDisconnected(chipName) {
        this.notify('disconnect', `⚠️ *${chipName}* desconectou do WhatsApp.`);
    }

    chipBanned(chipName) {
        this.notify('ban', `🚨 *${chipName}* foi BANIDO pelo WhatsApp!`);
    }

    phaseChange(chipName, phase) {
        this.notify('phase_change', `📈 *${chipName}* avancou para *Fase ${phase}*.`);
    }

    chipReady(chipName) {
        this.notify('ready', `✅ *${chipName}* completou o aquecimento e esta PRONTO pra uso!`);
    }

    chipError(chipName, error) {
        this.notify('error', `❌ Erro em *${chipName}*: ${error}`);
    }

    dailyReport(stats) {
        const msg = `📊 *Relatorio Diario*\n` +
            `• Chips ativos: ${stats.warming}\n` +
            `• Msgs hoje: ${stats.today_messages}\n` +
            `• Prontos (Fase 4+): ${stats.phases?.[4] || 0}`;
        this.notify('daily_report', msg);
    }
}

module.exports = Notifier;
