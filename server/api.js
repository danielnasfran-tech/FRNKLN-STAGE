'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, nowIso, logChange } = require('./db');
const {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  setAuthCookie,
} = require('./auth');

const router = express.Router();

function newId() {
  return crypto.randomUUID();
}

function clean(value, max = 20000) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return str.length > max ? str.slice(0, max) : str;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Autenticação                                                        */
/* ------------------------------------------------------------------ */

router.post('/auth/register', (req, res) => {
  const email = clean(req.body.email, 200).trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = clean(req.body.name, 120).trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email', message: 'E-mail inválido.' });
  }
  if (password.length < 8) {
    return res
      .status(400)
      .json({ error: 'weak_password', message: 'A senha deve ter ao menos 8 caracteres.' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    return res.status(409).json({ error: 'email_exists', message: 'Este e-mail já está cadastrado.' });
  }

  const user = {
    id: newId(),
    email,
    name,
    password_hash: hashPassword(password),
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(user.id, user.email, user.name, user.password_hash, user.created_at);
  db.prepare(
    `INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO NOTHING`
  ).run(user.id, nowIso());

  const token = signToken(user);
  setAuthCookie(res, token);
  return res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

router.post('/auth/login', (req, res) => {
  const email = clean(req.body.email, 200).trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res
      .status(401)
      .json({ error: 'invalid_credentials', message: 'E-mail ou senha incorretos.' });
  }
  const token = signToken(user);
  setAuthCookie(res, token);
  return res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('fnk_token', { path: '/' });
  return res.json({ ok: true });
});

router.get('/auth/me', requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

/* ------------------------------------------------------------------ */
/* Snapshot + sincronização                                            */
/* ------------------------------------------------------------------ */

/**
 * `nullable` marca as colunas que aceitam NULL (FKs opcionais e duration).
 * As demais colunas são NOT NULL e recebem string vazia quando ausentes.
 */
const ENTITY_CONFIG = {
  bands: {
    table: 'bands',
    fields: ['name', 'description', 'logo'],
    nullable: [],
    order: 'name COLLATE NOCASE ASC',
  },
  songs: {
    table: 'songs',
    fields: ['title', 'artist', 'band_id', 'lyrics', 'chords', 'key', 'capo', 'bpm', 'meter', 'notes', 'duration'],
    nullable: ['band_id', 'duration'],
    order: 'title COLLATE NOCASE ASC',
  },
  band_songs: {
    table: 'band_songs',
    fields: ['band_id', 'song_id'],
    nullable: [],
    order: 'created_at ASC',
  },
  setlists: {
    table: 'setlists',
    fields: ['name', 'description', 'band_id', 'notes'],
    nullable: ['band_id'],
    order: 'updated_at DESC',
  },
  setlist_songs: {
    table: 'setlist_songs',
    fields: ['setlist_id', 'song_id', 'position', 'notes'],
    nullable: [],
    order: 'setlist_id ASC, position ASC',
  },
};

function fieldValue(field, raw, nullable) {
  if (raw === undefined || raw === null || raw === '') {
    return nullable.includes(field) ? null : '';
  }
  if (field === 'position') {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return clean(raw, field === 'logo' ? 300000 : 20000);
}

function readEntity(row) {
  return {
    ...row,
    deleted: !!row.deleted,
  };
}

function snapshot(ownerId) {
  const out = {};
  for (const [key, cfg] of Object.entries(ENTITY_CONFIG)) {
    const rows = db
      .prepare(`SELECT * FROM ${cfg.table} WHERE owner_id = ? AND deleted = 0 ORDER BY ${cfg.order}`)
      .all(ownerId);
    out[key] = rows.map(readEntity);
  }
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(ownerId);
  out.settings = settings
    ? {
        stage_font_size: settings.stage_font_size,
        stage_chord_color: settings.stage_chord_color,
        reduce_motion: !!settings.reduce_motion,
        auto_sync: !!settings.auto_sync,
        theme: settings.theme,
        updated_at: settings.updated_at,
      }
    : {
        stage_font_size: 22,
        stage_chord_color: '#ff3b30',
        reduce_motion: false,
        auto_sync: true,
        theme: 'dark',
      };
  const state = db.prepare('SELECT cursor FROM sync_state WHERE owner_id = ?').get(ownerId);
  out.cursor = state ? state.cursor : 0;
  out.server_time = nowIso();
  return out;
}

router.get('/state', requireAuth, (req, res) => {
  return res.json(snapshot(req.user.id));
});

/**
 * Sincronização incremental: devolve apenas registros alterados após o cursor
 * do cliente, preservando a ordem (position) das setlists.
 */
router.get('/sync', requireAuth, (req, res) => {
  const ownerId = req.user.id;
  const since = Number(req.query.since || 0);
  const full = req.query.full === '1' || since <= 0;

  const state = db.prepare('SELECT cursor FROM sync_state WHERE owner_id = ?').get(ownerId);
  const cursor = state ? state.cursor : 0;

  if (full) {
    return res.json({ full: true, ...snapshot(ownerId) });
  }

  const changed = db
    .prepare(
      `SELECT entity, entity_id FROM change_log WHERE owner_id = ? AND seq > ? GROUP BY entity, entity_id`
    )
    .all(ownerId, since);
  const byEntity = {};
  for (const row of changed) {
    byEntity[row.entity] = byEntity[row.entity] || [];
    byEntity[row.entity].push(row.entity_id);
  }

  const out = { full: false, cursor, server_time: nowIso(), changes: {} };
  for (const [key, cfg] of Object.entries(ENTITY_CONFIG)) {
    const ids = byEntity[key] || [];
    if (!ids.length) {
      out.changes[key] = [];
      continue;
    }
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT * FROM ${cfg.table} WHERE owner_id = ? AND id IN (${placeholders}) ORDER BY ${cfg.order}`
      )
      .all(ownerId, ...ids);
    out.changes[key] = rows.map(readEntity);
  }

  const settingsRow = db
    .prepare(
      `SELECT s.* FROM user_settings s WHERE s.user_id = ?`
    )
    .get(ownerId);
  const settingsChanged = db
    .prepare(
      `SELECT COUNT(*) AS n FROM change_log WHERE owner_id = ? AND entity = 'settings' AND seq > ?`
    )
    .get(ownerId, since);
  out.changes.settings =
    settingsChanged.n > 0 && settingsRow
      ? {
          stage_font_size: settingsRow.stage_font_size,
          stage_chord_color: settingsRow.stage_chord_color,
          reduce_motion: !!settingsRow.reduce_motion,
          auto_sync: !!settingsRow.auto_sync,
          theme: settingsRow.theme,
          updated_at: settingsRow.updated_at,
        }
      : null;

  return res.json(out);
});

/* ------------------------------------------------------------------ */
/* CRUD genérico com versionamento otimista                            */
/* ------------------------------------------------------------------ */

function entityRoute(key, cfg) {
  const { table } = cfg;

  router.get(`/${key}`, requireAuth, (req, res) => {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE owner_id = ? AND deleted = 0 ORDER BY ${cfg.order}`)
      .all(req.user.id);
    return res.json(rows.map(readEntity));
  });

  router.post(`/${key}`, requireAuth, (req, res) => {
    const ownerId = req.user.id;
    const id = clean(req.body.id, 64) || newId();
    const existing = db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ? AND deleted = 0`)
      .get(id, ownerId);
    if (existing) {
      return res.status(409).json({ error: 'already_exists', message: 'Registro já existe.' });
    }
    const now = nowIso();
    const cols = ['id', 'owner_id', ...cfg.fields, 'created_at', 'updated_at', 'version', 'deleted'];
    const values = [id, ownerId];
    for (const field of cfg.fields) {
      values.push(fieldValue(field, req.body[field], cfg.nullable));
    }
    values.push(now, now, 1, 0);
    const placeholders = cols.map(() => '?').join(',');
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...values);
    logChange(ownerId, key, id, 'upsert');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return res.status(201).json(readEntity(row));
  });

  router.put(`/${key}/:id`, requireAuth, (req, res) => {
    const ownerId = req.user.id;
    const id = req.params.id;
    const existing = db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ? AND deleted = 0`)
      .get(id, ownerId);
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'Registro não encontrado.' });
    }
    // Bloqueio otimista: o cliente informa a versão que editou.
    const clientVersion = Number(req.body.version || 0);
    if (clientVersion && clientVersion !== existing.version) {
      return res.status(409).json({
        error: 'conflict',
        message: 'Este registro foi alterado em outro dispositivo.',
        server: readEntity(existing),
      });
    }
    const sets = [];
    const values = [];
    for (const field of cfg.fields) {
      if (req.body[field] === undefined) continue;
      sets.push(`${field} = ?`);
      values.push(fieldValue(field, req.body[field], cfg.nullable));
    }
    sets.push('updated_at = ?', 'version = version + 1');
    values.push(nowIso(), id, ownerId);
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`).run(...values);
    logChange(ownerId, key, id, 'upsert');
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    return res.json(readEntity(row));
  });

  router.delete(`/${key}/:id`, requireAuth, (req, res) => {
    const ownerId = req.user.id;
    const id = req.params.id;
    const existing = db
      .prepare(`SELECT * FROM ${table} WHERE id = ? AND owner_id = ? AND deleted = 0`)
      .get(id, ownerId);
    if (!existing) {
      return res.status(404).json({ error: 'not_found', message: 'Registro não encontrado.' });
    }
    db.prepare(
      `UPDATE ${table} SET deleted = 1, updated_at = ?, version = version + 1 WHERE id = ? AND owner_id = ?`
    ).run(nowIso(), id, ownerId);
    logChange(ownerId, key, id, 'delete');
    return res.json({ ok: true, id });
  });
}

for (const [key, cfg] of Object.entries(ENTITY_CONFIG)) {
  entityRoute(key, cfg);
}

/* ------------------------------------------------------------------ */
/* Configurações                                                       */
/* ------------------------------------------------------------------ */

router.put('/settings', requireAuth, (req, res) => {
  const ownerId = req.user.id;
  const current =
    db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(ownerId) || {};
  const stageFont = Math.min(
    64,
    Math.max(12, Number(req.body.stage_font_size ?? current.stage_font_size ?? 22))
  );
  const chordColor = clean(req.body.stage_chord_color ?? current.stage_chord_color ?? '#ff3b30', 32);
  const reduceMotion = req.body.reduce_motion ?? current.reduce_motion ?? 0;
  const autoSync = req.body.auto_sync ?? current.auto_sync ?? 1;
  const theme = clean(req.body.theme ?? current.theme ?? 'dark', 20) || 'dark';

  db.prepare(
    `INSERT INTO user_settings (user_id, stage_font_size, stage_chord_color, reduce_motion, auto_sync, theme, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       stage_font_size = excluded.stage_font_size,
       stage_chord_color = excluded.stage_chord_color,
       reduce_motion = excluded.reduce_motion,
       auto_sync = excluded.auto_sync,
       theme = excluded.theme,
       updated_at = excluded.updated_at`
  ).run(
    ownerId,
    stageFont,
    chordColor,
    reduceMotion ? 1 : 0,
    autoSync ? 1 : 0,
    theme,
    nowIso()
  );
  logChange(ownerId, 'settings', ownerId, 'upsert');
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(ownerId);
  return res.json({
    stage_font_size: row.stage_font_size,
    stage_chord_color: row.stage_chord_color,
    reduce_motion: !!row.reduce_motion,
    auto_sync: !!row.auto_sync,
    theme: row.theme,
  });
});

/* ------------------------------------------------------------------ */
/* Backup export / import                                              */
/* ------------------------------------------------------------------ */

const BACKUP_VERSION = 1;

function buildBackup(ownerId) {
  const snap = snapshot(ownerId);
  return {
    format: 'frnkln-stage-backup',
    version: BACKUP_VERSION,
    exported_at: nowIso(),
    bands: snap.bands,
    songs: snap.songs,
    band_songs: snap.band_songs,
    setlists: snap.setlists,
    setlist_songs: snap.setlist_songs,
    settings: snap.settings,
  };
}

router.get('/backup', requireAuth, (req, res) => {
  const backup = buildBackup(req.user.id);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="frnkln-stage-backup-${backup.exported_at.slice(0, 10)}.json"`
  );
  return res.send(JSON.stringify(backup, null, 2));
});

function validateBackup(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') {
    return { valid: false, errors: ['Arquivo inválido: conteúdo JSON ilegível.'], data: null };
  }
  if (payload.format !== 'frnkln-stage-backup') {
    errors.push('Este arquivo não é um backup do FRNKLN STAGE.');
  }
  if (Number(payload.version) > BACKUP_VERSION) {
    errors.push(
      `Backup na versão ${payload.version} é mais recente que o app (v${BACKUP_VERSION}). Atualize o aplicativo.`
    );
  }
  const arrays = ['bands', 'songs', 'setlists', 'setlist_songs', 'band_songs'];
  for (const key of arrays) {
    if (payload[key] !== undefined && !Array.isArray(payload[key])) {
      errors.push(`Coleção "${key}" inválida.`);
    }
  }
  if (Array.isArray(payload.songs)) {
    payload.songs.forEach((s, i) => {
      if (!s || typeof s !== 'object' || !s.title) {
        errors.push(`Música na posição ${i} não possui título.`);
      }
    });
  }
  if (Array.isArray(payload.bands)) {
    payload.bands.forEach((b, i) => {
      if (!b || typeof b !== 'object' || !b.name) {
        errors.push(`Banda na posição ${i} não possui nome.`);
      }
    });
  }
  const data = {
    bands: Array.isArray(payload.bands) ? payload.bands : [],
    songs: Array.isArray(payload.songs) ? payload.songs : [],
    band_songs: Array.isArray(payload.band_songs) ? payload.band_songs : [],
    setlists: Array.isArray(payload.setlists) ? payload.setlists : [],
    setlist_songs: Array.isArray(payload.setlist_songs) ? payload.setlist_songs : [],
    settings: payload.settings && typeof payload.settings === 'object' ? payload.settings : null,
  };
  return { valid: errors.length === 0, errors, data };
}

