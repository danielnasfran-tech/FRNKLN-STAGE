'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'frnkln-stage.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stage_font_size   INTEGER NOT NULL DEFAULT 22,
  stage_chord_color TEXT NOT NULL DEFAULT '#ff3b30',
  reduce_motion    INTEGER NOT NULL DEFAULT 0,
  auto_sync        INTEGER NOT NULL DEFAULT 1,
  theme            TEXT NOT NULL DEFAULT 'dark',
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bands (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS songs (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  artist     TEXT NOT NULL DEFAULT '',
  band_id    TEXT REFERENCES bands(id) ON DELETE SET NULL,
  lyrics    TEXT NOT NULL DEFAULT '',
  chords     TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL DEFAULT '',
  capo       TEXT NOT NULL DEFAULT '',
  bpm        TEXT NOT NULL DEFAULT '',
  meter      TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  duration   REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS band_songs (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  band_id    TEXT NOT NULL REFERENCES bands(id) ON DELETE CASCADE,
  song_id    TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(band_id, song_id)
);

CREATE TABLE IF NOT EXISTS setlists (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  band_id     TEXT REFERENCES bands(id) ON DELETE SET NULL,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS setlist_songs (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setlist_id TEXT NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
  song_id    TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  owner_id  TEXT PRIMARY KEY,
  cursor    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bands_owner ON bands(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_songs_owner ON songs(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_song_band ON songs(band_id);
CREATE INDEX IF NOT EXISTS idx_band_songs_owner ON band_songs(owner_id, band_id);
CREATE INDEX IF NOT EXISTS idx_setlists_owner ON setlists(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_setlist_songs_owner ON setlist_songs(owner_id, setlist_id, position);
CREATE INDEX IF NOT EXISTS idx_change_log_owner ON change_log(owner_id, seq);
`);

function nowIso() {
  return new Date().toISOString();
}

function logChange(ownerId, entity, entityId, op) {
  db.prepare(
    `INSERT INTO change_log (owner_id, entity, entity_id, op, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(ownerId, entity, entityId, op, nowIso());
  db.prepare(
    `INSERT INTO sync_state (owner_id, cursor, updated_at)
     VALUES (?, (SELECT COALESCE(MAX(seq),0) FROM change_log WHERE owner_id = ?), ?)
     ON CONFLICT(owner_id) DO UPDATE SET
       cursor = (SELECT COALESCE(MAX(seq),0) FROM change_log WHERE owner_id = ?),
       updated_at = excluded.updated_at`
  ).run(ownerId, ownerId, nowIso(), ownerId);
}

module.exports = { db, DATA_DIR, DB_PATH, nowIso, logChange };
