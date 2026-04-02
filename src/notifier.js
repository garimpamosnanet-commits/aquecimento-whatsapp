const db = require('./database/db');

class Notifier {
    constructor(io) {
        this.io = io;
        this._lastNotified = new Map(); // debounce: key -> timestamp
        this.DEBOUNCE_MS = 300000; // 5 min between same notification
    }

    async notify(event, message) {
        const settings = db.getSettings();
        const config = settings.notifications;
        if (!config || !config.enabled || !config.phone) return;
        if (!config.events || !config.events.includes(event)) return;

        // Debounce same message
        const key = event + ':' + message;
        const last = this._lastNotified.get(key);
        if (last && Date.now() - last < this.DEBOUNCE_MS) return;
        this._lastNotified.set(key, Date.now());

        try {
            const phone = config.phone.replace(/\D/g, '');
            const url = `https://api.z-api.io/instances/3E9F26A4DCFB614A95626EB14D89919B/token/9CDF3623EFE3D71E8FAD8912/send-text`;
            const body = { phone, message: `🤖 *Aquecimento KS*\n\n${message}` };

            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Client-Token': 'F7428e0211a2f428d96737ee23d06edb8S' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) console.log('[Notifier] Z-API erro:', resp.status);
        } catch (err) {
            console.error('[Notifier] Erro:', err.message);
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
