// ==================== HEALTH MONITOR (READ-ONLY INTELLIGENCE LAYER) ====================
// This module NEVER writes to the database. It only reads state, computes scores, and emits to frontend.

const db = require('./database/db');

class HealthMonitor {
    constructor(io) {
        this.io = io;
        this.interval = null;
        this.INTERVAL_MS = 30000; // 30 seconds
        this.lastHealthData = null;
        this._rehabCandidateChecks = new Map(); // chipId -> consecutive low-score count
        this._rehabExitChecks = new Map(); // chipId -> consecutive good-score count
    }

    start() {
        console.log('[HealthMonitor] Iniciado (intervalo: 30s)');
        // Run immediately once, then on interval
        this._tick();
        this.interval = setInterval(() => this._tick(), this.INTERVAL_MS);
    }

    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        console.log('[HealthMonitor] Parado');
    }

    _tick() {
        try {
            const chips = db.getAllChips();
            const proxies = db.getAllProxies();
            const folders = db.getAllFolders();
            const recentActivity = db.getRecentActivity(null, 5000);

            // Build last-activity map per chip
            const lastActivityMap = this._buildLastActivityMap(recentActivity);

            // Build today's message count per chip
            const todayCountMap = this._buildTodayCountMap(recentActivity);

            // Compute chip health
            const chipHealthMap = {};
            for (const chip of chips) {
                chipHealthMap[chip.id] = this.computeChipHealth(chip, lastActivityMap[chip.id] || null, todayCountMap[chip.id] || 0, proxies);
            }

            // Compute proxy health
            const proxyHealthMap = {};
            for (const proxy of proxies) {
                proxyHealthMap[proxy.id] = this.computeProxyHealth(proxy, chips);
            }

            // Compute folder summaries
            const folderSummaries = {};
            for (const folder of folders) {
                const folderChips = chips.filter(c => c.folder_id === folder.id);
                folderSummaries[folder.id] = this.computeFolderSummary(folder, folderChips, chipHealthMap, todayCountMap);
            }
            // Also compute summary for unassigned chips
            const unassignedChips = chips.filter(c => !c.folder_id);
            folderSummaries['none'] = this.computeFolderSummary({ id: null, name: 'Sem pasta' }, unassignedChips, chipHealthMap, todayCountMap);

            // Alerts
            const alerts = this.getAlerts(chips, proxies, lastActivityMap, todayCountMap);

            // Enriched stats
            const enrichedStats = this.getEnrichedStats(chips, chipHealthMap, todayCountMap, recentActivity, folderSummaries);

            // Rehabilitation detection (read-only suggestions)
            const rehabSuggestions = this.detectRehabCandidates(chips, chipHealthMap, recentActivity);
            const rehabExitReady = this.detectRehabExitReady(chips, chipHealthMap);

            const healthData = {
                chipHealth: chipHealthMap,
                proxyHealth: proxyHealthMap,
                folderSummaries,
                alerts,
                enrichedStats,
                rehabSuggestions,
                rehabExitReady,
                timestamp: new Date().toISOString()
            };

            this.lastHealthData = healthData;
            this.io.emit('health_update', healthData);
        } catch (err) {
            console.error('[HealthMonitor] Erro no tick:', err.message);
        }
    }

    _buildLastActivityMap(recentActivity) {
        const map = {};
        for (const entry of recentActivity) {
            if (!map[entry.chip_id]) {
                map[entry.chip_id] = entry; // Already sorted by most recent first
            }
        }
        return map;
    }

    _buildTodayCountMap(recentActivity) {
        const today = new Date().toISOString().slice(0, 10);
        const map = {};
        for (const entry of recentActivity) {
            if (entry.created_at && entry.created_at.startsWith(today)) {
                map[entry.chip_id] = (map[entry.chip_id] || 0) + 1;
            }
        }
        return map;
    }

    computeChipHealth(chip, lastActivity, todayMsgCount, proxies) {
        let score = 100;
        const reasons = [];

        // 1. Status scoring
        if (chip.status === 'warming') {
            // Best status - no penalty
        } else if (chip.status === 'rehabilitation') {
            score -= 15;
            reasons.push('Em reabilitacao');
        } else if (chip.status === 'connected') {
            score -= 10;
            reasons.push('Conectado mas nao aquecendo');
        } else if (chip.status === 'disconnected') {
            score -= 50;
            reasons.push('Desconectado');
        } else if (chip.status === 'qr_pending') {
            score -= 40;
            reasons.push('QR pendente');
        } else if (chip.status === 'discarded') {
            return { score: 0, status: 'critical', reasons: ['Chip descartado'], lastActivityMinutesAgo: null, todayMsgCount: 0 };
        } else {
            score -= 30;
            reasons.push('Status: ' + chip.status);
        }

        // 2. Messages sent vs expected for phase/day
        if (chip.status === 'warming' || chip.status === 'rehabilitation') {
            const config = db.getWarmingConfig(chip.phase);
            if (config) {
                const now = new Date();
                const hoursPassed = now.getHours() - (config.active_hour_start || 8);
                if (hoursPassed > 0) {
                    const totalActiveHours = (config.active_hour_end || 22) - (config.active_hour_start || 8);
                    const expectedByNow = Math.round((config.daily_limit || 50) * (hoursPassed / totalActiveHours));
                    if (expectedByNow > 0 && todayMsgCount < expectedByNow * 0.3) {
                        score -= 20;
                        reasons.push('Msgs hoje (' + todayMsgCount + ') muito abaixo do esperado (' + expectedByNow + ')');
                    } else if (expectedByNow > 0 && todayMsgCount < expectedByNow * 0.6) {
                        score -= 10;
                        reasons.push('Msgs hoje (' + todayMsgCount + ') abaixo do esperado (' + expectedByNow + ')');
                    }
                }
            }
        }

        // 3. Time since last activity
        if (lastActivity && lastActivity.created_at) {
            const lastTime = new Date(lastActivity.created_at);
            const minutesAgo = Math.round((Date.now() - lastTime.getTime()) / 60000);
            if (chip.status === 'warming' && minutesAgo > 30) {
                score -= 15;
                reasons.push('Sem atividade ha ' + minutesAgo + ' min');
            } else if (chip.status === 'warming' && minutesAgo > 15) {
                score -= 5;
                reasons.push('Ultima atividade ha ' + minutesAgo + ' min');
            }
        } else if (chip.status === 'warming') {
            score -= 10;
            reasons.push('Nenhuma atividade registrada');
        }

        // 4. Proxy check
        const hasProxy = proxies.some(p => p.assigned_chip_id === chip.id);
        if (!hasProxy) {
            score -= 10;
            reasons.push('Sem proxy atribuido');
        }

        // Clamp score
        score = Math.max(0, Math.min(100, score));

        // Determine status
        let status;
        if (score >= 70) {
            status = 'healthy';
        } else if (score >= 40) {
            status = 'attention';
        } else {
            status = 'critical';
        }

        // Compute last activity minutes ago
        let lastActivityMinutesAgo = null;
        if (lastActivity && lastActivity.created_at) {
            lastActivityMinutesAgo = Math.round((Date.now() - new Date(lastActivity.created_at).getTime()) / 60000);
        }

        return { score, status, reasons, lastActivityMinutesAgo, todayMsgCount };
    }

    computeProxyHealth(proxy, chips) {
        let score = 100;
        let status = 'healthy';

        if (!proxy.assigned_chip_id) {
            // Available proxy - neutral
            return { score: 50, status: 'available' };
        }

        // Proxy is assigned - check if chip is active
        const chip = chips.find(c => c.id === proxy.assigned_chip_id);
        if (!chip) {
            score = 30;
            status = 'critical';
            return { score, status, reason: 'Atribuido a chip inexistente' };
        }

        if (chip.status === 'disconnected') {
            score = 40;
            status = 'attention';
            return { score, status, reason: 'Chip desconectado' };
        }

        if (chip.status === 'warming') {
            score = 100;
            status = 'healthy';
        } else if (chip.status === 'connected') {
            score = 70;
            status = 'healthy';
        }

        return { score, status };
    }

    computeFolderSummary(folder, folderChips, chipHealthMap, todayCountMap) {
        const total = folderChips.length;
        const connected = folderChips.filter(c => c.status === 'connected' || c.status === 'warming').length;
        const warming = folderChips.filter(c => c.status === 'warming').length;
        const disconnected = folderChips.filter(c => c.status === 'disconnected').length;

        let totalScore = 0;
        let healthyCnt = 0;
        let attentionCnt = 0;
        let criticalCnt = 0;

        for (const chip of folderChips) {
            const health = chipHealthMap[chip.id];
            if (health) {
                totalScore += health.score;
                if (health.status === 'healthy') healthyCnt++;
                else if (health.status === 'attention') attentionCnt++;
                else criticalCnt++;
            }
        }

        const avgScore = total > 0 ? Math.round(totalScore / total) : 0;
        const todayMessages = folderChips.reduce((sum, c) => sum + (todayCountMap[c.id] || 0), 0);

        let overallStatus;
        if (criticalCnt > 0) {
            overallStatus = 'critical';
        } else if (attentionCnt > 0) {
            overallStatus = 'attention';
        } else if (total > 0) {
            overallStatus = 'healthy';
        } else {
            overallStatus = 'empty';
        }

        return {
            folderId: folder.id,
            folderName: folder.name,
            total,
            connected,
            warming,
            disconnected,
            avgScore,
            todayMessages,
            overallStatus,
            healthyCnt,
            attentionCnt,
            criticalCnt
        };
    }

    getAlerts(chips, proxies, lastActivityMap, todayCountMap) {
        const alerts = [];
        const now = Date.now();

        for (const chip of chips) {
            const chipLabel = chip.name || chip.phone || ('Chip ' + chip.id);

            // Alert: chip disconnected for >10 min
            if (chip.status === 'disconnected') {
                // Check how long disconnected (if we have last activity)
                const lastAct = lastActivityMap[chip.id];
                if (lastAct && lastAct.created_at) {
                    const minutesAgo = Math.round((now - new Date(lastAct.created_at).getTime()) / 60000);
                    if (minutesAgo > 10) {
                        alerts.push({
                            level: 'critical',
                            message: chipLabel + ' desconectado ha ' + minutesAgo + ' min',
                            chipId: chip.id,
                            time: new Date().toISOString()
                        });
                    }
                } else {
                    alerts.push({
                        level: 'warning',
                        message: chipLabel + ' esta desconectado',
                        chipId: chip.id,
                        time: new Date().toISOString()
                    });
                }
            }

            // Alert: chip with 0 messages today but status is warming
            if (chip.status === 'warming' && (todayCountMap[chip.id] || 0) === 0) {
                const hourNow = new Date().getHours();
                if (hourNow >= 10) { // Only alert after 10am
                    alerts.push({
                        level: 'warning',
                        message: chipLabel + ' aquecendo mas com 0 msgs hoje',
                        chipId: chip.id,
                        time: new Date().toISOString()
                    });
                }
            }

            // Alert: warming chip with no recent activity (>15 min)
            if (chip.status === 'warming') {
                const lastAct = lastActivityMap[chip.id];
                if (lastAct && lastAct.created_at) {
                    const minutesAgo = Math.round((now - new Date(lastAct.created_at).getTime()) / 60000);
                    if (minutesAgo > 15) {
                        alerts.push({
                            level: 'warning',
                            message: chipLabel + ' sem atividade ha ' + minutesAgo + ' min',
                            chipId: chip.id,
                            time: new Date().toISOString()
                        });
                    }
                }
            }

            // Alert: proxy assigned but chip disconnected
            const hasProxy = proxies.some(p => p.assigned_chip_id === chip.id);
            if (hasProxy && chip.status === 'disconnected') {
                alerts.push({
                    level: 'warning',
                    message: chipLabel + ' tem proxy mas esta desconectado',
                    chipId: chip.id,
                    time: new Date().toISOString()
                });
            }

            // Alert: chip without proxy (only if connected/warming)
            if (!hasProxy && (chip.status === 'connected' || chip.status === 'warming')) {
                alerts.push({
                    level: 'warning',
                    message: chipLabel + ' ativo sem proxy atribuido',
                    chipId: chip.id,
                    time: new Date().toISOString()
                });
            }
        }

        // Sort: critical first, then warning
        alerts.sort((a, b) => {
            if (a.level === 'critical' && b.level !== 'critical') return -1;
            if (a.level !== 'critical' && b.level === 'critical') return 1;
            return 0;
        });

        return alerts;
    }

    getEnrichedStats(chips, chipHealthMap, todayCountMap, recentActivity, folderSummaries) {
        // Messages today (across all chips)
        let messagesToday = 0;
        for (const chipId in todayCountMap) {
            messagesToday += todayCountMap[chipId];
        }

        // Messages per hour rate (based on last hour of activity)
        const oneHourAgo = Date.now() - 3600000;
        let msgsLastHour = 0;
        for (const entry of recentActivity) {
            if (entry.created_at && new Date(entry.created_at).getTime() > oneHourAgo) {
                msgsLastHour++;
            }
        }

        // Health counts
        let healthyCnt = 0;
        let attentionCnt = 0;
        let criticalCnt = 0;
        for (const chipId in chipHealthMap) {
            const h = chipHealthMap[chipId];
            if (h.status === 'healthy') healthyCnt++;
            else if (h.status === 'attention') attentionCnt++;
            else if (h.status === 'critical') criticalCnt++;
        }

        return {
            messagesToday,
            msgsPerHour: msgsLastHour,
            healthyCnt,
            attentionCnt,
            criticalCnt,
            totalChips: chips.length,
            connectedChips: chips.filter(c => c.status === 'connected' || c.status === 'warming').length,
            warmingChips: chips.filter(c => c.status === 'warming').length
        };
    }
    // ==================== REHABILITATION DETECTION (READ-ONLY) ====================

    detectRehabCandidates(chips, chipHealthMap, recentActivity) {
        const suggestions = [];
        const nowMs = Date.now();

        for (const chip of chips) {
            // Only suggest rehab for warming chips in phase 4+
            if (chip.status !== 'warming' || chip.phase < 4) {
                this._rehabCandidateChecks.delete(chip.id);
                continue;
            }

            const health = chipHealthMap[chip.id];
            if (!health) continue;

            let shouldSuggest = false;
            let reason = '';

            // Rule 1: health_score < 40 for 3 consecutive checks (1.5 min)
            if (health.score < 40) {
                const count = (this._rehabCandidateChecks.get(chip.id) || 0) + 1;
                this._rehabCandidateChecks.set(chip.id, count);
                if (count >= 3) {
                    shouldSuggest = true;
                    reason = 'Health score baixo (' + health.score + ') por ' + count + ' verificacoes';
                }
            } else {
                this._rehabCandidateChecks.delete(chip.id);
            }

            // Rule 2: 5+ errors in last hour
            if (!shouldSuggest) {
                const oneHourAgo = nowMs - 3600000;
                let errorCount = 0;
                for (const a of recentActivity) {
                    if (a.chip_id === chip.id && !a.success && a.created_at && new Date(a.created_at).getTime() > oneHourAgo) {
                        errorCount++;
                    }
                }
                if (errorCount >= 5) {
                    shouldSuggest = true;
                    reason = errorCount + ' erros na ultima hora';
                }
            }

            // Rule 3: Inactive > 30 min while warming
            if (!shouldSuggest && health.lastActivityMinutesAgo !== null && health.lastActivityMinutesAgo > 30) {
                shouldSuggest = true;
                reason = 'Inativo ha ' + health.lastActivityMinutesAgo + ' minutos';
            }

            if (shouldSuggest) {
                suggestions.push({
                    chipId: chip.id,
                    chipName: chip.name || chip.phone || 'Chip ' + chip.id,
                    score: health.score,
                    reason
                });
            }
        }

        return suggestions;
    }

    detectRehabExitReady(chips, chipHealthMap) {
        const ready = [];

        for (const chip of chips) {
            if (chip.status !== 'rehabilitation') {
                this._rehabExitChecks.delete(chip.id);
                continue;
            }

            const health = chipHealthMap[chip.id];
            if (!health) continue;

            // Exit criteria: health_score >= 70 for 6 consecutive checks (3 min)
            if (health.score >= 70) {
                const count = (this._rehabExitChecks.get(chip.id) || 0) + 1;
                this._rehabExitChecks.set(chip.id, count);
                if (count >= 6) {
                    ready.push({
                        chipId: chip.id,
                        chipName: chip.name || chip.phone || 'Chip ' + chip.id,
                        score: health.score,
                        rehabDuration: chip.rehab_started_at ?
                            Math.round((Date.now() - new Date(chip.rehab_started_at).getTime()) / 60000) : null
                    });
                }
            } else {
                this._rehabExitChecks.delete(chip.id);
            }
        }

        return ready;
    }
}

module.exports = HealthMonitor;
