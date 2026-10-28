/* FRNKLN STAGE — camada de API + estado + autosave */
(function () {
  'use strict';

  const LS_TOKEN = 'fnk_token';
  const LS_STATE = 'fnk_state_v1';
  const LS_PENDING = 'fnk_pending_v1';

  /* ------------------------------------------------------------ API */
  const api = {
    token: localStorage.getItem(LS_TOKEN) || null,

    async request(method, path, body, opts) {
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (this.token) headers.Authorization = 'Bearer ' + this.token;

      let res;
      try {
        res = await fetch(path, {
          method,
          headers,
          credentials: 'same-origin',
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        const e = new Error('Falha de conexão com o servidor.');
        e.code = 'offline';
        throw e;
      }

      if (res.status === 401) {
        const e = new Error('Sessão expirada. Entre novamente.');
        e.code = 'session_expired';
        e.status = 401;
        throw e;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = null;
        }
      }
      if (!res.ok) {
        const err = new Error((data && data.message) || 'Não foi possível concluir a operação.');
        err.status = res.status;
        err.code = (data && data.error) || 'error';
        err.data = data;
        throw err;
      }
      return data;
    },

    get(p) {
      return this.request('GET', p);
    },
    post(p, b) {
      return this.request('POST', p, b);
    },
    put(p, b) {
      return this.request('PUT', p, b);
    },
    del(p) {
      return this.request('DELETE', p);
    },
  };

  /* ---------------------------------------------------------- estado */
  const state = {
    user: null,
    bands: [],
    songs: [],
    band_songs: [],
    setlists: [],
    setlist_songs: [],
    settings: {
      stage_font_size: 22,
      stage_chord_color: '#ff3b30',
      reduce_motion: false,
      auto_sync: true,
      theme: 'dark',
    },
    cursor: 0,
    loaded: false,
    sync: 'idle', // idle | syncing | synced | saving | error | offline
    lastError: null,
    conflict: null,
  };

  const pending = new Map(); // key -> {entity, id, method, body, attempts}
  let saveTimer = null;
  let syncTimer = null;
  let syncInFlight = false;

  /* ------------------------------------------------------ persistência local (cache offline) */
  function saveLocalCache() {
    try {
      localStorage.setItem(
        LS_STATE,
        JSON.stringify({
          bands: state.bands,
          songs: state.songs,
          band_songs: state.band_songs,
          setlists: state.setlists,
          setlist_songs: state.setlist_songs,
          settings: state.settings,
          cursor: state.cursor,
        })
      );
    } catch (e) {
      /* cota excedida: o servidor continua sendo a fonte da verdade */
    }
  }

  function loadLocalCache() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (!raw) return false;
      const data = JSON.parse(raw);
      Object.assign(state, data);
      return true;
    } catch (e) {
      return false;
    }
  }

  function savePendingQueue() {
    try {
      localStorage.setItem(LS_PENDING, JSON.stringify(Array.from(pending.entries())));
    } catch (e) {
      /* ignore */
    }
  }

  function loadPendingQueue() {
    try {
      const raw = localStorage.getItem(LS_PENDING);
      if (!raw) return;
      const arr = JSON.parse(raw);
      arr.forEach(([key, value]) => pending.set(key, value));
    } catch (e) {
      /* ignore */
    }
  }

  /* --------------------------------------------------------- helpers */
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function byId(list, id) {
    return list.find((x) => x.id === id) || null;
  }

  function bandSongs(bandId) {
    const ids = new Set(
      state.band_songs.filter((bs) => bs.band_id === bandId).map((bs) => bs.song_id)
    );
    return state.songs.filter((s) => ids.has(s.id));
  }

  function songBands(songId) {
    return state.band_songs
      .filter((bs) => bs.song_id === songId)
      .map((bs) => byId(state.bands, bs.band_id))
      .filter(Boolean);
  }

  function setlistItems(setlistId) {
    return state.setlist_songs
      .filter((ss) => ss.setlist_id === setlistId)
      .sort((a, b) => a.position - b.position)
      .map((ss) => ({ ...ss, song: byId(state.songs, ss.song_id) }))
      .filter((x) => x.song);
  }

  function setlistsOfBand(bandId) {
    return state.setlists.filter((sl) => sl.band_id === bandId);
  }

  /* ------------------------------------------------------- fila de autosave */
  function queueUpsert(entity, record) {
    const key = entity + ':' + record.id;
    const existing = pending.get(key);
    pending.set(key, {
      entity,
      id: record.id,
      method: existing && existing.method === 'POST' ? 'POST' : 'PUT',
      body: { ...record },
      attempts: existing ? existing.attempts : 0,
    });
    savePendingQueue();
    setSync('saving');
    scheduleSave();
  }

  function queueDelete(entity, id) {
    const key = entity + ':' + id;
    pending.set(key, { entity, id, method: 'DELETE', body: null, attempts: 0 });
    savePendingQueue();
    setSync('saving');
    scheduleSave();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushPending, 600);
  }

  async function flushPending() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!pending.size) {
      setSync('synced');
      return;
    }
    if (!api.token) return;
    setSync('saving');

    const entries = Array.from(pending.entries());
    for (const [key, item] of entries) {
      if (!pending.has(key)) continue;
      try {
        if (item.method === 'DELETE') {
          await api.del('/api/' + item.entity + '/' + item.id);
        } else if (item.method === 'POST') {
          const res = await api.post('/api/' + item.entity, item.body);
          const list = state[mapCollection(item.entity)];
          const i = list.findIndex((x) => x.id === res.id);
          if (i >= 0) list[i] = res;
          else list.push(res);
        } else {
          const res = await api.put('/api/' + item.entity + '/' + item.id, item.body);
          const list = state[mapCollection(item.entity)];
          const i = list.findIndex((x) => x.id === res.id);
          if (i >= 0) list[i] = res;
          else list.push(res);
        }
        pending.delete(key);
        savePendingQueue();
        saveLocalCache();
      } catch (err) {
        if (err.code === 'session_expired') {
          setSync('error');
          handleSessionExpired();
          return;
        }
        if (err.status === 409 && err.code === 'conflict') {
          pending.delete(key);
          savePendingQueue();
          openConflictDialog(err.data.server, item);
          continue;
        }
        item.attempts = (item.attempts || 0) + 1;
        pending.set(key, item);
        savePendingQueue();
        if (err.code === 'offline') {
          setSync('offline');
        } else {
          setSync('error');
          state.lastError = err.message;
          showToast('Falha ao salvar: ' + err.message, 'err');
        }
        return; // preserva a fila para nova tentativa
      }
    }

    if (pending.size) {
      scheduleSave();
    } else {
      setSync('synced');
    }
    saveLocalCache();
    refreshView();
  }

  function mapCollection(entity) {
    return (
      {
        bands: 'bands',
        songs: 'songs',
        band_songs: 'band_songs',
        setlists: 'setlists',
        setlist_songs: 'setlist_songs',
      }[entity] || entity
    );
  }

  /* -------------------------------------------------------- sincronização */
  async function syncNow(force) {
    if (!api.token) return;
    if (syncInFlight) return;
    if (!navigator.onLine) {
      setSync('offline');
      return;
    }
    syncInFlight = true;
    if (!force) setSync('syncing');
    try {
      const since = state.cursor || 0;
      const data = await api.get('/api/sync?since=' + since);
      if (data.full) {
        state.bands = data.bands || [];
        state.songs = data.songs || [];
        state.band_songs = data.band_songs || [];
        state.setlists = data.setlists || [];
        state.setlist_songs = data.setlist_songs || [];
        if (data.settings) state.settings = data.settings;
        state.cursor = data.cursor || 0;
      } else if (data.changes) {
        for (const key of ['bands', 'songs', 'band_songs', 'setlists', 'setlist_songs']) {
          const changes = data.changes[key] || [];
          for (const rec of changes) {
            const list = state[key];
            const i = list.findIndex((x) => x.id === rec.id);
            if (rec.deleted) {
              if (i >= 0) list.splice(i, 1);
            } else if (i >= 0) {
              list[i] = rec;
            } else {
              list.push(rec);
            }
          }
        }
        if (data.changes.settings) state.settings = data.changes.settings;
        state.cursor = data.cursor || state.cursor;
      }
      saveLocalCache();
      if (!pending.size) setSync('synced');
      refreshView();
    } catch (err) {
      if (err.code === 'session_expired') {
        handleSessionExpired();
        return;
      }
      setSync(err.code === 'offline' ? 'offline' : 'error');
      state.lastError = err.message;
    } finally {
      syncInFlight = false;
    }
  }

  function startSyncLoop() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      if (state.settings.auto_sync && api.token) syncNow(false);
    }, 12000);
  }

  /* -------------------------------------------------------------- sessão */
  function handleSessionExpired() {
    api.token = null;
    localStorage.removeItem(LS_TOKEN);
    state.user = null;
    setSync('error');
    render();
    showToast('Sessão expirada. Entre novamente para continuar.', 'err');
  }

  async function boot() {
    loadLocalCache();
    loadPendingQueue();
    applySettings();

    if (api.token) {
      try {
        const me = await api.get('/api/auth/me');
        state.user = me.user;
      } catch (err) {
        if (err.code === 'session_expired') {
          api.token = null;
          localStorage.removeItem(LS_TOKEN);
        }
      }
    }

    if (state.user) {
      await syncNow(true);
      if (pending.size) flushPending();
    }
    render();
    startSyncLoop();

    window.addEventListener('online', () => {
      setSync('syncing');
      syncNow(true).then(() => flushPending());
    });
    window.addEventListener('offline', () => setSync('offline'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.user) {
        syncNow(false);
        flushPending();
      }
    });
    window.addEventListener('beforeunload', () => {
      if (pending.size) {
        savePendingQueue();
      }
    });
  }

  /* -------------------------------------------------------------- UI base */
  const app = document.getElementById('app');
  const toastHost = document.getElementById('toast-host');
  const modalHost = document.getElementById('modal-host');

  function showToast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    toastHost.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(() => el.remove(), 320);
    }, kind === 'err' ? 4200 : 2400);
  }

  function setSync(status) {
    state.sync = status;
    const pill = document.querySelector('.sync-pill');
    if (!pill) return;
    const map = {
      idle: ['', 'Pronto'],
      syncing: ['syncing', 'Sincronizando'],
      synced: ['synced', 'Sincronizado'],
      saving: ['saving', 'Salvando'],
      error: ['error', 'Erro'],
      offline: ['error', 'Offline'],
    };
    const [cls, label] = map[status] || map.idle;
    pill.className = 'sync-pill ' + cls;
    pill.innerHTML = '<span class="dot"></span>' + esc(label);
  }

  function openModal(html, onMount) {
    modalHost.hidden = false;
    modalHost.innerHTML = '<div class="modal">' + html + '</div>';
    const close = () => {
      modalHost.hidden = true;
      modalHost.innerHTML = '';
      modalHost.onclick = null;
    };
    modalHost.onclick = (e) => {
      if (e.target === modalHost) close();
    };
    modalHost.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    if (onMount) onMount(modalHost.querySelector('.modal'), close);
    return close;
  }

  function confirmDialog(title, message, confirmLabel, onConfirm, danger) {
    openModal(
      '<h3>' +
        esc(title) +
        '</h3><p class="muted small" style="margin-top:6px">' +
        esc(message) +
        '</p><div class="modal-actions">' +
        '<button class="btn ghost" data-close>Cancelar</button>' +
        '<button class="btn ' +
        (danger ? 'danger' : 'primary') +
        '" id="confirm-yes">' +
        esc(confirmLabel || 'Confirmar') +
        '</button></div>',
      (modal, close) => {
        modal.querySelector('#confirm-yes').addEventListener('click', async () => {
          close();
          await onConfirm();
        });
      }
    );
  }

  function openConflictDialog(serverRecord, item) {
    const mine = item.body || {};
    openModal(
      '<h3>Conflito de edição</h3>' +
        '<p class="muted small" style="margin-top:6px">Este item foi alterado em outro dispositivo. Escolha qual versão manter. Nada é descartado silenciosamente.</p>' +
        '<div class="card" style="margin-top:14px"><div class="small muted">Versão no servidor (mais recente)</div><div class="mono tiny" style="white-space:pre-wrap;margin-top:6px">' +
        esc(JSON.stringify(serverRecord, null, 1).slice(0, 1200)) +
        '</div></div>' +
        '<div class="card"><div class="small muted">Sua versão (não salva)</div><div class="mono tiny" style="white-space:pre-wrap;margin-top:6px">' +
        esc(JSON.stringify(mine, null, 1).slice(0, 1200)) +
        '</div></div>' +
        '<div class="modal-actions">' +
        '<button class="btn ghost" id="conflict-mine">Manter a minha</button>' +
        '<button class="btn primary" id="conflict-server">Usar a do servidor</button>' +
        '</div>',
      (modal, close) => {
        modal.querySelector('#conflict-server').addEventListener('click', async () => {
          close();
          await syncNow(true);
          refreshView();
          showToast('Versão do servidor mantida.', 'ok');
        });
        modal.querySelector('#conflict-mine').addEventListener('click', async () => {
          close();
          const body = { ...mine, version: serverRecord.version };
          pending.set(item.entity + ':' + item.id, {
            entity: item.entity,
            id: item.id,
            method: 'PUT',
            body,
            attempts: 0,
          });
          savePendingQueue();
          flushPending();
          showToast('Sua versão foi salva por cima.', 'warn');
        });
      }
    );
  }

  /* --------------------------------------------------------- navegação */
  const NAV = [
    { id: 'home', label: 'Início', icon: '⌂' },
    { id: 'bands', label: 'Bandas', icon: '❑' },
    { id: 'songs', label: 'Músicas', icon: '♫' },
    { id: 'setlists', label: 'Setlists', icon: '☰' },
    { id: 'settings', label: 'Ajustes', icon: '⚙' },
  ];

  let currentRoute = { name: 'home', params: {} };
  const scrollMemory = {};

  function parseHash() {
    const raw = (location.hash || '#/home').replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);
    const name = parts[0] || 'home';
    const params = {};
    if (parts[1]) params.id = parts[1];
    if (parts[2]) params.sub = parts[2];
    return { name, params };
  }

  function go(name, id, sub) {
    const key = currentRoute.name + ':' + (currentRoute.params.id || '');
    scrollMemory[key] = window.scrollY;
    location.hash = '#/' + name + (id ? '/' + id : '') + (sub ? '/' + sub : '');
  }

  function refreshView() {
    render();
  }

  /* -------------------------------------------------------- renderização */
  function applySettings() {
    document.documentElement.style.setProperty(
      '--stage-chord',
      state.settings.stage_chord_color || '#ff3b30'
    );
    document.body.classList.toggle('reduce-motion', !!state.settings.reduce_motion);
  }

  function topbar(title, subtitle, actions) {
    return (
      '<header class="topbar"><h1>' +
      esc(title) +
      (subtitle ? ' <span class="sub">' + esc(subtitle) + '</span>' : '') +
      '</h1>' +
      (actions || '') +
      '<span class="sync-pill" id="sync-pill"><span class="dot"></span>Pronto</span></header>'
    );
  }

  function bottomNav() {
    return (
      '<nav class="bottomnav">' +
      NAV.map(
        (n) =>
          '<button data-nav="' +
          n.id +
          '" class="' +
          (currentRoute.name === n.id ? 'active' : '') +
          '"><span class="ic">' +
          n.icon +
          '</span>' +
          n.label +
          '</button>'
      ).join('') +
      '</nav>'
    );
  }

  function render() {
    if (!state.user) {
      renderAuth();
      return;
    }
    const route = currentRoute;
    let html = '';
    switch (route.name) {
      case 'bands':
        html = renderBands();
        break;
      case 'band':
        html = renderBandDetail(route.params.id);
        break;
      case 'songs':
        html = renderSongs();
        break;
      case 'song':
        html = renderSongDetail(route.params.id);
        break;
      case 'setlists':
        html = renderSetlists();
        break;
      case 'setlist':
        html = renderSetlistDetail(route.params.id);
        break;
      case 'settings':
        html = renderSettings();
        break;
      default:
        html = renderHome();
    }
    app.innerHTML = html + bottomNav();
    setSync(state.sync);
    bindCommon();
  }

  /* --------------------------------------------------------- tela de login */
  function renderAuth() {
    app.innerHTML =
      '<div class="auth-wrap">' +
      '<div class="auth-logo">FRNKLN<span>STAGE</span></div>' +
      '<p class="auth-tag">Repertórios, letras, cifras e setlists — sincronizados.</p>' +
      '<div class="tabs"><button id="tab-login" class="active">Entrar</button><button id="tab-register">Criar conta</button></div>' +
      '<div id="auth-form"></div>' +
      '</div>';
    const formHost = document.getElementById('auth-form');
    let mode = 'login';

    function formHtml() {
      return (
        '<div class="field"><label>E-mail</label><input type="email" id="au-email" autocomplete="email" inputmode="email" /></div>' +
        '<div class="field"><label>Senha</label><input type="password" id="au-pass" autocomplete="current-password" /></div>' +
        (mode === 'register'
          ? '<div class="field"><label>Seu nome</label><input type="text" id="au-name" autocomplete="name" /></div>'
          : '') +
        '<button class="btn primary block" id="au-submit">' +
        (mode === 'login' ? 'Entrar' : 'Criar conta e começar') +
        '</button>' +
        '<p class="tiny muted" style="margin-top:12px;text-align:center">Seus dados ficam na nuvem e são sincronizados entre iPhone e computador.</p>'
      );
    }

    function draw() {
      formHost.innerHTML = formHtml();
      document.getElementById('tab-login').classList.toggle('active', mode === 'login');
      document.getElementById('tab-register').classList.toggle('active', mode === 'register');
      document.getElementById('au-submit').addEventListener('click', submit);
    }

    async function submit() {
      const email = document.getElementById('au-email').value.trim();
      const pass = document.getElementById('au-pass').value;
      const nameEl = document.getElementById('au-name');
      const name = nameEl ? nameEl.value.trim() : '';
      const btn = document.getElementById('au-submit');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Aguarde';
      try {
        const res = await api.post('/api/auth/' + mode, { email, password: pass, name });
        api.token = res.token;
        localStorage.setItem(LS_TOKEN, res.token);
        state.user = res.user;
        await syncNow(true);
        render();
        showToast('Bem-vindo, ' + (res.user.name || res.user.email) + '!', 'ok');
      } catch (err) {
        showToast(err.message || 'Não foi possível entrar.', 'err');
        btn.disabled = false;
        btn.textContent = mode === 'login' ? 'Entrar' : 'Criar conta e começar';
      }
    }

    document.getElementById('tab-login').addEventListener('click', () => {
      mode = 'login';
      draw();
    });
    document.getElementById('tab-register').addEventListener('click', () => {
      mode = 'register';
      draw();
    });
    draw();
  }

  /* ------------------------------------------------------------- início */
  function renderHome() {
    const recentSetlists = state.setlists.slice(0, 4);
    const recentBands = state.bands.slice(0, 6);
    const empty = !state.bands.length && !state.songs.length && !state.setlists.length;

    let html =
      topbar('FRNKLN STAGE', null, '<button class="iconbtn" id="btn-refresh" title="Sincronizar agora">↻</button>');

    if (empty) {
      html +=
        '<div class="empty"><div class="big">🎸</div><h3>Seu palco está vazio</h3>' +
        '<p class="small">Comece cadastrando uma banda, uma música ou uma setlist. Tudo é salvo automaticamente na nuvem.</p>' +
        '<button class="btn primary" id="empty-band">Criar primeira banda</button></div>';
    } else {
      html +=
        '<div class="stats">' +
        '<div class="stat"><b>' + state.bands.length + '</b><span>Bandas</span></div>' +
        '<div class="stat"><b>' + state.songs.length + '</b><span>Músicas</span></div>' +
        '<div class="stat"><b>' + state.setlists.length + '</b><span>Setlists</span></div>' +
        '</div>';
    }

    html +=
      '<h2 class="section">Ações rápidas</h2><div class="quick">' +
      '<button class="btn" id="q-band"><span class="ic">❑</span>Nova banda</button>' +
      '<button class="btn" id="q-song"><span class="ic">♫</span>Nova música</button>' +
      '<button class="btn" id="q-setlist"><span class="ic">☰</span>Nova setlist</button>' +
      '</div>';

    if (recentSetlists.length) {
      html += '<h2 class="section">Setlists recentes</h2>';
      recentSetlists.forEach((sl) => {
        const count = setlistItems(sl.id).length;
        html +=
          '<div class="card tap" data-setlist="' + sl.id + '"><div class="row">' +
          '<div class="grow"><div class="title" style="font-weight:650">' + esc(sl.name) + '</div>' +
          '<div class="small muted">' + count + (count === 1 ? ' música' : ' músicas') + ' · ' + fmtDate(sl.updated_at) + '</div></div>' +
          '<span class="badge gray">Abrir</span></div></div>';
      });
    }

    if (recentBands.length) {
      html += '<h2 class="section">Bandas</h2>';
      recentBands.forEach((b) => {
        html +=
          '<div class="card tap" data-band="' + b.id + '"><div class="row">' +
          avatarHtml(b, 46) +
          '<div class="grow"><div class="title" style="font-weight:650">' + esc(b.name) + '</div>' +
          '<div class="small muted">' + bandSongs(b.id).length + ' músicas · ' + setlistsOfBand(b.id).length + ' setlists</div></div>' +
          '</div></div>';
      });
    }

    return html;
  }

  function avatarHtml(band, size) {
    if (band.logo) {
      return '<img class="avatar" style="width:' + size + 'px;height:' + size + 'px" src="' + esc(band.logo) + '" alt="" />';
    }
    const initials = (band.name || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
    return (
      '<div class="avatar ph" style="width:' +
      size +
      'px;height:' +
      size +
      'px">' +
      esc(initials) +
      '</div>'
    );
  }

  /* -------------------------------------------------------------- bandas */
  function renderBands() {
    const q = (ui.bandQuery || '').toLowerCase();
    const list = state.bands.filter((b) => (b.name + ' ' + b.description).toLowerCase().includes(q));

    let html = topbar('Bandas', list.length + (list.length === 1 ? ' banda' : ' bandas'),
      '<button class="iconbtn" id="add-band">＋</button>');
    html +=
      '<div class="searchbar"><input type="search" id="band-search" placeholder="Buscar banda…" value="' +
      esc(ui.bandQuery || '') +
      '" /></div>';

    if (!state.bands.length) {
      html +=
        '<div class="empty"><div class="big">❑</div><h3>Nenhuma banda ainda</h3>' +
        '<p class="small">Cadastre seus projetos musicais para organizar músicas e setlists.</p>' +
        '<button class="btn primary" id="empty-band2">Criar banda</button></div>';
    } else if (!list.length) {
      html += '<div class="empty"><h3>Nada encontrado</h3><p class="small">Tente outro termo de busca.</p></div>';
    } else {
      list.forEach((b) => {
        html +=
          '<div class="card tap" data-band="' + b.id + '"><div class="row">' +
          avatarHtml(b, 46) +
          '<div class="grow"><div class="title" style="font-weight:650">' + esc(b.name) + '</div>' +
          '<div class="small muted truncate2">' + esc(b.description || 'Sem descrição') + '</div>' +
          '<div class="tiny muted" style="margin-top:4px">Atualizada em ' + fmtDate(b.updated_at) + '</div></div>' +
          '</div></div>';
      });
    }
    return html;
  }

  function renderBandDetail(id) {
    const b = byId(state.bands, id);
    if (!b) {
      return topbar('Banda') + '<div class="empty"><h3>Banda não encontrada</h3></div>';
    }
    const songs = bandSongs(id);
    const lists = setlistsOfBand(id);

    let html = topbar(
      b.name,
      songs.length + (songs.length === 1 ? ' música' : ' músicas'),
      '<button class="iconbtn" id="band-edit">✎</button>'
    );

    html +=
      '<div class="card"><div class="row">' +
      avatarHtml(b, 72) +
      '<div class="grow"><h3>' + esc(b.name) + '</h3>' +
      '<p class="small muted">' + esc(b.description || 'Sem descrição') + '</p>' +
      '<p class="tiny muted" style="margin-top:6px">Criada em ' + fmtDate(b.created_at) + ' · atualizada em ' + fmtDate(b.updated_at) + '</p>' +
      '</div></div></div>';

    html +=
      '<div class="row" style="gap:10px;margin-bottom:6px">' +
      '<button class="btn sm grow" id="band-add-song">＋ Música</button>' +
      '<button class="btn sm grow" id="band-add-setlist">＋ Setlist</button>' +
      '</div>';

    html += '<h2 class="section">Repertório</h2>';
    if (!songs.length) {
      html += '<div class="empty"><h3>Repertório vazio</h3><p class="small">Adicione músicas a esta banda.</p></div>';
    } else {
      songs.forEach((s) => {
        html +=
          '<div class="list-item" data-song="' + s.id + '"><div class="grow"><div class="title">' + esc(s.title) + '</div>' +
          '<div class="meta">' + esc(s.artist || '—') + (s.key ? ' · ' + esc(s.key) : '') + '</div></div>' +
          '<span class="badge gray">›</span></div>';
      });
    }

    if (lists.length) {
      html += '<h2 class="section">Setlists</h2>';
      lists.forEach((sl) => {
        html +=
          '<div class="list-item" data-setlist="' + sl.id + '"><div class="grow"><div class="title">' + esc(sl.name) + '</div>' +
          '<div class="meta">' + setlistItems(sl.id).length + ' músicas</div></div><span class="badge gray">›</span></div>';
      });
    }

    html +=
      '<div class="divider"></div>' +
      '<button class="btn danger block" id="band-delete">Excluir banda</button>' +
      '<p class="tiny muted" style="margin-top:10px;text-align:center">Músicas e setlists não são apagados: apenas o vínculo com esta banda.</p>';
    return html;
  }

  /* ------------------------------------------------------------- músicas */
  function renderSongs() {
    const q = (ui.songQuery || '').toLowerCase();
    const bandFilter = ui.songBandFilter || '';
    let list = state.songs.filter((s) => {
      const band = byId(state.bands, s.band_id);
      const hay = (s.title + ' ' + s.artist + ' ' + (band ? band.name : '')).toLowerCase();
      return hay.includes(q);
    });
    if (bandFilter) list = list.filter((s) => s.band_id === bandFilter);

    let html = topbar('Músicas', list.length + (list.length === 1 ? ' música' : ' músicas'),
      '<button class="iconbtn" id="add-song">＋</button>');
    html +=
      '<div class="searchbar"><input type="search" id="song-search" placeholder="Buscar por título, artista ou banda…" value="' +
      esc(ui.songQuery || '') +
      '" /></div>';

    if (state.bands.length) {
      html += '<div class="chips">';
      html += '<button class="chip ' + (bandFilter ? '' : 'active') + '" data-bandfilter="">Todas</button>';
      state.bands.forEach((b) => {
        html +=
          '<button class="chip ' + (bandFilter === b.id ? 'active' : '') + '" data-bandfilter="' + b.id + '">' +
          esc(b.name) + '</button>';
      });
      html += '</div>';
    }

    if (!state.songs.length) {
      html +=
        '<div class="empty"><div class="big">♫</div><h3>Nenhuma música cadastrada</h3>' +
        '<p class="small">Adicione músicas com letra, cifra e informações musicais.</p>' +
        '<button class="btn primary" id="empty-song">Cadastrar música</button></div>';
    } else if (!list.length) {
      html += '<div class="empty"><h3>Nada encontrado</h3><p class="small">Ajuste a busca ou o filtro de banda.</p></div>';
    } else {
      list.forEach((s) => {
        const band = byId(state.bands, s.band_id);
        html +=
          '<div class="list-item" data-song="' + s.id + '"><div class="grow">' +
          '<div class="title">' + esc(s.title) + '</div>' +
          '<div class="meta">' + esc(s.artist || '—') + '</div>' +
          '<div class="tiny muted" style="margin-top:3px">' +
          (band ? esc(band.name) : 'Sem banda') +
          (s.key ? ' · ' + esc(s.key) : '') +
          (s.capo ? ' · capo ' + esc(s.capo) : '') +
          (s.bpm ? ' · ' + esc(s.bpm) + ' BPM' : '') +
          (s.meter ? ' · ' + esc(s.meter) : '') +
          '</div></div><span class="badge gray">›</span></div>';
      });
    }
    return html;
  }

  function renderSongDetail(id) {
    const s = byId(state.songs, id);
    if (!s) {
      return topbar('Música') + '<div class="empty"><h3>Música não encontrada</h3></div>';
    }
    const bands = songBands(s.id);

    let html = topbar(
      s.title,
      s.artist || '',
      '<button class="iconbtn" id="song-stage">▶</button>'
    );

    html +=
      '<div class="card">' +
      '<div class="field"><label>Título</label><input type="text" id="f-title" value="' + esc(s.title) + '" /></div>' +
      '<div class="field"><label>Artista / compositor</label><input type="text" id="f-artist" value="' + esc(s.artist) + '" /></div>' +
      '<div class="field"><label>Banda</label><select id="f-band"><option value="">— sem banda —</option>' +
      state.bands.map((b) => '<option value="' + b.id + '" ' + (s.band_id === b.id ? 'selected' : '') + '>' + esc(b.name) + '</option>').join('') +
      '</select></div>' +
      '<div class="grid3">' +
      '<div class="field"><label>Tom</label><input type="text" id="f-key" value="' + esc(s.key) + '" placeholder="C" /></div>' +
      '<div class="field"><label>Capo</label><input type="text" id="f-capo" value="' + esc(s.capo) + '" placeholder="2" /></div>' +
      '<div class="field"><label>BPM</label><input type="text" id="f-bpm" value="' + esc(s.bpm) + '" placeholder="120" /></div>' +
      '</div>' +
      '<div class="grid2">' +
      '<div class="field"><label>Compasso</label><input type="text" id="f-meter" value="' + esc(s.meter) + '" placeholder="4/4" /></div>' +
      '<div class="field"><label>Duração (seg)</label><input type="number" id="f-duration" value="' + (s.duration != null ? s.duration : '') + '" placeholder="210" /></div>' +
      '</div>' +
      '</div>';

    html +=
      '<h2 class="section">Cifra</h2>' +
      '<div class="card"><div class="field" style="margin-bottom:0"><textarea class="mono" id="f-chords" rows="6" placeholder="C        G&#10;Am       F">' +
      esc(s.chords) +
      '</textarea></div>' +
      '<p class="tiny muted" style="margin-top:8px">Escreva os acordes alinhados às colunas da letra.</p></div>';

    html +=
      '<h2 class="section">Letra</h2>' +
      '<div class="card"><div class="field" style="margin-bottom:0"><textarea class="mono" id="f-lyrics" rows="10" placeholder="Verso 1&#10;...">' +
      esc(s.lyrics) +
      '</textarea></div></div>';

    html +=
      '<h2 class="section">Observações</h2>' +
      '<div class="card"><div class="field" style="margin-bottom:0"><textarea id="f-notes" rows="3">' +
      esc(s.notes) +
      '</textarea></div></div>';

    html +=
      '<div class="card"><div class="small muted">Vínculos</div>' +
      '<div class="row wrap" style="margin-top:8px;gap:8px">' +
      (bands.length
        ? bands.map((b) => '<span class="badge">' + esc(b.name) + '</span>').join('')
        : '<span class="tiny muted">Nenhuma banda associada</span>') +
      '</div></div>';

    html +=
      '<div class="row" style="gap:10px;margin-top:4px">' +
      '<button class="btn grow" id="song-associate">Associar banda</button>' +
      '<button class="btn danger" id="song-delete">Excluir</button>' +
      '</div>';
    return html;
  }

  /* ------------------------------------------------------------ setlists */
  function renderSetlists() {
    const q = (ui.setlistQuery || '').toLowerCase();
    const list = state.setlists.filter((sl) => sl.name.toLowerCase().includes(q));

    let html = topbar('Setlists', list.length + (list.length === 1 ? ' setlist' : ' setlists'),
      '<button class="iconbtn" id="add-setlist">＋</button>');
    html +=
      '<div class="searchbar"><input type="search" id="setlist-search" placeholder="Buscar setlist…" value="' +
      esc(ui.setlistQuery || '') +
      '" /></div>';

    if (!state.setlists.length) {
      html +=
        '<div class="empty"><div class="big">☰</div><h3>Nenhuma setlist ainda</h3>' +
        '<p class="small">Monte a ordem das músicas para ensaios, shows e eventos.</p>' +
        '<button class="btn primary" id="empty-setlist">Criar setlist</button></div>';
    } else if (!list.length) {
      html += '<div class="empty"><h3>Nada encontrado</h3></div>';
    } else {
      list.forEach((sl) => {
        const items = setlistItems(sl.id);
        const band = byId(state.bands, sl.band_id);
        html +=
          '<div class="card tap" data-setlist="' + sl.id + '"><div class="row between">' +
          '<div class="grow"><div class="title" style="font-weight:650">' + esc(sl.name) + '</div>' +
          '<div class="small muted">' + (band ? esc(band.name) + ' · ' : '') + items.length + (items.length === 1 ? ' música' : ' músicas') + '</div>' +
          '<div class="tiny muted" style="margin-top:4px">' + esc(sl.description || '') + '</div></div>' +
          '<span class="badge gray">›</span></div></div>';
      });
    }
    return html;
  }

  function renderSetlistDetail(id) {
    const sl = byId(state.setlists, id);
    if (!sl) {
      return topbar('Setlist') + '<div class="empty"><h3>Setlist não encontrada</h3></div>';
    }
    const items = setlistItems(sl.id);
    const band = byId(state.bands, sl.band_id);
    const totalSec = items.reduce((acc, it) => acc + (it.song.duration || 0), 0);

    let html = topbar(
      sl.name,
      items.length + (items.length === 1 ? ' música' : ' músicas'),
      '<button class="iconbtn" id="setlist-stage">▶</button>'
    );

    html +=
      '<div class="card"><div class="row between">' +
      '<div class="grow"><h3>' + esc(sl.name) + '</h3>' +
      '<p class="small muted">' + esc(sl.description || 'Sem descrição') + '</p>' +
      '<p class="tiny muted" style="margin-top:6px">' +
      (band ? esc(band.name) : 'Sem banda') +
      ' · atualizada em ' + fmtDate(sl.updated_at) +
      (totalSec ? ' · duração estimada ' + fmtDuration(totalSec) : '') +
      '</p></div></div></div>';

    html +=
      '<div class="row" style="gap:10px;margin-bottom:8px">' +
      '<button class="btn sm grow" id="setlist-add">＋ Músicas</button>' +
      '<button class="btn sm grow" id="setlist-edit">Editar</button>' +
      '<button class="btn sm grow" id="setlist-dup">Duplicar</button>' +
      '</div>';

    html += '<h2 class="section">Ordem</h2>';
    if (!items.length) {
      html += '<div class="empty"><h3>Setlist vazia</h3><p class="small">Adicione músicas do seu catálogo.</p></div>';
    } else {
      items.forEach((it, i) => {
        html +=
          '<div class="list-item" draggable="true" data-sl-item="' + it.id + '" data-index="' + i + '">' +
          '<div class="idx">' + (i + 1) + '</div>' +
          '<div class="grow" data-song="' + it.song.id + '"><div class="title">' + esc(it.song.title) + '</div>' +
          '<div class="meta">' + esc(it.song.artist || '—') + (it.song.key ? ' · ' + esc(it.song.key) : '') + '</div></div>' +
          '<div class="reorder"><button data-move="up" data-id="' + it.id + '" ' + (i === 0 ? 'disabled' : '') + '>▲</button>' +
          '<button data-move="down" data-id="' + it.id + '" ' + (i === items.length - 1 ? 'disabled' : '') + '>▼</button></div>' +
          '<button class="iconbtn" data-remove="' + it.id + '" title="Remover da setlist">✕</button>' +
          '</div>';
      });
      html += '<p class="tiny muted" style="margin-top:8px">Arraste os itens ou use as setas para reordenar. A ordem é salva automaticamente.</p>';
    }

    html +=
      '<div class="divider"></div>' +
      '<button class="btn danger block" id="setlist-delete">Excluir setlist</button>';
    return html;
  }

  /* ------------------------------------------------------------- ajustes */
  function renderSettings() {
    const s = state.settings;
    let html = topbar('Ajustes');

    html +=
      '<div class="card"><div class="setting-row"><div class="grow"><div>Conta</div>' +
      '<div class="tiny muted">' + esc(state.user.email) + '</div></div>' +
      '<button class="btn sm" id="logout">Sair</button></div>' +
      '<div class="setting-row"><div class="grow"><div>Sincronização automática</div>' +
      '<div class="tiny muted">Atualiza os dados entre dispositivos periodicamente.</div></div>' +
      '<div class="switch ' + (s.auto_sync ? 'on' : '') + '" id="set-autosync"></div></div>' +
      '</div>';

    html +=
      '<h2 class="section">Palco</h2><div class="card">' +
      '<div class="setting-row"><div class="grow"><div>Tamanho da fonte</div>' +
      '<div class="tiny muted">Aplicado no modo palco e nas letras.</div></div>' +
      '<b id="font-value">' + s.stage_font_size + '</b></div>' +
      '<input type="range" id="set-font" min="14" max="48" step="1" value="' + s.stage_font_size + '" />' +
      '<div class="setting-row"><div class="grow"><div>Cor dos acordes</div></div>' +
      '<input type="color" id="set-chord" value="' + esc(s.stage_chord_color) + '" style="width:44px;height:32px;border:0;background:none" />' +
      '</div>' +
      '<div class="setting-row"><div class="grow"><div>Reduzir animações</div></div>' +
      '<div class="switch ' + (s.reduce_motion ? 'on' : '') + '" id="set-motion"></div></div>' +
      '</div>';

    html +=
      '<h2 class="section">Backup</h2><div class="card">' +
      '<p class="small muted" style="margin-bottom:12px">O backup é uma rede de segurança complementar à sincronização automática.</p>' +
      '<button class="btn block" id="backup-export" style="margin-bottom:10px">Exportar backup JSON</button>' +
      '<button class="btn block" id="backup-import">Importar backup JSON</button>' +
      '<input type="file" id="backup-file" accept="application/json,.json" class="hidden" />' +
      '</div>';

    html +=
      '<h2 class="section">Sobre</h2><div class="card">' +
      '<div class="row between"><span class="small muted">Versão do app</span><span class="small">' + esc(APP_VERSION) + '</span></div>' +
      '<div class="row between" style="margin-top:8px"><span class="small muted">Última sincronização</span><span class="small">' + esc(state.lastSyncAt ? fmtTime(state.lastSyncAt) : '—') + '</span></div>' +
      '<div class="row between" style="margin-top:8px"><span class="small muted">Armazenamento</span><span class="small">Nuvem (SQLite no servidor)</span></div>' +
      '</div>';

    html +=
      '<button class="btn danger block" id="reset-cache" style="margin-top:8px">Limpar cache local</button>';
    return html;
  }

  /* -------------------------------------------------------------- palco */
  function openStage(setlistId, startIndex) {
    const sl = byId(state.setlists, setlistId);
    if (!sl) return;
    const items = setlistItems(sl.id);
    if (!items.length) {
      showToast('Esta setlist não tem músicas.', 'warn');
      return;
    }
    let idx = Math.max(0, Math.min(items.length - 1, startIndex || 0));

    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.innerHTML =
      '<div class="stage-top">' +
      '<button class="iconbtn" id="stage-close">✕</button>' +
      '<div class="t">' + esc(sl.name) + '</div>' +
      '<span class="badge gray" id="stage-pos"></span>' +
      '</div>' +
      '<div class="stage-body" id="stage-body"></div>' +
      '<div class="stage-bottom">' +
      '<button class="navbtn" id="stage-prev">◀</button>' +
      '<button class="navbtn primary" id="stage-next">▶</button>' +
      '</div>';
    document.body.appendChild(stage);

    function draw() {
      const it = items[idx];
      const song = it.song;
      stage.querySelector('#stage-pos').textContent = idx + 1 + '/' + items.length;
      const body = stage.querySelector('#stage-body');
      body.innerHTML = sheetHtml(song);
      body.scrollTop = 0;
      const fs = state.settings.stage_font_size || 22;
      body.style.fontSize = fs + 'px';
      body.style.setProperty('--stage-chord', state.settings.stage_chord_color || '#ff3b30');
    }

    stage.querySelector('#stage-close').addEventListener('click', () => stage.remove());
    stage.querySelector('#stage-prev').addEventListener('click', () => {
      idx = (idx - 1 + items.length) % items.length;
      draw();
    });
    stage.querySelector('#stage-next').addEventListener('click', () => {
      idx = (idx + 1) % items.length;
      draw();
    });
    draw();
  }

  /** Monta a folha de letra/cifra preservando o alinhamento coluna a coluna. */
  function sheetHtml(song) {
    const chords = (song.chords || '').split('\n');
    const lyrics = (song.lyrics || '').split('\n');
    const lines = Math.max(chords.length, lyrics.length);
    let out = '<div class="song-sheet">';
    for (let i = 0; i < lines; i++) {
      const c = chords[i] === undefined ? '' : chords[i];
      const l = lyrics[i] === undefined ? '' : lyrics[i];
      if (!c.trim() && !l.trim()) {
        out += '<div class="gap"></div>';
        continue;
      }
      out += '<div class="chord-line">' + esc(c) + '</div>';
      out += '<div class="lyric-line">' + esc(l) + '</div>';
    }
    out += '</div>';
    if (song.notes) {
      out +=
        '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #222228;font-size:.6em;color:#9a9aa4;white-space:pre-wrap">' +
        esc(song.notes) +
        '</div>';
    }
    return out;
  }

  /* ---------------------------------------------------------- utilitários */
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtDuration(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'min';
  }

  /* ------------------------------------------------------ estado da UI */
  const ui = {
    bandQuery: '',
    songQuery: '',
    setlistQuery: '',
    songBandFilter: '',
  };

  /* --------------------------------------------------------------- ações */
  const actions = {
    async createBand() {
      openModal(
        '<h3>Nova banda</h3><p class="muted small" style="margin-top:4px">Dê um nome ao seu projeto musical.</p>' +
          '<div class="field" style="margin-top:14px"><label>Nome</label><input type="text" id="nb-name" placeholder="Ex.: FRNKLN" /></div>' +
          '<div class="field"><label>Descrição (opcional)</label><input type="text" id="nb-desc" placeholder="Estilo, integrantes…" /></div>' +
          '<div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button>' +
          '<button class="btn primary" id="nb-save">Criar</button></div>',
        (modal, close) => {
          modal.querySelector('#nb-name').focus();
          modal.querySelector('#nb-save').addEventListener('click', async () => {
            const name = modal.querySelector('#nb-name').value.trim();
            if (!name) {
              showToast('Informe o nome da banda.', 'warn');
              return;
            }
            const rec = {
              id: uid(),
              name,
              description: modal.querySelector('#nb-desc').value.trim(),
              logo: '',
              created_at: nowIso(),
              updated_at: nowIso(),
              version: 0,
            };
            state.bands.push(rec);
            queueUpsert('bands', rec);
            close();
            render();
            showToast('Banda criada.', 'ok');
          });
        }
      );
    },

    async editBand(band) {
      openModal(
        '<h3>Editar banda</h3>' +
          '<div class="field" style="margin-top:14px"><label>Nome</label><input type="text" id="eb-name" value="' + esc(band.name) + '" /></div>' +
          '<div class="field"><label>Descrição</label><input type="text" id="eb-desc" value="' + esc(band.description) + '" /></div>' +
          '<div class="field"><label>Logotipo</label><input type="file" id="eb-logo" accept="image/*" />' +
          '<p class="tiny muted" style="margin-top:6px">Imagem quadrada recomendada. Guardada na nuvem junto da banda.</p></div>' +
          (band.logo ? '<button class="btn sm danger" id="eb-logo-rm">Remover logotipo</button>' : '') +
          '<div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button>' +
          '<button class="btn primary" id="eb-save">Salvar</button></div>',
        (modal, close) => {
          const logoInput = modal.querySelector('#eb-logo');
          let logo = band.logo;
          logoInput.addEventListener('change', () => {
            const file = logoInput.files && logoInput.files[0];
            if (!file) return;
            if (file.size > 900000) {
              showToast('Escolha uma imagem menor que 900 KB.', 'warn');
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              logo = reader.result;
            };
            reader.readAsDataURL(file);
          });
          const rm = modal.querySelector('#eb-logo-rm');
          if (rm)
            rm.addEventListener('click', () => {
              logo = '';
              rm.remove();
            });
          modal.querySelector('#eb-save').addEventListener('click', () => {
            const rec = {
              ...band,
              name: modal.querySelector('#eb-name').value.trim() || band.name,
              description: modal.querySelector('#eb-desc').value.trim(),
              logo,
              updated_at: nowIso(),
            };
            const i = state.bands.findIndex((b) => b.id === band.id);
            state.bands[i] = rec;
            queueUpsert('bands', rec);
            close();
            render();
            showToast('Banda atualizada.', 'ok');
          });
        }
      );
    },

    async deleteBand(band) {
      const songs = bandSongs(band.id);
      const lists = setlistsOfBand(band.id);
      confirmDialog(
        'Excluir banda "' + band.name + '"?',
        songs.length + ' música(s) e ' + lists.length + ' setlist(s) continuam existindo. Apenas o vínculo com a banda será removido — nada é apagado sem sua confirmação.',
        'Excluir banda',
        async () => {
          // remove vínculos band_songs
          state.band_songs
            .filter((bs) => bs.band_id === band.id)
            .forEach((bs) => {
              queueDelete('band_songs', bs.id);
              const i = state.band_songs.findIndex((x) => x.id === bs.id);
              if (i >= 0) state.band_songs.splice(i, 1);
            });
          state.songs.forEach((s) => {
            if (s.band_id === band.id) {
              const rec = { ...s, band_id: null, updated_at: nowIso() };
              state.songs[state.songs.findIndex((x) => x.id === s.id)] = rec;
              queueUpsert('songs', rec);
            }
          });
          state.setlists.forEach((sl) => {
            if (sl.band_id === band.id) {
              const rec = { ...sl, band_id: null, updated_at: nowIso() };
              state.setlists[state.setlists.findIndex((x) => x.id === sl.id)] = rec;
              queueUpsert('setlists', rec);
            }
          });
          const i = state.bands.findIndex((b) => b.id === band.id);
          state.bands.splice(i, 1);
          queueDelete('bands', band.id);
          saveLocalCache();
          go('bands');
          render();
          showToast('Banda excluída. Músicas e setlists foram preservados.', 'ok');
        },
        true
      );
    },

    async createSong(bandId) {
      const rec = {
        id: uid(),
        title: 'Nova música',
        artist: '',
        band_id: bandId || '',
        lyrics: '',
        chords: '',
        key: '',
        capo: '',
        bpm: '',
        meter: '',
        notes: '',
        duration: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        version: 0,
      };
      state.songs.push(rec);
      queueUpsert('songs', rec);
      saveLocalCache();
      go('song', rec.id);
      render();
    },

    async deleteSong(song) {
      confirmDialog(
        'Excluir "' + song.title + '"?',
        'A música será removida de todos os catálogos e setlists. Esta ação não pode ser desfeita.',
        'Excluir música',
        async () => {
          state.band_songs
            .filter((bs) => bs.song_id === song.id)
            .forEach((bs) => {
              queueDelete('band_songs', bs.id);
              const i = state.band_songs.findIndex((x) => x.id === bs.id);
              if (i >= 0) state.band_songs.splice(i, 1);
            });
          state.setlist_songs
            .filter((ss) => ss.song_id === song.id)
            .forEach((ss) => {
              queueDelete('setlist_songs', ss.id);
              const i = state.setlist_songs.findIndex((x) => x.id === ss.id);
              if (i >= 0) state.setlist_songs.splice(i, 1);
            });
          const i = state.songs.findIndex((s) => s.id === song.id);
          state.songs.splice(i, 1);
          queueDelete('songs', song.id);
          saveLocalCache();
          go('songs');
          render();
          showToast('Música excluída.', 'ok');
        },
        true
      );
    },

    async createSetlist(bandId) {
      const rec = {
        id: uid(),
        name: 'Nova setlist',
        description: '',
        band_id: bandId || '',
        notes: '',
        created_at: nowIso(),
        updated_at: nowIso(),
        version: 0,
      };
      state.setlists.push(rec);
      queueUpsert('setlists', rec);
      saveLocalCache();
      go('setlist', rec.id);
      render();
    },

    async editSetlist(sl) {
      openModal(
        '<h3>Editar setlist</h3>' +
          '<div class="field" style="margin-top:14px"><label>Nome</label><input type="text" id="es-name" value="' + esc(sl.name) + '" /></div>' +
          '<div class="field"><label>Descrição</label><input type="text" id="es-desc" value="' + esc(sl.description) + '" /></div>' +
          '<div class="field"><label>Banda</label><select id="es-band"><option value="">— sem banda —</option>' +
          state.bands.map((b) => '<option value="' + b.id + '" ' + (sl.band_id === b.id ? 'selected' : '') + '>' + esc(b.name) + '</option>').join('') +
          '</select></div>' +
          '<div class="field"><label>Observações gerais</label><textarea id="es-notes" rows="3">' + esc(sl.notes) + '</textarea></div>' +
          '<div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button>' +
          '<button class="btn primary" id="es-save">Salvar</button></div>',
        (modal, close) => {
          modal.querySelector('#es-save').addEventListener('click', () => {
            const rec = {
              ...sl,
              name: modal.querySelector('#es-name').value.trim() || sl.name,
              description: modal.querySelector('#es-desc').value.trim(),
              band_id: modal.querySelector('#es-band').value,
              notes: modal.querySelector('#es-notes').value,
              updated_at: nowIso(),
            };
            state.setlists[state.setlists.findIndex((x) => x.id === sl.id)] = rec;
            queueUpsert('setlists', rec);
            close();
            render();
            showToast('Setlist atualizada.', 'ok');
          });
        }
      );
    },

    async duplicateSetlist(sl) {
      const newId = uid();
      const rec = {
        id: newId,
        name: sl.name + ' (cópia)',
        description: sl.description,
        band_id: sl.band_id,
        notes: sl.notes,
        created_at: nowIso(),
        updated_at: nowIso(),
        version: 0,
      };
      state.setlists.push(rec);
      queueUpsert('setlists', rec);
      const items = setlistItems(sl.id);
      items.forEach((it, i) => {
        const item = {
          id: uid(),
          setlist_id: newId,
          song_id: it.song_id,
          position: i,
          notes: it.notes,
          created_at: nowIso(),
          updated_at: nowIso(),
          version: 0,
        };
        state.setlist_songs.push(item);
        queueUpsert('setlist_songs', item);
      });
      saveLocalCache();
      go('setlist', newId);
      render();
      showToast('Setlist duplicada.', 'ok');
    },

    async deleteSetlist(sl) {
      confirmDialog(
        'Excluir "' + sl.name + '"?',
        'A setlist será removida. As músicas continuam no seu catálogo.',
        'Excluir setlist',
        async () => {
          state.setlist_songs
            .filter((ss) => ss.setlist_id === sl.id)
            .forEach((ss) => {
              queueDelete('setlist_songs', ss.id);
              const i = state.setlist_songs.findIndex((x) => x.id === ss.id);
              if (i >= 0) state.setlist_songs.splice(i, 1);
            });
          const i = state.setlists.findIndex((x) => x.id === sl.id);
          state.setlists.splice(i, 1);
          queueDelete('setlists', sl.id);
          saveLocalCache();
          go('setlists');
          render();
          showToast('Setlist excluída.', 'ok');
        },
        true
      );
    },

    async addSongsToSetlist(sl) {
      if (!state.songs.length) {
        showToast('Cadastre músicas primeiro.', 'warn');
        return;
      }
      const existing = new Set(state.setlist_songs.filter((ss) => ss.setlist_id === sl.id).map((ss) => ss.song_id));
      const options = state.songs.filter((s) => !existing.has(s.id));
      if (!options.length) {
        showToast('Todas as músicas já estão nesta setlist.', 'ok');
        return;
      }
      openModal(
        '<h3>Adicionar músicas</h3><p class="muted small" style="margin-top:4px">Escolha as músicas que entram na setlist.</p>' +
          '<div style="margin-top:12px">' +
          options
            .map(
              (s) =>
                '<label class="list-item" style="cursor:pointer"><input type="checkbox" value="' +
                s.id +
                '" style="width:20px;height:20px" /><div class="grow"><div class="title">' +
                esc(s.title) +
                '</div><div class="meta">' +
                esc(s.artist || '—') +
                '</div></div></label>'
            )
            .join('') +
          '</div>' +
          '<div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button>' +
          '<button class="btn primary" id="as-add">Adicionar</button></div>',
        (modal, close) => {
          modal.querySelector('#as-add').addEventListener('click', () => {
            const checked = Array.from(modal.querySelectorAll('input[type=checkbox]:checked')).map(
              (c) => c.value
            );
            let position = state.setlist_songs.filter((ss) => ss.setlist_id === sl.id).length;
            checked.forEach((songId) => {
              const item = {
                id: uid(),
                setlist_id: sl.id,
                song_id: songId,
                position: position++,
                notes: '',
                created_at: nowIso(),
                updated_at: nowIso(),
                version: 0,
              };
              state.setlist_songs.push(item);
              queueUpsert('setlist_songs', item);
            });
            const rec = { ...sl, updated_at: nowIso() };
            state.setlists[state.setlists.findIndex((x) => x.id === sl.id)] = rec;
            queueUpsert('setlists', rec);
            saveLocalCache();
            close();
            render();
            showToast(checked.length + ' música(s) adicionadas.', 'ok');
          });
        }
      );
    },

    async associateSongBand(song) {
      const current = new Set(songBands(song.id).map((b) => b.id));
      openModal(
        '<h3>Bandas de "' + esc(song.title) + '"</h3>' +
          '<div style="margin-top:12px">' +
          (state.bands.length
            ? state.bands
                .map(
                  (b) =>
                    '<label class="list-item" style="cursor:pointer"><input type="checkbox" value="' +
                    b.id +
                    '" ' +
                    (current.has(b.id) ? 'checked' : '') +
                    ' style="width:20px;height:20px" /><div class="grow"><div class="title">' +
                    esc(b.name) +
                    '</div></div></label>'
                )
                .join('')
            : '<p class="small muted">Cadastre uma banda primeiro.</p>') +
          '</div>' +
          '<div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button>' +
          '<button class="btn primary" id="ab-save">Salvar</button></div>',
        (modal, close) => {
          modal.querySelector('#ab-save').addEventListener('click', () => {
            const wanted = Array.from(modal.querySelectorAll('input[type=checkbox]:checked')).map(
              (c) => c.value
            );
            state.band_songs
              .filter((bs) => bs.song_id === song.id && !wanted.includes(bs.band_id))
              .forEach((bs) => {
                queueDelete('band_songs', bs.id);
                const i = state.band_songs.findIndex((x) => x.id === bs.id);
                if (i >= 0) state.band_songs.splice(i, 1);
              });
            wanted.forEach((bandId) => {
              if (state.band_songs.some((bs) => bs.song_id === song.id && bs.band_id === bandId)) return;
              const link = {
                id: uid(),
                band_id: bandId,
                song_id: song.id,
                created_at: nowIso(),
                updated_at: nowIso(),
                version: 0,
              };
              state.band_songs.push(link);
              queueUpsert('band_songs', link);
            });
            // banda principal (primeira escolhida) também é refletida em songs.band_id
            const rec = {
              ...song,
              band_id: wanted[0] || '',
              updated_at: nowIso(),
            };
            const i = state.songs.findIndex((s) => s.id === song.id);
            state.songs[i] = rec;
            queueUpsert('songs', rec);
            saveLocalCache();
            close();
            render();
            showToast('Bandas atualizadas.', 'ok');
          });
        }
      );
    },

    async exportBackup() {
      try {
        const data = await api.get('/api/backup');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'frnkln-stage-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        showToast('Backup exportado.', 'ok');
      } catch (err) {
        showToast('Erro ao exportar: ' + err.message, 'err');
      }
    },

    async importBackup(file) {
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch (e) {
        showToast('Arquivo JSON inválido.', 'err');
        return;
      }
      let validation;
      try {
        validation = await api.post('/api/backup/validate', { payload });
      } catch (err) {
        showToast('Erro ao validar: ' + err.message, 'err');
        return;
      }
      if (!validation.valid) {
        openModal(
          '<h3>Backup incompatível</h3><p class="muted small" style="margin-top:6px">O arquivo não pôde ser validado:</p>' +
            '<ul class="small muted" style="margin-top:10px;padding-left:18px">' +
            validation.errors.map((e) => '<li>' + esc(e) + '</li>').join('') +
            '</ul><div class="modal-actions"><button class="btn primary" data-close>Fechar</button></div>'
        );
        return;
      }
      const c = validation.counts;
      openModal(
        '<h3>Importar backup</h3>' +
          '<p class="small muted" style="margin-top:6px">Conteúdo: ' +
          c.bands + ' banda(s), ' + c.songs + ' música(s), ' + c.setlists + ' setlist(s), ' +
          c.setlist_songs + ' item(ns) de setlist.</p>' +
          '<div class="card" style="margin-top:12px"><div class="small muted">Mesclar mantém os dados atuais e atualiza os itens com o mesmo identificador. Substituir apaga os dados atuais deste usuário antes de restaurar.</div></div>' +
          '<div class="modal-actions"><button class="btn ghost" data-close>Cancelar</button>' +
          '<button class="btn" id="imp-merge">Mesclar</button>' +
          '<button class="btn danger" id="imp-replace">Substituir</button></div>',
        (modal, close) => {
          modal.querySelector('#imp-merge').addEventListener('click', async () => {
            close();
            await runImport(payload, 'merge');
          });
          modal.querySelector('#imp-replace').addEventListener('click', () => {
            close();
            confirmDialog(
              'Substituir todos os dados?',
              'Os dados atuais serão removidos e trocados pelo conteúdo do backup. Exporte um backup antes, se quiser guardar o estado atual.',
              'Substituir tudo',
              async () => {
                await runImport(payload, 'replace');
              },
              true
            );
          });
        }
      );
    },

    async runImport(payload, mode) {
      try {
        const res = await api.post('/api/backup/import', { payload, mode, confirm: mode === 'replace' });
        await syncNow(true);
        render();
        showToast(
          'Backup importado (' + mode + '): ' + res.stats.songs + ' música(s), ' + res.stats.bands + ' banda(s).',
          'ok'
        );
      } catch (err) {
        showToast('Erro ao importar: ' + err.message, 'err');
      }
    },

    async saveSettings(patch) {
      state.settings = { ...state.settings, ...patch };
      applySettings();
      const rec = { ...state.settings };
      pending.set('settings:' + state.user.id, {
        entity: 'settings',
        id: state.user.id,
        method: 'PUT',
        body: rec,
        attempts: 0,
      });
      savePendingQueue();
      setSync('saving');
      scheduleSave();
      render();
    },
  };

  /* --------------------------------------------------------- bindings */
  function bindCommon() {
    document.querySelectorAll('[data-nav]').forEach((b) =>
      b.addEventListener('click', () => {
        const target = b.getAttribute('data-nav');
        if (currentRoute.name === target) return;
        go(target);
      })
    );

    const refresh = document.getElementById('btn-refresh');
    if (refresh)
      refresh.addEventListener('click', async () => {
        await syncNow(true);
        await flushPending();
        render();
        showToast('Sincronizado.', 'ok');
      });

    document.querySelectorAll('[data-band]').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        go('band', el.getAttribute('data-band'));
      })
    );
    document.querySelectorAll('[data-song]').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        go('song', el.getAttribute('data-song'));
      })
    );
    document.querySelectorAll('[data-setlist]').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        go('setlist', el.getAttribute('data-setlist'));
      })
    );

    bindHome();
    bindBands();
    bindSongs();
    bindSetlists();
    bindSettings();
  }

  function bindHome() {
    const qb = document.getElementById('q-band');
    if (qb) qb.addEventListener('click', actions.createBand);
    const qs = document.getElementById('q-song');
    if (qs) qs.addEventListener('click', () => actions.createSong());
    const ql = document.getElementById('q-setlist');
    if (ql) ql.addEventListener('click', () => actions.createSetlist());
    const eb = document.getElementById('empty-band');
    if (eb) eb.addEventListener('click', actions.createBand);
    const eb2 = document.getElementById('empty-band2');
    if (eb2) eb2.addEventListener('click', actions.createBand);
  }

  function bindBands() {
    const add = document.getElementById('add-band');
    if (add) add.addEventListener('click', actions.createBand);
    const search = document.getElementById('band-search');
    if (search)
      search.addEventListener('input', () => {
        ui.bandQuery = search.value;
        const pos = search.selectionStart;
        render();
        const s = document.getElementById('band-search');
        if (s) {
          s.focus();
          s.setSelectionRange(pos, pos);
        }
      });

    const edit = document.getElementById('band-edit');
    if (edit) {
      const band = byId(state.bands, currentRoute.params.id);
      if (band) edit.addEventListener('click', () => actions.editBand(band));
    }
    const del = document.getElementById('band-delete');
    if (del) {
      const band = byId(state.bands, currentRoute.params.id);
      if (band) del.addEventListener('click', () => actions.deleteBand(band));
    }
    const as = document.getElementById('band-add-song');
    if (as)
      as.addEventListener('click', () => {
        const band = byId(state.bands, currentRoute.params.id);
        actions.createSong(band ? band.id : '');
      });
    const al = document.getElementById('band-add-setlist');
    if (al)
      al.addEventListener('click', () => {
        const band = byId(state.bands, currentRoute.params.id);
        actions.createSetlist(band ? band.id : '');
      });
  }

  function bindSongs() {
    const add = document.getElementById('add-song');
    if (add) add.addEventListener('click', () => actions.createSong());
    const es = document.getElementById('empty-song');
    if (es) es.addEventListener('click', () => actions.createSong());

    const search = document.getElementById('song-search');
    if (search)
      search.addEventListener('input', () => {
        ui.songQuery = search.value;
        const pos = search.selectionStart;
        render();
        const s = document.getElementById('song-search');
        if (s) {
          s.focus();
          s.setSelectionRange(pos, pos);
        }
      });

    document.querySelectorAll('[data-bandfilter]').forEach((chip) =>
      chip.addEventListener('click', () => {
        ui.songBandFilter = chip.getAttribute('data-bandfilter');
        render();
      })
    );

    // Detalhe da música: autosave campo a campo
    const song = byId(state.songs, currentRoute.params.id);
    if (!song) return;

    const fields = {
      '#f-title': 'title',
      '#f-artist': 'artist',
      '#f-key': 'key',
      '#f-capo': 'capo',
      '#f-bpm': 'bpm',
      '#f-meter': 'meter',
      '#f-lyrics': 'lyrics',
      '#f-chords': 'chords',
      '#f-notes': 'notes',
    };
    Object.keys(fields).forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const handler = () => {
        const key = fields[sel];
        const cur = byId(state.songs, song.id);
        const rec = { ...cur, [key]: el.value, updated_at: nowIso() };
        state.songs[state.songs.findIndex((s) => s.id === song.id)] = rec;
        queueUpsert('songs', rec);
      };
      el.addEventListener('input', handler);
      el.addEventListener('blur', () => flushPending());
    });

    const bandSel = document.getElementById('f-band');
    if (bandSel)
      bandSel.addEventListener('change', () => {
        const cur = byId(state.songs, song.id);
        const rec = { ...cur, band_id: bandSel.value, updated_at: nowIso() };
        state.songs[state.songs.findIndex((s) => s.id === song.id)] = rec;
        queueUpsert('songs', rec);
        if (bandSel.value) {
          const link = state.band_songs.find(
            (bs) => bs.song_id === song.id && bs.band_id === bandSel.value
          );
          if (!link) {
            const l = {
              id: uid(),
              band_id: bandSel.value,
              song_id: song.id,
              created_at: nowIso(),
              updated_at: nowIso(),
              version: 0,
            };
            state.band_songs.push(l);
            queueUpsert('band_songs', l);
          }
        }
        saveLocalCache();
        render();
      });

    const dur = document.getElementById('f-duration');
    if (dur)
      dur.addEventListener('change', () => {
        const cur = byId(state.songs, song.id);
        const rec = {
          ...cur,
          duration: dur.value === '' ? null : Number(dur.value),
          updated_at: nowIso(),
        };
        state.songs[state.songs.findIndex((s) => s.id === song.id)] = rec;
        queueUpsert('songs', rec);
      });

    const st = document.getElementById('song-stage');
    if (st)
      st.addEventListener('click', () => {
        const sl = state.setlists.find((s) => setlistItems(s.id).some((it) => it.song_id === song.id));
        if (sl) {
          const idx = setlistItems(sl.id).findIndex((it) => it.song_id === song.id);
          openStage(sl.id, idx);
        } else {
          openSingleStage(song);
        }
      });

    const del = document.getElementById('song-delete');
    if (del) del.addEventListener('click', () => actions.deleteSong(song));

    const assoc = document.getElementById('song-associate');
    if (assoc) assoc.addEventListener('click', () => actions.associateSongBand(song));
  }

  function openSingleStage(song) {
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.innerHTML =
      '<div class="stage-top"><button class="iconbtn" id="stage-close">✕</button>' +
      '<div class="t">' + esc(song.title) + '</div></div>' +
      '<div class="stage-body" id="stage-body"></div>';
    document.body.appendChild(stage);
    const body = stage.querySelector('#stage-body');
    body.innerHTML = sheetHtml(song);
    body.style.fontSize = (state.settings.stage_font_size || 22) + 'px';
    body.style.setProperty('--stage-chord', state.settings.stage_chord_color || '#ff3b30');
    stage.querySelector('#stage-close').addEventListener('click', () => stage.remove());
  }

  function bindSetlists() {
    const add = document.getElementById('add-setlist');
    if (add) add.addEventListener('click', () => actions.createSetlist());
    const es = document.getElementById('empty-setlist');
    if (es) es.addEventListener('click', () => actions.createSetlist());

    const search = document.getElementById('setlist-search');
    if (search)
      search.addEventListener('input', () => {
        ui.setlistQuery = search.value;
        const pos = search.selectionStart;
        render();
        const s = document.getElementById('setlist-search');
        if (s) {
          s.focus();
          s.setSelectionRange(pos, pos);
        }
      });

    const sl = byId(state.setlists, currentRoute.params.id);
    if (!sl) return;

    const addS = document.getElementById('setlist-add');
    if (addS) addS.addEventListener('click', () => actions.addSongsToSetlist(sl));
    const edit = document.getElementById('setlist-edit');
    if (edit) edit.addEventListener('click', () => actions.editSetlist(sl));
    const dup = document.getElementById('setlist-dup');
    if (dup) dup.addEventListener('click', () => actions.duplicateSetlist(sl));
    const del = document.getElementById('setlist-delete');
    if (del) del.addEventListener('click', () => actions.deleteSetlist(sl));
    const stage = document.getElementById('setlist-stage');
    if (stage) stage.addEventListener('click', () => openStage(sl.id, 0));

    document.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = b.getAttribute('data-remove');
        const i = state.setlist_songs.findIndex((x) => x.id === id);
        if (i >= 0) state.setlist_songs.splice(i, 1);
        queueDelete('setlist_songs', id);
        reindex(sl.id);
        saveLocalCache();
        render();
      })
    );

    document.querySelectorAll('[data-move]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const dir = b.getAttribute('data-move');
        const id = b.getAttribute('data-id');
        moveItem(sl.id, id, dir === 'up' ? -1 : 1);
      })
    );

    bindDragAndDrop(sl);
  }

  function reindex(setlistId) {
    const items = state.setlist_songs
      .filter((ss) => ss.setlist_id === setlistId)
      .sort((a, b) => a.position - b.position);
    items.forEach((it, i) => {
      if (it.position === i) return;
      const rec = { ...it, position: i, updated_at: nowIso() };
      state.setlist_songs[state.setlist_songs.findIndex((x) => x.id === it.id)] = rec;
      queueUpsert('setlist_songs', rec);
    });
  }

  function moveItem(setlistId, id, delta) {
    const items = state.setlist_songs
      .filter((ss) => ss.setlist_id === setlistId)
      .sort((a, b) => a.position - b.position);
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= items.length) return;
    const a = items[i];
    const b = items[j];
    const recA = { ...a, position: b.position, updated_at: nowIso() };
    const recB = { ...b, position: a.position, updated_at: nowIso() };
    state.setlist_songs[state.setlist_songs.findIndex((x) => x.id === a.id)] = recA;
    state.setlist_songs[state.setlist_songs.findIndex((x) => x.id === b.id)] = recB;
    queueUpsert('setlist_songs', recA);
    queueUpsert('setlist_songs', recB);
    saveLocalCache();
    render();
  }

  function bindDragAndDrop(sl) {
    let draggedId = null;
    document.querySelectorAll('[data-sl-item]').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        draggedId = el.getAttribute('data-sl-item');
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
          e.dataTransfer.setData('text/plain', draggedId);
        } catch (err) {
          /* ignore */
        }
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        document.querySelectorAll('.dragover').forEach((x) => x.classList.remove('dragover'));
      });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('dragover');
      });
      el.addEventListener('dragleave', () => el.classList.remove('dragover'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('dragover');
        const targetId = el.getAttribute('data-sl-item');
        if (!draggedId || draggedId === targetId) return;
        const items = state.setlist_songs
          .filter((ss) => ss.setlist_id === sl.id)
          .sort((a, b) => a.position - b.position);
        const from = items.findIndex((x) => x.id === draggedId);
        const to = items.findIndex((x) => x.id === targetId);
        if (from < 0 || to < 0) return;
        const ordered = items.slice();
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);
        ordered.forEach((it, i) => {
          const rec = { ...it, position: i, updated_at: nowIso() };
          state.setlist_songs[state.setlist_songs.findIndex((x) => x.id === it.id)] = rec;
          queueUpsert('setlist_songs', rec);
        });
        saveLocalCache();
        render();
      });
    });
  }

  function bindSettings() {
    const logout = document.getElementById('logout');
    if (logout)
      logout.addEventListener('click', async () => {
        try {
          await api.post('/api/auth/logout');
        } catch (e) {
          /* ignore */
        }
        api.token = null;
        localStorage.removeItem(LS_TOKEN);
        state.user = null;
        render();
      });

    const auto = document.getElementById('set-autosync');
    if (auto)
      auto.addEventListener('click', () => {
        actions.saveSettings({ auto_sync: !state.settings.auto_sync });
      });

    const motion = document.getElementById('set-motion');
    if (motion)
      motion.addEventListener('click', () => {
        actions.saveSettings({ reduce_motion: !state.settings.reduce_motion });
      });

    const font = document.getElementById('set-font');
    const fontValue = document.getElementById('font-value');
    if (font)
      font.addEventListener('input', () => {
        fontValue.textContent = font.value;
        state.settings.stage_font_size = Number(font.value);
        document.documentElement.style.setProperty('--stage-chord', state.settings.stage_chord_color);
      });
    if (font)
      font.addEventListener('change', () => {
        actions.saveSettings({ stage_font_size: Number(font.value) });
      });

    const chord = document.getElementById('set-chord');
    if (chord)
      chord.addEventListener('change', () => {
        actions.saveSettings({ stage_chord_color: chord.value });
      });

    const exportBtn = document.getElementById('backup-export');
    if (exportBtn) exportBtn.addEventListener('click', actions.exportBackup);

    const importBtn = document.getElementById('backup-import');
    const fileInput = document.getElementById('backup-file');
    if (importBtn && fileInput)
      importBtn.addEventListener('click', () => fileInput.click());
    if (fileInput)
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (f) actions.importBackup(f);
        fileInput.value = '';
      });

    const reset = document.getElementById('reset-cache');
    if (reset)
      reset.addEventListener('click', () => {
        localStorage.removeItem(LS_STATE);
        showToast('Cache local limpo. Os dados na nuvem não foram afetados.', 'ok');
      });
  }

  /* ------------------------------------------------------------- início */
  const APP_VERSION = '1.0.0';

  window.addEventListener('hashchange', () => {
    const next = parseHash();
    currentRoute = next;
    render();
    const key = next.name + ':' + (next.params.id || '');
    if (scrollMemory[key]) window.scrollTo(0, scrollMemory[key]);
    else window.scrollTo(0, 0);
  });

  currentRoute = parseHash();
  boot();

  /* ------------------------------------------------- service worker (PWA) */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
        /* sem SW: o app continua funcionando online */
      });
    });
  }

  // Expõe para testes automatizados
  window.__fnk = { state, api, actions, pending, flushPending, syncNow };
})();
