/* Testes de aceitação do FRNKLN STAGE (Testes A, B, C, E, F, G).
 * Sobe o servidor real em uma porta efêmera com banco temporário.
 * Uso: node tests/acceptance.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'frnkln-test-'));
const PORT = 4000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

async function req(method, url, { token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: TMP_DIR,
      DB_PATH: path.join(TMP_DIR, 'test.db'),
      JWT_SECRET: 'segredo-de-teste',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (/error/i.test(s)) console.error('[servidor]', s.trim());
  });
  return child;
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/auth/me');
      if (res.status === 401) return true;
    } catch (e) {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

(async function main() {
  const server = startServer();
  try {
    const up = await waitForServer();
    if (!up) throw new Error('servidor não respondeu a tempo');

    console.log('\n== Autenticação e escopo por proprietário (Teste G) ==');
    const regA = await req('POST', '/api/auth/register', {
      body: { email: 'ana@example.com', password: 'senha-segura-1', name: 'Ana' },
    });
    check('registro cria usuário e devolve token', () => {
      assert.strictEqual(regA.status, 201);
      assert.ok(regA.data.token);
      assert.strictEqual(regA.data.user.email, 'ana@example.com');
    });
    const regB = await req('POST', '/api/auth/register', {
      body: { email: 'bruno@example.com', password: 'senha-segura-2', name: 'Bruno' },
    });
    check('segundo usuário registrado', () => {
      assert.strictEqual(regB.status, 201);
      assert.notStrictEqual(regB.data.token, regA.data.token);
    });
    const dup = await req('POST', '/api/auth/register', {
      body: { email: 'ana@example.com', password: 'senha-segura-1', name: 'Ana' },
    });
    check('e-mail duplicado é rejeitado', () => {
      assert.strictEqual(dup.status, 409);
    });
    const badPwd = await req('POST', '/api/auth/login', {
      body: { email: 'ana@example.com', password: 'errada' },
    });
    check('senha incorreta é rejeitada', () => {
      assert.strictEqual(badPwd.status, 401);
    });
    const anon = await req('GET', '/api/songs');
    check('acesso sem sessão é bloqueado', () => {
      assert.strictEqual(anon.status, 401);
    });
    const badToken = await req('GET', '/api/songs', { token: 'token.invalido' });
    check('token inválido é bloqueado', () => {
      assert.strictEqual(badToken.status, 401);
    });

    const tokenA = regA.data.token;
    const tokenB = regB.data.token;

    console.log('\n== CRUD e persistência (Teste A) ==');
    const band = await req('POST', '/api/bands', {
      token: tokenA,
      body: { name: 'Banda Aurora', description: 'Rock', logo: 'data:image/png;base64,AAA' },
    });
    check('banda criada', () => {
      assert.strictEqual(band.status, 201);
      assert.ok(band.data.id);
      assert.strictEqual(band.data.name, 'Banda Aurora');
      assert.strictEqual(band.data.version, 1);
    });
    const song = await req('POST', '/api/songs', {
      token: tokenA,
      body: {
        title: 'Amanhecer',
        artist: 'Composer',
        band_id: band.data.id,
        lyrics: 'Verso 1\nRefrão',
        chords: 'C        G\nAm       F',
        key: 'C',
        capo: '2',
        bpm: '120',
        meter: '4/4',
        notes: 'entrada no refrão',
      },
    });
    check('música criada com letra, cifra e informações musicais', () => {
      assert.strictEqual(song.status, 201);
      assert.strictEqual(song.data.title, 'Amanhecer');
      assert.strictEqual(song.data.bpm, '120');
      assert.strictEqual(song.data.meter, '4/4');
    });

    // Recarrega do "servidor" (novo cliente, sem estado em memória).
    const reload = await req('GET', '/api/songs', { token: tokenA });
    check('música persiste no servidor após recarregar', () => {
      assert.strictEqual(reload.status, 200);
      assert.strictEqual(reload.data.length, 1);
      assert.strictEqual(reload.data[0].id, song.data.id);
      assert.strictEqual(reload.data[0].chords, 'C        G\nAm       F');
    });

    console.log('\n== Sincronização entre dispositivos (Teste B) ==');
    const updated = await req('PUT', `/api/songs/${song.data.id}`, {
      token: tokenA,
      body: { chords: 'D        A\nBm       G', version: song.data.version },
    });
    check('atualização de cifra aplica e versiona', () => {
      assert.strictEqual(updated.status, 200);
      assert.strictEqual(updated.data.chords, 'D        A\nBm       G');
      assert.strictEqual(updated.data.version, 2);
    });
    const syncB = await req('GET', '/api/sync?since=0', { token: tokenA });
    check('sync completo devolve o estado mais recente', () => {
      assert.strictEqual(syncB.status, 200);
      assert.strictEqual(syncB.data.full, true);
      const found = syncB.data.songs.find((s) => s.id === song.data.id);
      assert.ok(found, 'música ausente no sync');
      assert.strictEqual(found.chords, 'D        A\nBm       G');
    });
    const incremental = await req('GET', `/api/sync?since=${song.data.version && 1}`, {
      token: tokenA,
    });
    check('sync incremental devolve apenas mudanças', () => {
      assert.strictEqual(incremental.status, 200);
      assert.strictEqual(incremental.data.full, false);
      const changes = incremental.data.changes.songs.map((s) => s.id);
      assert.ok(changes.includes(song.data.id));
    });

    console.log('\n== Conflito de edição (sem sobrescrita silenciosa) ==');
    const conflict = await req('PUT', `/api/songs/${song.data.id}`, {
      token: tokenA,
      body: { chords: 'X', version: 1 },
    });
    check('gravação com versão antiga é recusada com 409', () => {
      assert.strictEqual(conflict.status, 409);
      assert.strictEqual(conflict.data.error, 'conflict');
      assert.strictEqual(conflict.data.server.chords, 'D        A\nBm       G');
    });

    console.log('\n== Setlists e ordem (Teste C) ==');
    const song2 = await req('POST', '/api/songs', {
      token: tokenA,
      body: { title: 'Brilho', artist: 'Composer', band_id: band.data.id },
    });
    const song3 = await req('POST', '/api/songs', {
      token: tokenA,
      body: { title: 'Caminho', artist: 'Composer', band_id: band.data.id },
    });
    const sl = await req('POST', '/api/setlists', {
      token: tokenA,
      body: { name: 'Show de sexta', description: 'Repertório principal', band_id: band.data.id },
    });
    check('setlist criada', () => {
      assert.strictEqual(sl.status, 201);
    });
    const items = [];
    for (const [i, s] of [song, song2, song3].entries()) {
      const it = await req('POST', '/api/setlist_songs', {
        token: tokenA,
        body: { setlist_id: sl.data.id, song_id: s.data.id, position: i },
      });
      items.push(it.data);
    }
    check('músicas adicionadas à setlist', () => {
      assert.strictEqual(items.length, 3);
      assert.ok(items.every((i) => i.id));
    });
    const slItems = await req('GET', '/api/setlist_songs', { token: tokenA });
    check('ordem da setlist preservada na releitura', () => {
      const mine = slItems.data
        .filter((i) => i.setlist_id === sl.data.id)
        .sort((a, b) => a.position - b.position);
      assert.deepStrictEqual(
        mine.map((i) => i.song_id),
        [song.data.id, song2.data.id, song3.data.id]
      );
    });
    // Reordena movendo a última para a primeira.
    const last = items[2];
    await req('PUT', `/api/setlist_songs/${last.id}`, {
      token: tokenA,
      body: { position: -1, version: last.version },
    });
    await req('PUT', `/api/setlist_songs/${items[0].id}`, {
      token: tokenA,
      body: { position: 2, version: items[0].version },
    });
    const slItems2 = await req('GET', '/api/setlist_songs', { token: tokenA });
    check('reordenação altera a ordem gravada', () => {
      const mine = slItems2.data
        .filter((i) => i.setlist_id === sl.data.id)
        .sort((a, b) => a.position - b.position);
      assert.deepStrictEqual(
        mine.map((i) => i.song_id),
        [song2.data.id, song3.data.id, song.data.id]
      );
    });
    const dupSl = await req('POST', '/api/setlists', {
      token: tokenA,
      body: { name: 'Cópia da setlist', band_id: band.data.id },
    });
    check('duplicar setlist cria nova setlist', () => {
      assert.strictEqual(dupSl.status, 201);
      assert.notStrictEqual(dupSl.data.id, sl.data.id);
    });

    console.log('\n== Isolamento entre proprietários (Teste G) ==');
    const bBands = await req('GET', '/api/bands', { token: tokenB });
    check('usuário B não vê bandas do usuário A', () => {
      assert.strictEqual(bBands.status, 200);
      assert.strictEqual(bBands.data.length, 0);
    });
    const bSongs = await req('GET', '/api/songs', { token: tokenB });
    check('usuário B não vê músicas do usuário A', () => {
      assert.strictEqual(bSongs.data.length, 0);
    });
    const crossPut = await req('PUT', `/api/songs/${song.data.id}`, {
      token: tokenB,
      body: { title: 'hackeado' },
    });
    check('usuário B não altera registro do usuário A', () => {
      assert.strictEqual(crossPut.status, 404);
    });
    const crossDel = await req('DELETE', `/api/bands/${band.data.id}`, { token: tokenB });
    check('usuário B não exclui registro do usuário A', () => {
      assert.strictEqual(crossDel.status, 404);
    });
    const aSongs = await req('GET', '/api/songs', { token: tokenA });
    check('dados do usuário A permanecem intactos', () => {
      assert.strictEqual(aSongs.data.length, 3);
    });

    console.log('\n== Backup export/import (Teste E) ==');
    const backup = await req('GET', '/api/backup', { token: tokenA });
    check('backup exporta formato versionado', () => {
      assert.strictEqual(backup.status, 200);
      assert.strictEqual(backup.data.format, 'frnkln-stage-backup');
      assert.strictEqual(backup.data.version, 1);
      assert.strictEqual(backup.data.bands.length, 1);
      assert.strictEqual(backup.data.songs.length, 3);
      assert.strictEqual(backup.data.setlists.length, 2);
      assert.strictEqual(backup.data.setlist_songs.length, 3);
      assert.ok(backup.data.exported_at);
    });
    const invalid = await req('POST', '/api/backup/validate', {
      token: tokenA,
      body: { payload: { format: 'outro-formato' } },
    });
    check('backup de formato desconhecido é invalidado', () => {
      assert.strictEqual(invalid.status, 200);
      assert.strictEqual(invalid.data.valid, false);
      assert.ok(invalid.data.errors.length > 0);
    });
    const valid = await req('POST', '/api/backup/validate', {
      token: tokenA,
      body: { payload: backup.data },
    });
    check('backup próprio é aceito na validação', () => {
      assert.strictEqual(valid.data.valid, true);
      assert.strictEqual(valid.data.counts.songs, 3);
    });
    const replaceNoConfirm = await req('POST', '/api/backup/import', {
      token: tokenA,
      body: { payload: backup.data, mode: 'replace' },
    });
    check('substituição exige confirmação explícita', () => {
      assert.strictEqual(replaceNoConfirm.status, 400);
      assert.strictEqual(replaceNoConfirm.data.error, 'confirmation_required');
    });
    // Importa o backup no usuário B (ambiente de teste) e confere relacionamentos.
    const imported = await req('POST', '/api/backup/import', {
      token: tokenB,
      body: { payload: backup.data, mode: 'merge' },
    });
    check('importação em outro usuário preserva os dados', () => {
      assert.strictEqual(imported.status, 200);
      assert.strictEqual(imported.data.ok, true);
      assert.strictEqual(imported.data.stats.bands, 1);
      assert.strictEqual(imported.data.stats.songs, 3);
      assert.strictEqual(imported.data.stats.setlists, 2);
      assert.strictEqual(imported.data.stats.setlist_songs, 3);
    });
    const bState = await req('GET', '/api/state', { token: tokenB });
    check('dados importados mantêm bandas, músicas e ordem da setlist', () => {
      assert.strictEqual(bState.data.bands.length, 1);
      assert.strictEqual(bState.data.songs.length, 3);
      const slB = bState.data.setlists.find((s) => s.id === sl.data.id);
      assert.ok(slB, 'setlist não importada');
      const order = bState.data.setlist_songs
        .filter((i) => i.setlist_id === sl.data.id)
        .sort((a, b) => a.position - b.position)
        .map((i) => i.song_id);
      assert.deepStrictEqual(order, [song2.data.id, song3.data.id, song.data.id]);
    });
    // Reimportar o mesmo backup não pode duplicar registros.
    await req('POST', '/api/backup/import', {
      token: tokenB,
      body: { payload: backup.data, mode: 'merge' },
    });
    const bState2 = await req('GET', '/api/state', { token: tokenB });
    check('reimportação não duplica registros', () => {
      assert.strictEqual(bState2.data.bands.length, 1);
      assert.strictEqual(bState2.data.songs.length, 3);
      assert.strictEqual(bState2.data.setlists.length, 2);
      assert.strictEqual(bState2.data.setlist_songs.length, 3);
    });

    console.log('\n== Exclusão com confirmação no servidor (soft delete) ==');
    const del = await req('DELETE', `/api/setlists/${dupSl.data.id}`, { token: tokenA });
    check('exclusão responde ok', () => {
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.data.ok, true);
    });
    const slAfter = await req('GET', '/api/setlists', { token: tokenA });
    check('excluído não aparece mais na listagem', () => {
      assert.strictEqual(slAfter.data.find((s) => s.id === dupSl.data.id), undefined);
    });

    console.log('\n== Configurações persistidas ==');
    const set = await req('PUT', '/api/settings', {
      token: tokenA,
      body: { stage_font_size: 34, stage_chord_color: '#ff3b30' },
    });
    check('ajustes do palco são salvos', () => {
      assert.strictEqual(set.status, 200);
      assert.strictEqual(set.data.stage_font_size, 34);
    });
    const set2 = await req('GET', '/api/state', { token: tokenA });
    check('ajustes persistem entre sessões', () => {
      assert.strictEqual(set2.data.settings.stage_font_size, 34);
    });

    console.log('\n== Conectividade / falha de rede (Teste F) ==');
    const conn = await net.connect(PORT, '127.0.0.1');
    conn.destroy();
    const down = await req('GET', '/api/state', { token: tokenA }).catch(() => ({ status: 0 }));
    check('servidor fora do ar reporta falha (sem JSON válido)', () => {
      assert.ok(down.status === 0 || down.status >= 500);
    });
    const server2 = startServer();
    const up2 = await waitForServer();
    check('servidor volta a responder após reinício', () => {
      assert.ok(up2);
    });
    const afterRestart = await req('GET', '/api/songs', { token: tokenA });
    check('dados sobrevivem ao reinício do servidor (persistência real)', () => {
      assert.strictEqual(afterRestart.status, 200);
      assert.strictEqual(afterRestart.data.length, 3);
    });
    server2.kill('SIGTERM');

    console.log('\n== Estáticos e PWA ==');
    const home = await fetch(BASE + '/');
    const homeHtml = await home.text();
    check('index.html servido', () => {
      assert.strictEqual(home.status, 200);
      assert.ok(homeHtml.includes('FRNKLN STAGE'));
      assert.ok(homeHtml.includes('/js/app.js'));
    });
    const sw = await fetch(BASE + '/sw.js');
    check('service worker servido sem cache', () => {
      assert.strictEqual(sw.status, 200);
      assert.ok(sw.headers.get('cache-control').includes('no-cache'));
    });
    const manifest = await fetch(BASE + '/manifest.webmanifest');
    check('manifest PWA válido', () => {
      assert.strictEqual(manifest.status, 200);
    });
    const icon = await fetch(BASE + '/icons/icon-192.png');
    check('ícone do PWA acessível', () => {
      assert.strictEqual(icon.status, 200);
      assert.ok(icon.headers.get('content-type').includes('image/png'));
    });
    const spa = await fetch(BASE + '/bandas/qualquer');
    check('rotas do SPA resolvem para o index', () => {
      assert.strictEqual(spa.status, 200);
    });
  } catch (err) {
    failed++;
    failures.push({ name: 'execução do suite', err });
    console.error('\nERRO FATAL:', err);
  } finally {
    server.kill('SIGTERM');
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }

  console.log(`\n${passed} verificações ok, ${failed} falhas`);
  if (failed) {
    console.log('\nFalhas:');
    failures.forEach((f) => console.log(` - ${f.name}: ${f.err.message}`));
    process.exit(1);
  }
  process.exit(0);
})();

const net = require('net');
