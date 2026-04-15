#!/bin/sh
# Auto-update script - downloads latest code from GitHub before starting
# Used by EasyPanel Comando field to bypass Docker cache

REPO="https://raw.githubusercontent.com/garimpamosnanet-commits/aquecimento-whatsapp/master"

echo "[Update] Baixando codigo mais recente do GitHub..."

# Core
wget -q -O /app/server.js "$REPO/server.js"

# WhatsApp modules
wget -q -O /app/src/whatsapp/session-manager.js "$REPO/src/whatsapp/session-manager.js"
wget -q -O /app/src/whatsapp/warming-engine.js "$REPO/src/whatsapp/warming-engine.js"
wget -q -O /app/src/whatsapp/group-manager.js "$REPO/src/whatsapp/group-manager.js"
wget -q -O /app/src/whatsapp/admin-manager.js "$REPO/src/whatsapp/admin-manager.js"
wget -q -O /app/src/whatsapp/message-factory.js "$REPO/src/whatsapp/message-factory.js"

# Routes
wget -q -O /app/src/routes/api.js "$REPO/src/routes/api.js"
wget -q -O /app/src/routes/websocket.js "$REPO/src/routes/websocket.js"

# Database
wget -q -O /app/src/database/db.js "$REPO/src/database/db.js"

# Services
wget -q -O /app/src/health-monitor.js "$REPO/src/health-monitor.js"
wget -q -O /app/src/notifier.js "$REPO/src/notifier.js"
wget -q -O /app/src/scheduler.js "$REPO/src/scheduler.js"
wget -q -O /app/src/backup.js "$REPO/src/backup.js"
wget -q -O /app/src/proxy-rotator.js "$REPO/src/proxy-rotator.js"

# Frontend
wget -q -O /app/public/index.html "$REPO/public/index.html"
wget -q -O /app/public/login.html "$REPO/public/login.html"
wget -q -O /app/public/js/app.js "$REPO/public/js/app.js"
wget -q -O /app/public/css/style.css "$REPO/public/css/style.css"

echo "[Update] Todos os arquivos atualizados!"
