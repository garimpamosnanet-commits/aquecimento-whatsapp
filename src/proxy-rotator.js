const db = require('./database/db');

class ProxyRotator {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.timer = null;
    }

    start() {
        // Check every 30 min
        this.timer = setInterval(() => this.check(), 30 * 60 * 1000);
        console.log('[ProxyRotator] Ativo');
    }

    check() {
        const settings = db.getSettings();
        const config = settings.proxy_rotation;
        if (!config || !config.enabled) return;

        const intervalMs = (config.interval_hours || 6) * 60 * 60 * 1000;
        const now = Date.now();
        const proxies = db.getAllProxies();
        const available = proxies.filter(p => p.status === 'available');
        if (available.length === 0) return;

        const chips = db.getAllChips().filter(c =>
            ['connected', 'warming'].includes(c.status) && c.proxy_id
        );

        for (const chip of chips) {
            const currentProxy = proxies.find(p => p.id === chip.proxy_id);
            if (!currentProxy) continue;

            // Check if rotation is due (use proxy assigned_at or fallback)
            const assignedAt = currentProxy._rotated_at || currentProxy.created_at || '2000-01-01';
            const elapsed = now - new Date(assignedAt).getTime();

            if (elapsed >= intervalMs) {
                // Find a different available proxy
                const newProxy = available.find(p => p.id !== chip.proxy_id);
                if (newProxy) {
                    db.releaseProxy(chip.proxy_id);
                    db.assignProxyToChip(newProxy.id, chip.id);
                    // Mark rotation time
                    const data = db.getDb();
                    const px = data.proxies?.find(p => p.id === newProxy.id);
                    if (px) {
                        px._rotated_at = new Date().toISOString();
                        const dbModule = require('./database/db');
                        // Save via internal
                        const fs = require('fs');
                        const path = require('path');
                        fs.writeFileSync(
                            path.join(__dirname, '..', 'data', 'warming.json'),
                            JSON.stringify(data, null, 2), 'utf-8'
                        );
                    }
                    console.log(`[ProxyRotator] Chip ${chip.id}: ${currentProxy.url} -> ${newProxy.url}`);
                }
            }
        }
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = ProxyRotator;
