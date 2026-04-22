const BUILD_VERSION = '1.6.0-20260419a';
console.log(`\n========================================`);
console.log(`  KS Digital Aquecimento v${BUILD_VERSION}`);
console.log(`  Started at: ${new Date().toISOString()}`);
console.log(`========================================\n`);

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');

const SessionManager = require('./src/whatsapp/session-manager');
const WarmingEngine = require('./src/whatsapp/warming-engine');
const GroupManager = require('./src/whatsapp/group-manager');
const HealthMonitor = require('./src/health-monitor');
const apiRoutes = require('./src/routes/api');
const setupWebSocket = require('./src/routes/websocket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// ==================== AUTH CONFIG ====================
const USERS = [
    { email: 'souzamktonline@gmail.com', password: 'K@zame12', name: 'Gabriel' },
    { email: 'sabaziuscp@gmail.com', password: 'Net@2019@', name: 'Mário' }
];
const sessions = new Map(); // token -> { expiry, name }

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(c => {
        const [key, val] = c.trim().split('=');
        if (key && val) cookies[key] = val;
    });
    return cookies;
}

function isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.auth_token;
    if (!token || !sessions.has(token)) return false;
    if (sessions.get(token).expiry < Date.now()) {
        sessions.delete(token);
        return false;
    }
    return true;
}

// Share io with routes
app.set('io', io);

// Middleware
app.use(express.json());

// Login endpoint (before auth middleware)
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = USERS.find(u => u.email === email && u.password === password);
    if (user) {
        const token = generateToken();
        const expiry = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days
        sessions.set(token, { expiry, name: user.name });
        res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`);
        return res.json({ ok: true, name: user.name });
    }
    res.status(401).json({ error: 'Credenciais invalidas' });
});

// Login page (public)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Auth middleware - protect everything except login
app.use((req, res, next) => {
    // Allow login page and its assets
    if (req.path === '/login' || req.path === '/login.html' || req.path === '/api/login' || req.path === '/ks-logo.png' || req.path === '/css/style.css') {
        return next();
    }
    if (!isAuthenticated(req)) {
        // API calls get 401, page requests get redirected
        if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
            return res.status(401).json({ error: 'Nao autorizado' });
        }
        return res.redirect('/login');
    }
    // Attach user name to request for tracking
    const cookies = parseCookies(req.headers.cookie);
    const session = sessions.get(cookies.auth_token);
    if (session) req.userName = session.name;
    next();
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.auth_token) sessions.delete(cookies.auth_token);
    res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
});

// Static files (after auth middleware) — no cache for JS/CSS
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Initialize components
const Notifier = require('./src/notifier');
const notifier = new Notifier(io);
const sessionManager = new SessionManager(io, notifier);
const warmingEngine = new WarmingEngine(sessionManager, io, notifier);
const groupManager = new GroupManager(sessionManager, io);
const AdminManager = require('./src/whatsapp/admin-manager');
const adminManager = new AdminManager(sessionManager, io);

// Routes
app.use('/api', apiRoutes(sessionManager, warmingEngine, groupManager, adminManager));

// WebSocket auth
io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const cookies = parseCookies(cookieHeader);
    const token = cookies.auth_token;
    if (token && sessions.has(token) && sessions.get(token).expiry > Date.now()) {
        socket.userName = sessions.get(token).name;
        return next();
    }
    next(new Error('Nao autorizado'));
});

// WebSocket
setupWebSocket(io, sessionManager, warmingEngine, groupManager, adminManager);

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
    console.log('');
    console.log('=========================================');
    console.log('   AQUECIMENTO DE CHIPS WHATSAPP');
    console.log('=========================================');
    console.log(`   Dashboard: http://localhost:${PORT}`);
    console.log('=========================================');
    console.log('');

    // Initialize database
    const db = require('./src/database/db');
    db.getDb();
    console.log('[DB] Banco de dados inicializado');

    // Recovery: mark any 'running' group-add operations as 'stopped' (server restarted)
    const ops = db.getAddOperations(100);
    for (const op of ops) {
        if (op.status === 'running') {
            db.updateAddOperation(op.id, { status: 'stopped' });
            console.log(`[Recovery] Operacao group-add #${op.id} marcada como stopped (servidor reiniciou)`);
        }
    }

    // Cleanup: release proxies from disconnected chips
    const allChips = db.getAllChips();
    let proxyFreed = 0;
    for (const chip of allChips) {
        if ((chip.status === 'disconnected' || chip.status === 'discarded') && chip.proxy_id) {
            db.releaseProxy(chip.id);
            proxyFreed++;
        }
    }
    if (proxyFreed > 0) console.log(`[Recovery] ${proxyFreed} proxies liberados de chips desconectados`);

    // Cleanup: merge orphan external_warmed chips
    // Brazilian phone matching (with/without 9th digit)
    function phonesMatch(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        const strip = (p) => p.startsWith('55') && p.length >= 12 ? p.slice(2) : p;
        const na = strip(a), nb = strip(b);
        if (na === nb) return true;
        if (na.length === 11 && nb.length === 10) return na.slice(0, 2) + na.slice(3) === nb.slice(0, 2) + nb.slice(2);
        if (nb.length === 11 && na.length === 10) return nb.slice(0, 2) + nb.slice(3) === na.slice(0, 2) + na.slice(2);
        return false;
    }

    const extChips = allChips.filter(c => c.origin === 'external_warmed' && c.session_id?.startsWith('ext_'));
    let merged = 0;
    for (const ext of extChips) {
        if (!ext.phone) continue;
        const connected = allChips.find(c => c.id !== ext.id && phonesMatch(c.phone, ext.phone) && (c.status === 'connected' || c.status === 'warming'));
        if (connected) {
            if (ext.client_tag && !connected.client_tag) db.setChipClientTag(connected.id, ext.client_tag);
            if (ext.fornecedor) db.updateChipField(connected.id, 'fornecedor', ext.fornecedor);
            if (ext.folder_id && !connected.folder_id) db.assignChipToFolder(connected.id, ext.folder_id);
            db.updateChipField(connected.id, 'origin', 'external_warmed');
            const last4 = ext.phone.slice(-4);
            const label = ext.client_tag || '';
            if (label && (!connected.name || connected.name.startsWith('Chip '))) {
                db.updateChipName(connected.id, `${label} - ${last4}`);
            }
            db.deleteChip(ext.id);
            merged++;
        }
    }
    if (merged > 0) console.log(`[Recovery] ${merged} chips orfaos merged com chips conectados`);

    // Reconnect existing sessions
    await sessionManager.initialize();
    console.log('[Sessions] Sessoes reconectadas');

    // Start warming engine
    warmingEngine.start();
    console.log('[Warming] Motor de aquecimento pronto');

    // Start health monitor (read-only intelligence layer)
    const healthMonitor = new HealthMonitor(io);
    healthMonitor.start();
    console.log('[Health] Monitor de saude iniciado');

    // Start automatic backup
    const backup = require('./src/backup');
    backup.start();

    // Start scheduler (auto start/stop warming)
    const Scheduler = require('./src/scheduler');
    const scheduler = new Scheduler(warmingEngine, sessionManager, io);
    scheduler.start();

    // Start proxy rotator
    const ProxyRotator = require('./src/proxy-rotator');
    const proxyRotator = new ProxyRotator(sessionManager);
    proxyRotator.start();
    app.set('proxyRotator', proxyRotator);

    // Start chip reconnector (auto-recovery for chips that drop mid-session)
    const ChipReconnector = require('./src/chip-reconnector');
    const chipReconnector = new ChipReconnector(sessionManager, io);
    chipReconnector.start();
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] Desligando...');
    warmingEngine.stop();
    await sessionManager.disconnectAll();
    process.exit(0);
});


