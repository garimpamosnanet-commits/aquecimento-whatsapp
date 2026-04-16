const db = require('./database/db');

class ProxyRotator {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.timer = null;
    }

    start() {
        // Check every 30 min
        this.timer = setInterval(() => this.check(), 30 * 60 * 1000);
        // Also run immediately on start to assign missing proxies
        setTimeout(() => this.autoAssignMissing(), 10000);
        console.log('[ProxyRotator] Ativo — check a cada 30min');
    }

    // ==================== AUTO-ASSIGN ====================
    // Assign proxies to connected chips that don't have one (modem model: 1 proxy per chip)
    autoAssignMissing() {
        const chips = db.getAllChips().filter(c =>
            ['connected', 'warming'].includes(c.status) && !c.proxy_id
        );
        if (chips.length === 0) return;

        let assigned = 0;
        for (const chip of chips) {
            const proxy = db.assignProxyToChip(chip.id);
            if (proxy) {
                assigned++;
                console.log(`[ProxyRotator] Auto-assign: chip ${chip.id} (${chip.phone || chip.name}) -> ${proxy.url.replace(/\/\/(.*?)@/, '//***@')}`);
            } else {
                console.log(`[ProxyRotator] Sem proxy disponivel para chip ${chip.id}`);
                break; // No more proxies available
            }
        }
        if (assigned > 0) {
            console.log(`[ProxyRotator] ${assigned} chips receberam proxy automaticamente`);
        }
    }

    // ==================== ROTATION ====================
    check() {
        const settings = db.getSettings();
        const config = settings.proxy_rotation;
        if (!config || !config.enabled) return;

        // Also check for unassigned chips each cycle
        this.autoAssignMissing();

        const intervalMs = (config.interval_hours || 6) * 60 * 60 * 1000;
        const now = Date.now();
        const proxies = db.getAllProxies();
        const available = proxies.filter(p => p.status === 'available');

        // Only rotate if there are spare proxies
        if (available.length === 0) {
            console.log('[ProxyRotator] Sem proxies disponiveis para rotacao');
            return;
        }

        const chips = db.getAllChips().filter(c =>
            ['connected', 'warming'].includes(c.status) && c.proxy_id
        );

        let rotated = 0;
        for (const chip of chips) {
            const currentProxy = proxies.find(p => p.id === chip.proxy_id);
            if (!currentProxy) continue;

            // Check if rotation is due
            const assignedAt = currentProxy._rotated_at || currentProxy.created_at || '2000-01-01';
            const elapsed = now - new Date(assignedAt).getTime();

            if (elapsed >= intervalMs) {
                // Find a different available proxy
                const newProxy = available.find(p => p.id !== chip.proxy_id);
                if (newProxy) {
                    // Release current proxy (pass chip.id, not proxy_id!)
                    db.releaseProxy(chip.id);

                    // Assign specific new proxy to this chip
                    const assigned = db.assignProxyToChip(chip.id, newProxy.id);
                    if (assigned) {
                        // Mark rotation timestamp
                        db.markProxyRotated(assigned.id);

                        // Remove from available pool so next chip gets a different one
                        const idx = available.indexOf(newProxy);
                        if (idx > -1) available.splice(idx, 1);

                        const oldIp = currentProxy.url.replace(/.*@/, '').replace(/:.*/, '');
                        const newIp = assigned.url.replace(/.*@/, '').replace(/:.*/, '');
                        console.log(`[ProxyRotator] Chip ${chip.id} (${chip.phone || ''}): ${oldIp} -> ${newIp}`);
                        rotated++;

                        // Reconnect chip with new proxy (if session manager available)
                        if (this.sessionManager && chip.session_id) {
                            this._reconnectWithNewProxy(chip.session_id, chip.id);
                        }
                    }
                }
            }
        }

        if (rotated > 0) {
            console.log(`[ProxyRotator] ${rotated} chips rotacionados`);
        }
    }

    // Reconnect chip through new proxy
    async _reconnectWithNewProxy(sessionId, chipId) {
        try {
            console.log(`[ProxyRotator] Reconectando chip ${chipId} com novo proxy...`);
            // Disconnect and reconnect (session-manager.connect auto-reads proxy)
            await this.sessionManager.disconnect(sessionId);
            // Small delay before reconnect
            await new Promise(r => setTimeout(r, 3000));
            await this.sessionManager.connect(sessionId);
            console.log(`[ProxyRotator] Chip ${chipId} reconectado com novo proxy`);
        } catch (e) {
            console.log(`[ProxyRotator] Erro ao reconectar chip ${chipId}: ${e.message}`);
        }
    }

    // Force rotate all chips NOW (manual trigger)
    async forceRotateAll() {
        const proxies = db.getAllProxies();
        const available = proxies.filter(p => p.status === 'available');
        if (available.length === 0) return { rotated: 0, error: 'Sem proxies disponiveis' };

        const chips = db.getAllChips().filter(c =>
            ['connected', 'warming'].includes(c.status) && c.proxy_id
        );

        let rotated = 0;
        for (const chip of chips) {
            const newProxy = available.find(p => p.id !== chip.proxy_id);
            if (!newProxy) break;

            db.releaseProxy(chip.id);
            const assigned = db.assignProxyToChip(chip.id, newProxy.id);
            if (assigned) {
                db.markProxyRotated(assigned.id);
                const idx = available.indexOf(newProxy);
                if (idx > -1) available.splice(idx, 1);
                rotated++;

                if (this.sessionManager && chip.session_id) {
                    await this._reconnectWithNewProxy(chip.session_id, chip.id);
                }
            }
        }

        console.log(`[ProxyRotator] Rotacao forcada: ${rotated} chips rotacionados`);
        return { rotated, total: chips.length };
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = ProxyRotator;
