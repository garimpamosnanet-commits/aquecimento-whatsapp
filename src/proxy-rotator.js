const db = require('./database/db');

class ProxyRotator {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.timer = null;
    }

    start() {
        // Full rotation/swap check every 30 min (gated by rotation settings)
        this.timer = setInterval(() => this.check(), 30 * 60 * 1000);
        // Auto-assign proxies to chips that don't have one runs INDEPENDENTLY
        // of the rotation setting — a connected chip without a proxy is a bug,
        // not a rotation decision.
        this.assignTimer = setInterval(() => this.autoAssignMissing(), 2 * 60 * 1000);
        setTimeout(() => this.autoAssignMissing(), 10000);
        console.log('[ProxyRotator] Ativo — rotation check 30min, auto-assign 2min');
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
    async check() {
        const settings = db.getSettings();
        const config = settings.proxy_rotation;
        if (!config || !config.enabled) return;

        // Also check for unassigned chips each cycle
        this.autoAssignMissing();

        const intervalMs = (config.interval_hours || 6) * 60 * 60 * 1000;
        const now = Date.now();
        const proxies = db.getAllProxies();
        const available = proxies.filter(p => p.status === 'available');

        // SWAP mode: every `intervalMs`, shuffle the entire proxy pool across
        // all active chips so no chip keeps its IP across cycles.
        if (config.mode === 'swap') {
            const lastSwap = this._lastSwapAt || 0;
            if (now - lastSwap >= intervalMs) {
                console.log('[ProxyRotator] Swap cycle disparado');
                this._lastSwapAt = now;
                try { await this.swapRotateAll(); } catch (e) { console.log('[ProxyRotator] swap erro:', e.message); }
            }
            return;
        }

        // LEGACY mode: rotate from spare pool only when the assigned proxy has
        // been in place for >= intervalMs
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

    // ==================== SWAP ROTATION ====================
    // Cross-rotation: redistribute the full proxy pool (in_use + available) across
    // every active chip so nobody keeps the same IP. Each chip gets a proxy that
    // was not its previous one. Reconnects are staggered to avoid a thundering herd.
    async swapRotateAll() {
        const allProxies = db.getAllProxies();
        const chips = db.getAllChips().filter(c =>
            ['connected', 'warming'].includes(c.status)
        );
        if (chips.length === 0) return { rotated: 0, reason: 'Sem chips ativos' };
        if (allProxies.length === 0) return { rotated: 0, reason: 'Sem proxies cadastrados' };

        // Shuffle the proxy pool
        const pool = [...allProxies];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }

        // Plan: every chip -> a proxy different from its current proxy_id
        const plan = new Map(); // chipId -> new proxyId
        const used = new Set();
        for (const chip of chips) {
            const candidate = pool.find(p => !used.has(p.id) && p.id !== chip.proxy_id);
            if (candidate) {
                plan.set(chip.id, candidate.id);
                used.add(candidate.id);
            }
        }
        // Any chip without a match (usually when pool < chips or all remaining are its own)
        // gets the first free proxy even if it's the same (rare, only when pool size is tight)
        for (const chip of chips) {
            if (plan.has(chip.id)) continue;
            const any = pool.find(p => !used.has(p.id));
            if (any) {
                plan.set(chip.id, any.id);
                used.add(any.id);
            }
        }

        // Apply the plan: release all, then assign per plan, then reconnect sequentially
        for (const chip of chips) {
            if (!plan.has(chip.id)) continue;
            db.releaseProxy(chip.id);
        }
        let rotated = 0;
        const reconnects = [];
        for (const chip of chips) {
            const newProxyId = plan.get(chip.id);
            if (!newProxyId) continue;
            const assigned = db.assignProxyToChip(chip.id, newProxyId);
            if (assigned) {
                db.markProxyRotated(assigned.id);
                rotated++;
                if (this.sessionManager && chip.session_id) {
                    reconnects.push({ sessionId: chip.session_id, chipId: chip.id });
                }
            }
        }

        // Stagger reconnects — 2 per second max to avoid proxy burst
        (async () => {
            for (const r of reconnects) {
                try {
                    await this._reconnectWithNewProxy(r.sessionId, r.chipId);
                } catch (e) { /* best-effort */ }
                await new Promise(res => setTimeout(res, 500));
            }
            console.log(`[ProxyRotator] Swap rotate: ${reconnects.length} reconexoes concluidas`);
        })();

        console.log(`[ProxyRotator] Swap rotate: ${rotated}/${chips.length} chips com proxy novo`);
        return { rotated, total: chips.length };
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = ProxyRotator;