// ==================== PERIODIC ORPHAN PROXY CLEANUP ====================
try {
    const _dbCleanup = require('./src/database/db');
    // Startup cleanup (30s after boot)
    setTimeout(() => {
        try {
            if (typeof _dbCleanup.releaseOrphanProxies === 'function') {
                const r = _dbCleanup.releaseOrphanProxies();
                if (r && r.released > 0) console.log('[ProxyCleanup startup] Released ' + r.released + ' orphans');
            }
        } catch (e) {}
    }, 30000);
    // Periodic cleanup every 10 minutes
    setInterval(() => {
        try {
            if (typeof _dbCleanup.releaseOrphanProxies === 'function') {
                const r = _dbCleanup.releaseOrphanProxies();
                if (r && r.released > 0) console.log('[ProxyCleanup] Released ' + r.released + ' orphans');
            }
        } catch (e) {
            console.error('[ProxyCleanup] error:', e.message);
        }
    }, 10 * 60 * 1000);
} catch (e) {
    console.error('[ProxyCleanup setup] failed:', e.message);
}


// SOFT RECONNECT
const _srCd = new Map();
const _dbR = require("./src/database/db");
setInterval(() => {
  try {
    if (!sessionManager || typeof sessionManager.isSocketHealthy !== "function") return;
    const chips = _dbR.getAllChips();
    const now = Date.now();
    const cand = chips.filter(c => c.session_id && (c.status === "connected" || c.status === "warming") && !sessionManager.isSocketHealthy(c.session_id) && (_srCd.get(c.id) || 0) < now);
    const batch = cand.slice(0, 3);
    for (const c of batch) {
      _srCd.set(c.id, now + 15*60*1000);
      console.log("[SoftReconnect] " + (c.name || c.id));
      sessionManager.connect(c.session_id).catch(e => console.log("[SoftReconnect] fail: " + e.message));
    }
  } catch(e) { console.error("[SoftReconnect]", e.message); }
}, 5*60*1000);


// ==================== CHIP STATUS SYNC (reconcile ghost qr_pending) ====================
// chip-status-sync: a cada 2 min, compara creds.json com status do DB
const _fsSync = require('fs');
const _pathSync = require('path');
const _dbSync = require('./src/database/db');
const _sessionsRoot = _pathSync.join(__dirname, 'sessions');
setInterval(() => {
    try {
        const data = _dbSync._loadDb();
        let fixed = 0;
        for (const c of data.chips) {
            if (c.status !== 'qr_pending' && c.status !== 'disconnected') continue;
            if (!c.session_id) continue;
            const credsPath = _pathSync.join(_sessionsRoot, c.session_id, 'creds.json');
            try {
                if (_fsSync.existsSync(credsPath)) {
                    const creds = JSON.parse(_fsSync.readFileSync(credsPath, 'utf-8'));
                    if (creds.me && creds.me.id) {
                        c.status = 'connected';
                        if (!c.phone) c.phone = String(creds.me.id).split(':')[0].split('@')[0];
                        fixed++;
                    }
                }
            } catch(e) {}
        }
        if (fixed > 0) {
            _dbSync._saveDb(data);
            console.log('[chip-status-sync] Reconciliado(s) ' + fixed + ' chip(s) com creds vlido para status=connected');
        }
    } catch (e) {
        console.error('[chip-status-sync] erro:', e.message);
    }
}, 2 * 60 * 1000);