router.post('/backup/validate', requireAuth, (req, res) => {
  const result = validateBackup(req.body && req.body.payload ? req.body.payload : req.body);
  return res.json({
    valid: result.valid,
    errors: result.errors,
    counts: result.data
      ? {
          bands: result.data.bands.length,
          songs: result.data.songs.length,
          setlists: result.data.setlists.length,
          setlist_songs: result.data.setlist_songs.length,
        }
      : null,
    format_version: BACKUP_VERSION,
  });
});

router.post('/backup/import', requireAuth, (req, res) => {
  const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
  const result = validateBackup(req.body.payload);
  if (!result.valid) {
    return res.status(400).json({ error: 'invalid_backup', message: 'Backup inválido.', errors: result.errors });
  }
  if (mode === 'replace' && req.body.confirm !== true) {
    return res
      .status(400)
      .json({ error: 'confirmation_required', message: 'A substituição exige confirmação explícita.' });
  }

  const ownerId = req.user.id;
  const data = result.data;
  const now = nowIso();
  const stats = { bands: 0, songs: 0, setlists: 0, setlist_songs: 0, band_songs: 0, skipped: 0 };

  const tx = db.transaction(() => {
    if (mode === 'replace') {
      for (const table of ['setlist_songs', 'band_songs', 'setlists', 'songs', 'bands']) {
        db.prepare(`UPDATE ${table} SET deleted = 1, updated_at = ? WHERE owner_id = ?`).run(now, ownerId);
        logChange(ownerId, table, ownerId, 'bulk_delete');
      }
    }

    const upsertBand = db.prepare(
      `INSERT INTO bands (id, owner_id, name, description, logo, created_at, updated_at, version, deleted)
       VALUES (@id, @owner_id, @name, @description, @logo, @created_at, @updated_at, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description, logo = excluded.logo,
         updated_at = excluded.updated_at, deleted = 0, version = bands.version + 1`
    );
    for (const band of data.bands) {
      const existing = db.prepare('SELECT * FROM bands WHERE id = ?').get(band.id);
      if (existing && existing.owner_id !== ownerId) {
        stats.skipped++;
        continue;
      }
      upsertBand.run({
        id: band.id,
        owner_id: ownerId,
        name: clean(band.name, 200),
        description: clean(band.description),
        logo: clean(band.logo, 300000),
        created_at: existing ? existing.created_at : clean(band.created_at) || now,
        updated_at: now,
      });
      stats.bands++;
      logChange(ownerId, 'bands', band.id, 'upsert');
    }

    const upsertSong = db.prepare(
      `INSERT INTO songs (id, owner_id, title, artist, band_id, lyrics, chords, key, capo, bpm, meter, notes, duration, created_at, updated_at, version, deleted)
       VALUES (@id, @owner_id, @title, @artist, @band_id, @lyrics, @chords, @key, @capo, @bpm, @meter, @notes, @duration, @created_at, @updated_at, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, artist = excluded.artist, band_id = excluded.band_id,
         lyrics = excluded.lyrics, chords = excluded.chords, key = excluded.key, capo = excluded.capo,
         bpm = excluded.bpm, meter = excluded.meter, notes = excluded.notes, duration = excluded.duration,
         updated_at = excluded.updated_at, deleted = 0, version = songs.version + 1`
    );
    for (const song of data.songs) {
      const existing = db.prepare('SELECT * FROM songs WHERE id = ?').get(song.id);
      if (existing && existing.owner_id !== ownerId) {
        stats.skipped++;
        continue;
      }
      upsertSong.run({
        id: song.id,
        owner_id: ownerId,
        title: clean(song.title, 300),
        artist: clean(song.artist, 300),
        band_id: song.band_id || null,
        lyrics: clean(song.lyrics, 100000),
        chords: clean(song.chords, 100000),
        key: clean(song.key, 20),
        capo: clean(song.capo, 20),
        bpm: clean(song.bpm, 20),
        meter: clean(song.meter, 20),
        notes: clean(song.notes),
        duration: num(song.duration),
        created_at: existing ? existing.created_at : clean(song.created_at) || now,
        updated_at: now,
      });
      stats.songs++;
      logChange(ownerId, 'songs', song.id, 'upsert');
    }

    const upsertSetlist = db.prepare(
      `INSERT INTO setlists (id, owner_id, name, description, band_id, notes, created_at, updated_at, version, deleted)
       VALUES (@id, @owner_id, @name, @description, @band_id, @notes, @created_at, @updated_at, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, description = excluded.description, band_id = excluded.band_id,
         notes = excluded.notes, updated_at = excluded.updated_at, deleted = 0, version = setlists.version + 1`
    );
    for (const setlist of data.setlists) {
      const existing = db.prepare('SELECT * FROM setlists WHERE id = ?').get(setlist.id);
      if (existing && existing.owner_id !== ownerId) {
        stats.skipped++;
        continue;
      }
      upsertSetlist.run({
        id: setlist.id,
        owner_id: ownerId,
        name: clean(setlist.name, 200),
        description: clean(setlist.description),
        band_id: setlist.band_id || null,
        notes: clean(setlist.notes),
        created_at: existing ? existing.created_at : clean(setlist.created_at) || now,
        updated_at: now,
      });
      stats.setlists++;
      logChange(ownerId, 'setlists', setlist.id, 'upsert');
    }

    const upsertSetlistSong = db.prepare(
      `INSERT INTO setlist_songs (id, owner_id, setlist_id, song_id, position, notes, created_at, updated_at, version, deleted)
       VALUES (@id, @owner_id, @setlist_id, @song_id, @position, @notes, @created_at, @updated_at, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         setlist_id = excluded.setlist_id, song_id = excluded.song_id, position = excluded.position,
         notes = excluded.notes, updated_at = excluded.updated_at, deleted = 0, version = setlist_songs.version + 1`
    );
    for (const item of data.setlist_songs) {
      const existing = db.prepare('SELECT * FROM setlist_songs WHERE id = ?').get(item.id);
      if (existing && existing.owner_id !== ownerId) {
        stats.skipped++;
        continue;
      }
      upsertSetlistSong.run({
        id: item.id,
        owner_id: ownerId,
        setlist_id: item.setlist_id,
        song_id: item.song_id,
        position: Number(item.position) || 0,
        notes: clean(item.notes),
        created_at: existing ? existing.created_at : clean(item.created_at) || now,
        updated_at: now,
      });
      stats.setlist_songs++;
      logChange(ownerId, 'setlist_songs', item.id, 'upsert');
    }

    const upsertBandSong = db.prepare(
      `INSERT INTO band_songs (id, owner_id, band_id, song_id, created_at, updated_at, version, deleted)
       VALUES (@id, @owner_id, @band_id, @song_id, @created_at, @updated_at, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         band_id = excluded.band_id, song_id = excluded.song_id,
         updated_at = excluded.updated_at, deleted = 0, version = band_songs.version + 1`
    );
    for (const item of data.band_songs) {
      const existing = db.prepare('SELECT * FROM band_songs WHERE id = ?').get(item.id);
      if (existing && existing.owner_id !== ownerId) {
        stats.skipped++;
        continue;
      }
      upsertBandSong.run({
        id: item.id,
        owner_id: ownerId,
        band_id: item.band_id,
        song_id: item.song_id,
        created_at: existing ? existing.created_at : clean(item.created_at) || now,
        updated_at: now,
      });
      stats.band_songs++;
      logChange(ownerId, 'band_songs', item.id, 'upsert');
    }

    if (data.settings) {
      db.prepare(
        `INSERT INTO user_settings (user_id, stage_font_size, stage_chord_color, reduce_motion, auto_sync, theme, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           stage_font_size = excluded.stage_font_size,
           stage_chord_color = excluded.stage_chord_color,
           reduce_motion = excluded.reduce_motion,
           auto_sync = excluded.auto_sync,
           theme = excluded.theme,
           updated_at = excluded.updated_at`
      ).run(
        ownerId,
        Math.min(64, Math.max(12, Number(data.settings.stage_font_size) || 22)),
        clean(data.settings.stage_chord_color, 32) || '#ff3b30',
        data.settings.reduce_motion ? 1 : 0,
        data.settings.auto_sync === false ? 0 : 1,
        clean(data.settings.theme, 20) || 'dark',
        now
      );
      logChange(ownerId, 'settings', ownerId, 'upsert');
    }
  });

  tx();

  return res.json({ ok: true, mode, stats, cursor: snapshot(ownerId).cursor });
});

module.exports = router;
