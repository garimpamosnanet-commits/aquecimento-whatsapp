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
    require('./src/database/db').getDb();
    console.log('[DB] Banco de dados inicializado');

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
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] Desligando...');
    warmingEngine.stop();
    await sessionManager.disconnectAll();
    process.exit(0);
});
