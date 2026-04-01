const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const SessionManager = require('./src/whatsapp/session-manager');
const WarmingEngine = require('./src/whatsapp/warming-engine');
const apiRoutes = require('./src/routes/api');
const setupWebSocket = require('./src/routes/websocket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize components
const sessionManager = new SessionManager(io);
const warmingEngine = new WarmingEngine(sessionManager, io);

// Routes
app.use('/api', apiRoutes(sessionManager, warmingEngine));

// WebSocket
setupWebSocket(io, sessionManager, warmingEngine);

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
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] Desligando...');
    warmingEngine.stop();
    await sessionManager.disconnectAll();
    process.exit(0);
});
