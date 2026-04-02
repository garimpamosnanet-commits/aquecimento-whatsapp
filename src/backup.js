const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'warming.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 10;
const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function createBackup() {
    try {
        if (!fs.existsSync(DB_PATH)) return;
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dest = path.join(BACKUP_DIR, `warming-${timestamp}.json`);
        fs.copyFileSync(DB_PATH, dest);

        // Remove old backups beyond MAX_BACKUPS
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('warming-') && f.endsWith('.json'))
            .sort()
            .reverse();

        for (let i = MAX_BACKUPS; i < files.length; i++) {
            fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
        }

        console.log(`[Backup] Salvo: ${dest}`);
    } catch (err) {
        console.error('[Backup] Erro:', err.message);
    }
}

function start() {
    // Backup on startup
    createBackup();
    // Then every 6 hours
    setInterval(createBackup, INTERVAL_MS);
    console.log('[Backup] Automatico a cada 6h (max 10 copias)');
}

module.exports = { start, createBackup };
