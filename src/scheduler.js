const db = require('./database/db');

class Scheduler {
    constructor(warmingEngine, sessionManager, io) {
        this.warming = warmingEngine;
        this.sessions = sessionManager;
        this.io = io;
        this.timer = null;
        this._wasRunning = false; // tracks if we auto-started
    }

    start() {
        // Check every 60 seconds
        this.timer = setInterval(() => this.check(), 60000);
        console.log('[Scheduler] Verificacao a cada 60s');
    }

    check() {
        const settings = db.getSettings();
        const sched = settings.schedule;
        if (!sched || !sched.enabled) return;

        const now = new Date();
        const h = now.getHours();
        const m = now.getMinutes();
        const currentMin = h * 60 + m;
        const startMin = sched.start_hour * 60 + (sched.start_min || 0);
        const stopMin = sched.stop_hour * 60 + (sched.stop_min || 0);

        const inWindow = currentMin >= startMin && currentMin < stopMin;

        if (inWindow && !this._wasRunning) {
            // Time to start — start all connected chips
            this._wasRunning = true;
            const chips = db.getAllChips();
            let started = 0;
            for (const chip of chips) {
                if (chip.status === 'connected' && (chip.instance_type || 'warming') === 'warming') {
                    try {
                        this.warming.startChip(chip.id);
                        started++;
                    } catch (e) {}
                }
            }
            if (started > 0) {
                console.log(`[Scheduler] Auto-start: ${started} chips iniciados (${sched.start_hour}:${String(sched.start_min||0).padStart(2,'0')})`);
                this.io.emit('toast', { message: `Agendamento: ${started} chips iniciados`, type: 'success' });
            }
        } else if (!inWindow && this._wasRunning) {
            // Time to stop
            this._wasRunning = false;
            this.warming.stopAll();
            console.log(`[Scheduler] Auto-stop: todos os chips parados (${sched.stop_hour}:${String(sched.stop_min||0).padStart(2,'0')})`);
            this.io.emit('toast', { message: 'Agendamento: aquecimento pausado', type: 'warning' });
        }

        // Collect daily stats snapshot
        this._collectDailyStats();
    }

    _collectDailyStats() {
        const today = new Date().toISOString().slice(0, 10);
        const chips = db.getAllChips();
        const stats = {
            total_chips: chips.length,
            connected: chips.filter(c => ['connected', 'warming'].includes(c.status)).length,
            warming: chips.filter(c => c.status === 'warming').length,
            total_messages: chips.reduce((sum, c) => sum + (c.messages_sent || 0), 0),
            today_messages: 0,
            phases: { 1: 0, 2: 0, 3: 0, 4: 0 }
        };
        for (const c of chips) {
            if (c.phase >= 1 && c.phase <= 4) stats.phases[c.phase]++;
        }
        // Count today's activity
        const activities = db.getRecentActivity(null, 5000);
        const todayActivities = activities.filter(a => a.created_at && a.created_at.startsWith(today));
        stats.today_messages = todayActivities.length;

        db.addDailyStat(today, stats);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = Scheduler;
