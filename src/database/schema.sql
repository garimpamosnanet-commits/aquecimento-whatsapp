CREATE TABLE IF NOT EXISTS chips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    name TEXT DEFAULT '',
    status TEXT DEFAULT 'disconnected' CHECK(status IN ('disconnected', 'qr_pending', 'connected', 'warming', 'paused')),
    phase INTEGER DEFAULT 1,
    messages_sent INTEGER DEFAULT 0,
    messages_target INTEGER DEFAULT 2500,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    connected_at DATETIME,
    session_id TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS warming_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase INTEGER NOT NULL,
    daily_limit INTEGER NOT NULL,
    min_delay_seconds INTEGER DEFAULT 30,
    max_delay_seconds INTEGER DEFAULT 300,
    active_hour_start INTEGER DEFAULT 9,
    active_hour_end INTEGER DEFAULT 22,
    enabled_actions TEXT DEFAULT 'private_chat,group_chat,status,audio,sticker,reaction',
    description TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chip_id INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT,
    details TEXT,
    success INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (chip_id) REFERENCES chips(id)
);

CREATE TABLE IF NOT EXISTS warming_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_jid TEXT NOT NULL,
    group_name TEXT NOT NULL,
    created_by INTEGER,
    member_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (created_by) REFERENCES chips(id)
);

CREATE TABLE IF NOT EXISTS warming_group_members (
    group_id INTEGER NOT NULL,
    chip_id INTEGER NOT NULL,
    joined_at DATETIME DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (group_id, chip_id),
    FOREIGN KEY (group_id) REFERENCES warming_groups(id),
    FOREIGN KEY (chip_id) REFERENCES chips(id)
);

-- Default warming phases
INSERT OR IGNORE INTO warming_config (phase, daily_limit, min_delay_seconds, max_delay_seconds, active_hour_start, active_hour_end, enabled_actions, description) VALUES
(1, 15, 120, 600, 9, 22, 'private_chat', 'Fase 1 (Dia 1-3): Leve - poucas mensagens de texto'),
(2, 40, 60, 300, 8, 23, 'private_chat,audio,group_chat', 'Fase 2 (Dia 4-7): Medio - mais mensagens, audio, grupos'),
(3, 80, 30, 180, 8, 23, 'private_chat,audio,group_chat,status,sticker,reaction', 'Fase 3 (Dia 8-14): Intenso - todos os tipos'),
(4, 50, 60, 300, 9, 22, 'private_chat,audio,group_chat,status,sticker,reaction', 'Fase 4 (Dia 15+): Manutencao - atividade moderada');
