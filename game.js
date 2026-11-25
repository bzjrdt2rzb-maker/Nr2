'use strict';
/*
 * Farbrevier – Darstellung, Eingabe, Menüs und Netzwerk im Browser.
 * Modi:
 *   solo   – allein gegen Bots (Engine läuft im Browser)
 *   host   – Raum erstellen: Engine läuft hier, Freunde verbinden sich per Raumcode (PeerJS/WebRTC)
 *   guest  – einem Raum per Code beitreten
 *   online – mit dem Online-Server verbinden (WebSocket)
 */
(() => {
  const FE = window.FarbEngine;
  const { W, H, N, SPEED, TURN } = FE;
  const NO_MP = !!window.FARBREVIER_NO_MP;
  const PEER_PREFIX = 'farbrevier-v1-';
  const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const COLORS = [
    ['#ef4444', '#b42323'], ['#f97316', '#c2560c'], ['#eab308', '#a37c06'],
    ['#84cc16', '#5e9410'], ['#22c55e', '#178f43'], ['#14b8a6', '#0e8578'],
    ['#06b6d4', '#0789a1'], ['#3b82f6', '#1f5fd0'], ['#6366f1', '#4338ca'],
    ['#a855f7', '#7e2fc9'], ['#ec4899', '#b8246f'], ['#a16207', '#714404'],
    ['#64748b', '#3f4a5c'],
  ].map(([base, dark], i) => {
    const rgb = [1, 3, 5].map(k => parseInt(base.slice(k, k + 2), 16));
    return {
      i, base, dark, rgb,
      trail: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`,
      trailRgb: rgb.map(v => Math.round(v * 0.5 + 255 * 0.5)),
    };
  });
  const colorOf = p => COLORS[p.color] || COLORS[0];

  // ---------- Regenbogen (Einhorn) ----------
  const HUES = 48;
  const RB_TOP = [], RB_DARK = [], RB_TRAIL = [], RB_RGB = [], RB_TRAIL_RGB = [];
  function hslRgb(h, s, l) {
    const f = n => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  for (let k = 0; k < HUES; k++) {
    const h = (k * 360) / HUES;
    RB_TOP.push(`hsl(${h},90%,62%)`);
    RB_DARK.push(`hsl(${h},80%,42%)`);
    RB_TRAIL.push(`hsla(${h},95%,72%,0.65)`);
    RB_RGB.push(hslRgb(h, 0.9, 0.62));
    RB_TRAIL_RGB.push(hslRgb(h, 0.95, 0.82));
  }
  const RAINBOW_CSS = 'linear-gradient(135deg,#f43f5e,#f59e0b,#84cc16,#06b6d4,#8b5cf6,#ec4899)';
  const rbIndex = (x, y, t) => ((((x + y) * 3 + Math.floor(t * 24)) % HUES) + HUES) % HUES;
  const cellHash = (x, y) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  const isRb = p => FE.isRainbowName(p.name);

  // ---------- Hilfsfunktionen ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const fmtPct = v => (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%';
  const fmtTime = s => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = id => document.getElementById(id);

  // ---------- Zustand ----------
  const localEngine = FE.createEngine({ targetPlayers: 11 });
  const remote = { owner: new Uint8Array(N), trailMap: new Uint8Array(N), players: [null], time: 0, timeAt: 0 };
  let world = localEngine;          // was gerade gezeichnet wird: { owner, trailMap, players }
  let session = { kind: 'solo' };
  let localHuman = null;
  let myId = 0;
  let ui = 'menu';                  // menu | connecting | play | dead
  let paused = false;
  let humanColor = 7;
  let myTarget = 0, lastSentTarget = null, predAngle = 0;
  let myBest = 0;
  let deathCam = null;
  let lastRun = null;
  let creatingSelf = false;
  const particles = [];
  const floaters = [];
  const cam = { x: W / 2, y: H / 2 };

  const me = () => (myId ? world.players[myId] || null : null);
  const isRemote = () => session.kind === 'guest' || session.kind === 'online';
  const worldTime = () => (isRemote() ? remote.time + (performance.now() - remote.timeAt) / 1000 : localEngine.time);

  // ---------- Ereignisse (lokal oder vom Netzwerk) ----------
  const feedEl = $('feed');
  function addFeed(text, important) {
    if (ui === 'menu' && !important) return;
    const el = document.createElement('div');
    el.className = 'msg' + (important ? ' important' : '');
    el.textContent = text;
    feedEl.appendChild(el);
    while (feedEl.children.length > 4) feedEl.firstChild.remove();
    setTimeout(() => { el.style.opacity = '0'; }, 2600);
    setTimeout(() => el.remove(), 3300);
  }

  function burst(x, y, colorIdx, rainbow) {
    const col = COLORS[colorIdx] || COLORS[0];
    for (let k = 0; k < 26; k++) {
      const a = rand(0, Math.PI * 2), v = rand(2, 9);
      particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.5, 1.1),
        color: rainbow ? `hsl(${Math.floor(rand(0, 360))},90%,62%)` : col.base, size: rand(0.2, 0.5),
      });
    }
  }

  function handleEvent(ev) {
    if (!ev) return;
    if (ev.k === 'kill') {
      burst(ev.x, ev.y, ev.c, FE.isRainbowName(ev.vn));
      const mine = myId !== 0 && (ev.v === myId || ev.by === myId);
      let msg;
      if (ev.r === 'self') msg = `${ev.vn} ist über die eigene Spur gestolpert`;
      else if (ev.r === 'head') msg = `${ev.kn} hat ${ev.vn} gerammt`;
      else if (ev.r === 'wiped') msg = `${ev.kn} hat ${ev.vn} komplett eingenommen`;
      else if (ev.r === 'leave') msg = `${ev.vn} hat das Spiel verlassen`;
      else msg = `${ev.kn} hat ${ev.vn} abgeschnitten`;
      if (ev.r !== 'leave' || session.kind !== 'solo') addFeed(msg, mine);
      if (myId && ev.v === myId && ui === 'play') onMyDeath(ev);
    } else if (ev.k === 'cap') {
      if (myId && ev.id === myId) {
        const p = me();
        floaters.push({
          x: ev.x, y: ev.y - 1, text: '+' + fmtPct((ev.g / N) * 100), life: 1.2,
          color: p && isRb(p) ? '#d946ef' : (p ? colorOf(p).dark : '#1f2430'),
        });
      }
    } else if (ev.k === 'god') {
      const mine = myId && ev.id === myId;
      if (session.kind !== 'solo' || mine) {
        addFeed(ev.on ? `${mine ? 'Du bist' : ev.n + ' ist'} jetzt unsterblich` : `${mine ? 'Du bist' : ev.n + ' ist'} wieder verwundbar`, mine);
      }
    } else if (ev.k === 'join') {
      if (!creatingSelf && ev.id !== myId && session.kind !== 'solo') addFeed(`${ev.n} ist beigetreten`, true);
    }
  }

  // ---------- Remote-Welt (Gast / Online) ----------
  function resetRemote() {
    remote.owner.fill(0);
    remote.trailMap.fill(0);
    remote.players = [null];
    remote.time = 0;
    remote.timeAt = performance.now();
  }

  function remotePlayer(id) {
    let p = remote.players[id];
    if (!p) {
      while (remote.players.length <= id) remote.players.push(null);
      p = remote.players[id] = {
        id, name: '', color: 0, isBot: false, x: 0, y: 0, angle: 0, sx: 0, sy: 0, sa: 0,
        alive: false, count: 0, kills: 0, spawnTime: 0, snapAt: 0,
      };
    }
    return p;
  }

  function applyMeta(m) {
    const seen = new Set();
    for (const [id, name, color, bot] of m) {
      const p = remotePlayer(id);
      p.name = String(name);
      p.color = color | 0;
      p.isBot = !!bot;
      seen.add(id);
    }
    for (let k = 1; k < remote.players.length; k++) if (remote.players[k] && !seen.has(k)) remote.players[k] = null;
  }

  function applyPlayers(arr) {
    const now = performance.now();
    for (const [id, x, y, a, alive, count, kills, st, inv] of arr) {
      const p = remotePlayer(id);
      p.sx = x / 100; p.sy = y / 100; p.sa = a / 1000;
      const was = p.alive;
      p.alive = !!alive;
      if ((!was && p.alive) || Math.hypot(p.x - p.sx, p.y - p.sy) > 4) {
        p.x = p.sx; p.y = p.sy; p.angle = p.sa;
        if (id === myId) { predAngle = p.sa; myTarget = p.sa; lastSentTarget = p.sa; snapCam = true; }
      }
      p.snapAt = now;
      p.count = count;
      p.kills = kills;
      p.spawnTime = st / 10;
      p.invincible = !!inv;
    }
  }

  function onRemoteMessage(msg) {
    if (!msg || typeof msg !== 'object' || !isRemote()) return;
    session.lastMsgAt = performance.now();
    if (msg.t === 'welcome') {
      myId = msg.id | 0;
    } else if (msg.t === 'full') {
      FE.rleDecode(msg.o, remote.owner);
      FE.rleDecode(msg.tr, remote.trailMap);
      applyMeta(msg.m);
      applyPlayers(msg.p);
      remote.time = msg.time; remote.timeAt = performance.now();
      if (ui === 'connecting') { setStatus(''); enterPlay(); }
    } else if (msg.t === 'd') {
      const c = msg.c || [];
      for (let k = 0; k + 2 < c.length; k += 3) {
        const i = c[k];
        if (i >= 0 && i < N) { remote.owner[i] = c[k + 1]; remote.trailMap[i] = c[k + 2]; }
      }
      if (msg.m) applyMeta(msg.m);
      if (msg.p) applyPlayers(msg.p);
      remote.time = msg.time; remote.timeAt = performance.now();
      if (msg.ev) for (const ev of msg.ev) handleEvent(ev);
    } else if (msg.t === 'full-room') {
      backToMenu('Dieser Raum ist voll.', true);
    }
  }

  function updateRemoteDisplay(dt) {
    predAngle = FE.wrapAngle(FE.turnToward(predAngle, myTarget, TURN * dt));
    const now = performance.now();
    const k = Math.min(1, dt * 14);
    for (const p of remote.players) {
      if (!p || !p.alive) continue;
      const age = Math.min(0.2, (now - p.snapAt) / 1000);
      const a = p.id === myId ? predAngle : p.sa;
      const tx = p.sx + Math.cos(a) * SPEED * age, ty = p.sy + Math.sin(a) * SPEED * age;
      p.x += (tx - p.x) * k;
      p.y += (ty - p.y) * k;
      p.angle = p.id === myId ? predAngle : FE.wrapAngle(FE.turnToward(p.angle, p.sa, 12 * dt));
    }
  }

  // Richtung an Host/Server schicken (max. 20x pro Sekunde, nur bei Änderung)
  setInterval(() => {
    // Verbindung tot? (Host/Server schickt sonst 20 Updates pro Sekunde)
    if (isRemote() && session.lastMsgAt && performance.now() - session.lastMsgAt > (ui === 'connecting' ? 15000 : 5000)) {
      backToMenu(session.kind === 'guest' ? 'Die Verbindung zum Raum wurde getrennt.' : 'Die Verbindung zum Server wurde getrennt.', true);
      return;
    }
    if (!isRemote() || !session.link || ui !== 'play') return;
    const p = me();
    if (!p || !p.alive) return;
    if (lastSentTarget === null || Math.abs(myTarget - lastSentTarget) > 0.001) {
      session.link.send({ t: 'dir', a: Math.round(myTarget * 1000) / 1000 });
      lastSentTarget = myTarget;
    }
  }, 50);

  // ---------- Sitzungen ----------
  function profile() {
    const name = FE.cleanName($('nameInput').value, 'Du');
    store.set('farbrevier.name', name);
    return { name, color: humanColor };
  }

  function leaveSession() {
    const old = session;
    session = { kind: 'solo' };
    myId = 0;
    if (old.kind === 'host') {
      for (const conn of old.conns.keys()) { try { conn.close(); } catch (e) { /* egal */ } }
      for (const c of [...old.hub.clients]) old.hub.remove(c);
      try { old.peer.destroy(); } catch (e) { /* egal */ }
      localEngine.setTrackDirty(false);
    }
    if (old.link) old.link.close();
    if (old.peer && old.kind !== 'host') { try { old.peer.destroy(); } catch (e) { /* egal */ } }
    if (localHuman && localEngine.players[localHuman.id] === localHuman) localEngine.removePlayer(localHuman);
    localHuman = null;
    world = localEngine;
    updateRoomInfo();
  }

  function createLocalHuman(prof) {
    creatingSelf = true;
    localHuman = localEngine.addHuman(prof.name, prof.color);
    creatingSelf = false;
    localEngine.spawnPlayer(localHuman);
    myId = localHuman.id;
    myTarget = localHuman.angle;
  }

  function startSolo() {
    const prof = profile();
    leaveSession();
    session = { kind: 'solo' };
    createLocalHuman(prof);
    enterPlay();
  }

  function respawn() {
    const prof = profile();
    if (session.kind === 'solo' || session.kind === 'host') {
      if (!localHuman) { startSolo(); return; }
      localEngine.spawnPlayer(localHuman, prof.name, prof.color);
      myTarget = localHuman.angle;
    } else if (session.link) {
      session.link.send({ t: 'spawn', name: prof.name, color: prof.color });
    }
    enterPlay();
  }

  function enterPlay() {
    ui = 'play';
    paused = false;
    myBest = 0;
    deathCam = null;
    snapCam = true;
    $('menu').classList.add('hidden');
    $('over').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('hud').classList.remove('hidden');
    updateRoomInfo();
  }

  function backToMenu(statusText, isError) {
    leaveSession();
    ui = 'menu';
    setBusy(false);
    $('over').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('menu').classList.remove('hidden');
    setStatus(statusText || '', isError);
    showRecord();
    updateRoomInfo();
  }

  function onMyDeath(ev) {
    ui = 'dead';
    deathCam = { x: ev.x, y: ev.y };
    const p = me();
    const best = bestRecord();
    const pct = Math.max(myBest, p ? (p.count / N) * 100 : 0);
    const isRecord = best > 0 && pct > best;
    if (pct > best) store.set('farbrevier.best', String(pct));
    lastRun = {
      reason: ev.r, killer: ev.kn, pct, kills: p ? p.kills : 0,
      survived: p ? worldTime() - p.spawnTime : 0, isRecord, best: Math.max(best, pct),
    };
    setTimeout(showGameOver, 900);
  }

  // ---------- Raum (PeerJS) ----------
  let peerLoading = null;
  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    if (!peerLoading) {
      peerLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = PEERJS_URL;
        s.onload = () => (window.Peer ? resolve() : reject(new Error('no Peer')));
        s.onerror = () => { peerLoading = null; reject(new Error('load failed')); };
        document.head.appendChild(s);
      });
    }
    return peerLoading;
  }
  const peerOptions = () => Object.assign({ debug: 0 }, window.FARBREVIER_PEER || {});
  const makeCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

  async function startHost(attempt) {
    attempt = attempt || 0;
    const prof = profile();
    setStatus('Raum wird erstellt …');
    setBusy(true);
    try { await loadPeer(); } catch (e) {
      setBusy(false);
      setStatus('Die Mehrspieler-Verbindung konnte nicht geladen werden. Bist du online?', true);
      return;
    }
    leaveSession();
    const code = makeCode();
    const peer = new window.Peer(PEER_PREFIX + code, peerOptions());
    let opened = false;
    peer.on('open', () => {
      opened = true;
      setBusy(false);
      const hub = FE.createHub(localEngine, { maxHumans: 12 });
      session = { kind: 'host', peer, hub, code, conns: new Map() };
      createLocalHuman(prof);
      setStatus('');
      enterPlay();
    });
    peer.on('connection', conn => {
      if (session.kind !== 'host' || session.peer !== peer) { try { conn.close(); } catch (e) { /* egal */ } return; }
      const s = session;
      let client = null;
      conn.on('open', () => {
        client = s.hub.add(msg => { try { if (conn.open) conn.send(msg); } catch (e) { /* egal */ } });
        s.conns.set(conn, client);
        updateRoomInfo();
      });
      conn.on('data', msg => { if (client) s.hub.message(client, msg); });
      const drop = () => {
        if (client) { s.hub.remove(client); client = null; }
        s.conns.delete(conn);
        updateRoomInfo();
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('disconnected', () => {
      // Verbindung zum Vermittlungsserver weg: bestehende Spieler bleiben verbunden
      if (session.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* egal */ } }
    });
    peer.on('error', err => {
      if (opened) return;
      setBusy(false);
      try { peer.destroy(); } catch (e) { /* egal */ }
      if (err && err.type === 'unavailable-id' && attempt < 3) { startHost(attempt + 1); return; }
      setStatus('Raum konnte nicht erstellt werden. Prüfe deine Internetverbindung und versuche es nochmal.', true);
    });
  }

  async function joinRoom() {
    const code = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { setStatus('Der Raumcode hat 4 Zeichen.', true); return; }
    setStatus('Verbinde mit Raum ' + code + ' …');
    setBusy(true);
    try { await loadPeer(); } catch (e) {
      setBusy(false);
      setStatus('Die Mehrspieler-Verbindung konnte nicht geladen werden. Bist du online?', true);
      return;
    }
    leaveSession();
    const peer = new window.Peer(peerOptions());
    let connected = false;
    const fail = text => {
      setBusy(false);
      try { peer.destroy(); } catch (e) { /* egal */ }
      if (session.peer === peer) backToMenu(text, true);
      else setStatus(text, true);
    };
    const timer = setTimeout(() => { if (!connected) fail('Raum nicht gefunden. Stimmt der Code und ist der Gastgeber noch im Spiel?'); }, 12000);
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { serialization: 'json', reliable: true });
      const link = {
        send: m => { try { if (conn.open) conn.send(m); } catch (e) { /* egal */ } },
        close: () => { try { conn.close(); } catch (e) { /* egal */ } try { peer.destroy(); } catch (e) { /* egal */ } },
      };
      conn.on('open', () => {
        connected = true;
        clearTimeout(timer);
        setBusy(false);
        startRemote('guest', link, { code, peer });
      });
      conn.on('data', onRemoteMessage);
      conn.on('close', () => { if (session.link === link) backToMenu('Die Verbindung zum Raum wurde getrennt.', true); });
    });
    peer.on('error', err => {
      // Nach erfolgreichem Beitritt sind Störungen beim Vermittlungsserver egal
      if (connected && err && err.type !== 'peer-unavailable') return;
      clearTimeout(timer);
      if (err && err.type === 'peer-unavailable') fail('Raum nicht gefunden. Stimmt der Code und ist der Gastgeber noch im Spiel?');
      else fail('Verbindung fehlgeschlagen. Versucht es im selben WLAN oder erstellt einen neuen Raum.');
    });
  }

  // ---------- Online-Server (WebSocket) ----------
  function serverUrl() {
    const s = window.FARBREVIER_SERVER;
    if (!s) return null;
    if (s === 'same-origin') return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    if (/^wss?:\/\//.test(s)) return s;
    if (/^https?:\/\//.test(s)) return s.replace(/^http/, 'ws').replace(/\/?$/, '/ws');
    return null;
  }

  function joinOnline() {
    const url = serverUrl();
    if (!url) return;
    setStatus('Verbinde mit dem Server … (das erste Mal kann bis zu einer Minute dauern)');
    setBusy(true);
    leaveSession();
    let ws, opened = false;
    try { ws = new WebSocket(url); } catch (e) {
      setBusy(false);
      setStatus('Server nicht erreichbar.', true);
      return;
    }
    const link = {
      send: m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); },
      close: () => { try { ws.close(); } catch (e) { /* egal */ } },
    };
    ws.onopen = () => { opened = true; setBusy(false); startRemote('online', link, {}); };
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      onRemoteMessage(m);
    };
    ws.onclose = () => {
      if (!opened) { setBusy(false); setStatus('Server nicht erreichbar. Versuch es gleich nochmal.', true); return; }
      if (session.link === link) backToMenu('Die Verbindung zum Server wurde getrennt.', true);
    };
  }

  function startRemote(kind, link, extra) {
    const prof = profile();
    resetRemote();
    session = Object.assign({ kind, link, lastMsgAt: performance.now() }, extra);
    world = remote;
    myId = 0;
    lastSentTarget = null;
    ui = 'connecting';
    setStatus('Verbunden – lade Spielwelt …');
    link.send({ t: 'join', name: prof.name, color: prof.color });
  }

  // ---------- Rendering ----------
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  const mini = $('minimap');
  const mctx = mini.getContext('2d');
  const miniOff = document.createElement('canvas');
  miniOff.width = W; miniOff.height = H;
  const moctx = miniOff.getContext('2d');
  const miniImg = moctx.createImageData(W, H);
  const rbFlag = new Uint8Array(256);

  let dpr = 1, cw = 0, ch = 0, cellPx = 30, viewOx = 0, viewOy = 0, snapCam = false;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = canvas.width = Math.floor(innerWidth * dpr);
    ch = canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    const target = Math.min(innerWidth, innerHeight) < 600 ? 24 : 32;
    cellPx = Math.max(12 * dpr, Math.round(Math.min(cw, ch) / target));
  }
  window.addEventListener('resize', resize);
  resize();

  function rrect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function sparkle(cx, cy, r) {
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.quadraticCurveTo(cx, cy, cx + r, cy);
    ctx.quadraticCurveTo(cx, cy, cx, cy + r);
    ctx.quadraticCurveTo(cx, cy, cx - r, cy);
    ctx.quadraticCurveTo(cx, cy, cx, cy - r);
    ctx.fill();
  }

  function render(rt) {
    const cell = cellPx;
    const { owner, trailMap, players } = world;
    const ox = Math.round(cw / 2 - cam.x * cell), oy = Math.round(ch / 2 - cam.y * cell);
    viewOx = ox; viewOy = oy;

    rbFlag.fill(0);
    let anyRb = false;
    for (const p of players) if (p && isRb(p)) { rbFlag[p.id] = 1; anyRb = true; }

    ctx.fillStyle = '#262b38';
    ctx.fillRect(0, 0, cw, ch);
    ctx.fillStyle = '#f3f5f9';
    ctx.fillRect(ox, oy, W * cell, H * cell);

    const x0 = Math.max(0, Math.floor(-ox / cell) - 1), x1 = Math.min(W - 1, Math.ceil((cw - ox) / cell) + 1);
    const y0 = Math.max(0, Math.floor(-oy / cell) - 1), y1 = Math.min(H - 1, Math.ceil((ch - oy) / cell) + 1);

    // Schachbrett-Muster
    ctx.fillStyle = '#e8ecf2';
    ctx.beginPath();
    for (let y = y0; y <= y1; y++)
      for (let x = x0 + ((x0 + y) & 1); x <= x1; x += 2) ctx.rect(ox + x * cell, oy + y * cell, cell, cell);
    ctx.fill();

    // Gebiete mit leichtem 3D-Rand
    const depth = Math.max(2, Math.round(cell * 0.2));
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      for (let pass = 0; pass < 2; pass++) {
        const dy = pass === 0 ? depth : 0;
        let x = x0;
        while (x <= x1) {
          const o = owner[row + x];
          if (!o || !players[o]) { x++; continue; }
          let e = x;
          while (e + 1 <= x1 && owner[row + e + 1] === o) e++;
          if (rbFlag[o]) {
            const pal = pass === 0 ? RB_DARK : RB_TOP;
            for (let xx = x; xx <= e; xx++) {
              ctx.fillStyle = pal[rbIndex(xx, y, rt)];
              ctx.fillRect(ox + xx * cell, oy + y * cell + dy, cell + 1, cell);
            }
          } else {
            const col = colorOf(players[o]);
            ctx.fillStyle = pass === 0 ? col.dark : col.base;
            ctx.fillRect(ox + x * cell, oy + y * cell + dy, (e - x + 1) * cell, cell);
          }
          x = e + 1;
        }
      }
    }

    // Spuren
    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      let x = x0;
      while (x <= x1) {
        const t = trailMap[row + x];
        if (!t || !players[t]) { x++; continue; }
        let e = x;
        while (e + 1 <= x1 && trailMap[row + e + 1] === t) e++;
        if (rbFlag[t]) {
          for (let xx = x; xx <= e; xx++) {
            ctx.fillStyle = RB_TRAIL[rbIndex(xx, y, rt)];
            ctx.fillRect(ox + xx * cell, oy + y * cell, cell, cell);
          }
        } else {
          ctx.fillStyle = colorOf(players[t]).trail;
          ctx.fillRect(ox + x * cell, oy + y * cell, (e - x + 1) * cell, cell);
        }
        x = e + 1;
      }
    }

    // Glitzer auf Einhorn-Gebieten
    if (anyRb) {
      ctx.fillStyle = '#ffffff';
      for (let y = y0; y <= y1; y++) {
        const row = y * W;
        for (let x = x0; x <= x1; x++) {
          const o = owner[row + x], t = trailMap[row + x];
          if (!rbFlag[o] && !rbFlag[t]) continue;
          const h = cellHash(x, y);
          if (h % 2 !== 0) continue;
          const tw = Math.sin(rt * (2.5 + (h % 7) * 0.4) + (h % 628) / 100);
          if (tw < 0.3) continue;
          const a = (tw - 0.3) / 0.7;
          ctx.globalAlpha = a;
          const sx = ox + (x + 0.2 + ((h >> 4) % 60) / 100) * cell;
          const sy = oy + (y + 0.2 + ((h >> 10) % 60) / 100) * cell;
          sparkle(sx, sy, cell * (0.15 + 0.35 * a));
        }
      }
      ctx.globalAlpha = 1;
    }

    // Spielfeldrand
    ctx.strokeStyle = 'rgba(239,68,68,.6)';
    ctx.lineWidth = Math.max(2, cell * 0.12);
    ctx.strokeRect(ox, oy, W * cell, H * cell);

    // Spieler
    const size = cell * 1.05;
    for (const p of players) {
      if (!p || !p.alive) continue;
      const sx = ox + p.rx * cell, sy = oy + p.ry * cell;
      if (sx < -cell * 4 || sy < -cell * 4 || sx > cw + cell * 4 || sy > ch + cell * 4) continue;
      const hx = sx - size / 2, hy = sy - size / 2, r = size * 0.22;
      const rb = rbFlag[p.id] === 1;
      const col = colorOf(p);
      if (rb) {
        const k = rbIndex(Math.floor(p.rx), Math.floor(p.ry), rt);
        ctx.fillStyle = RB_DARK[k];
        rrect(hx, hy + depth, size, size, r); ctx.fill();
        const g = ctx.createLinearGradient(hx, hy, hx + size, hy + size);
        for (let s = 0; s <= 4; s++) g.addColorStop(s / 4, RB_TOP[(k + s * 8) % HUES]);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = col.dark;
        rrect(hx, hy + depth, size, size, r); ctx.fill();
        ctx.fillStyle = col.base;
      }
      rrect(hx, hy, size, size, r); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = Math.max(1.5, cell * 0.07);
      ctx.stroke();

      // Unsterblich: pulsierender Leuchtring
      if (p.invincible) {
        const pulse = 0.5 + 0.5 * Math.sin(rt * 8);
        ctx.save();
        ctx.shadowColor = '#fde68a';
        ctx.shadowBlur = cell * (0.4 + 0.4 * pulse);
        ctx.strokeStyle = `rgba(253, 230, 138, ${0.6 + 0.4 * pulse})`;
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.beginPath();
        ctx.arc(sx, sy + depth / 2, size * (0.82 + 0.1 * pulse), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Augen
      const c = Math.cos(p.ra), s = Math.sin(p.ra);
      const ex = c * size * 0.15, ey = s * size * 0.15;
      const px = -s * size * 0.2, py = c * size * 0.2;
      for (const sign of [-1, 1]) {
        const cx2 = sx + ex + px * sign, cy2 = sy + ey + py * sign;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx2, cy2, size * 0.15, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1f2430';
        ctx.beginPath(); ctx.arc(cx2 + c * size * 0.06, cy2 + s * size * 0.06, size * 0.075, 0, Math.PI * 2); ctx.fill();
      }

      // Einhorn-Horn
      let nameY = hy - cell * 0.15;
      if (rb) {
        const bx = sx, by = hy + size * 0.08, tipX = bx + size * 0.05, tipY = by - size * 0.62;
        ctx.beginPath();
        ctx.moveTo(bx - size * 0.16, by);
        ctx.lineTo(bx + size * 0.16, by);
        ctx.lineTo(tipX, tipY);
        ctx.closePath();
        ctx.fillStyle = '#fcd34d';
        ctx.fill();
        ctx.strokeStyle = '#b45309';
        ctx.lineWidth = Math.max(1, cell * 0.04);
        ctx.stroke();
        ctx.beginPath();
        for (const f of [0.3, 0.6]) {
          const lx = bx - size * 0.16 + (tipX - (bx - size * 0.16)) * f, ly = by + (tipY - by) * f;
          const rx = bx + size * 0.16 + (tipX - (bx + size * 0.16)) * f;
          ctx.moveTo(lx, ly + size * 0.03);
          ctx.lineTo(rx, ly - size * 0.03);
        }
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(rt * 6);
        sparkle(tipX, tipY - size * 0.04, size * 0.16);
        ctx.globalAlpha = 1;
        nameY = tipY - size * 0.1;
      }

      // Name
      ctx.font = `700 ${Math.round(cell * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = Math.max(2, cell * 0.12);
      ctx.strokeStyle = 'rgba(20,24,34,.75)';
      ctx.strokeText(p.name, sx, nameY);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, sx, nameY);
    }

    // Partikel
    for (const q of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, q.life * 1.5));
      ctx.fillStyle = q.color;
      const s2 = q.size * cell;
      ctx.fillRect(ox + q.x * cell - s2 / 2, oy + q.y * cell - s2 / 2, s2, s2);
    }
    ctx.globalAlpha = 1;

    // Eroberungs-Anzeige
    for (const f of floaters) {
      ctx.globalAlpha = Math.min(1, f.life * 2);
      ctx.font = `900 ${Math.round(cell * 0.75)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = cell * 0.15;
      ctx.strokeStyle = '#fff';
      ctx.strokeText(f.text, ox + f.x * cell, oy + f.y * cell);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, ox + f.x * cell, oy + f.y * cell);
    }
    ctx.globalAlpha = 1;
  }

  function renderMinimap(rt) {
    const { owner, trailMap, players } = world;
    const d = miniImg.data;
    for (let i = 0; i < N; i++) {
      const t = trailMap[i], o = owner[i];
      let rgb = null;
      if (t && players[t]) rgb = rbFlag[t] ? RB_TRAIL_RGB[rbIndex(i % W, (i / W) | 0, rt)] : colorOf(players[t]).trailRgb;
      else if (o && players[o]) rgb = rbFlag[o] ? RB_RGB[rbIndex(i % W, (i / W) | 0, rt)] : colorOf(players[o]).rgb;
      const k = i * 4;
      if (rgb) { d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; } else { d[k] = 243; d[k + 1] = 245; d[k + 2] = 249; }
      d[k + 3] = 255;
    }
    moctx.putImageData(miniImg, 0, 0);
    const mw = mini.width, mh = mini.height;
    mctx.imageSmoothingEnabled = false;
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(miniOff, 0, 0, mw, mh);
    const cell = cellPx;
    mctx.strokeStyle = 'rgba(31,36,48,.5)';
    mctx.lineWidth = 1;
    mctx.strokeRect((-viewOx / cell) * mw / W, (-viewOy / cell) * mh / H, (cw / cell) * mw / W, (ch / cell) * mh / H);
    const p = me();
    if (p && p.alive) {
      mctx.fillStyle = '#1f2430';
      mctx.beginPath(); mctx.arc(p.rx * mw / W, p.ry * mh / H, 4, 0, Math.PI * 2); mctx.fill();
      mctx.fillStyle = '#fff';
      mctx.beginPath(); mctx.arc(p.rx * mw / W, p.ry * mh / H, 2, 0, Math.PI * 2); mctx.fill();
    }
  }

  // ---------- HUD ----------
  const lbEl = $('leaderboard');
  function updateLeaderboard() {
    const alive = world.players.filter(p => p && p.alive).sort((a, b) => b.count - a.count);
    const showHumans = session.kind !== 'solo';
    let html = '<div class="title">Rangliste</div>';
    const rowHtml = (p, rank) => {
      const dot = isRb(p) ? RAINBOW_CSS : colorOf(p).base;
      const tag = showHumans && !p.isBot && p.id !== myId ? '<span class="human" title="Mensch">●</span>' : '';
      return `<div class="row${p.id === myId ? ' me' : ''}"><span>${rank}.</span>` +
        `<span class="dot" style="background:${dot}"></span>` +
        `<span class="name">${tag}${esc(p.name)}</span><span>${fmtPct((p.count / N) * 100)}</span></div>`;
    };
    alive.slice(0, 6).forEach((p, k) => { html += rowHtml(p, k + 1); });
    const my = me();
    const myRank = my ? alive.indexOf(my) : -1;
    if (myRank >= 6) html += rowHtml(my, myRank + 1);
    lbEl.innerHTML = html;
  }

  const godBtn = $('godBtn');
  function updateHud() {
    const p = me();
    const showGod = ui === 'play' && !!p && p.alive && isRb(p);
    if (godBtn.hidden === showGod) godBtn.hidden = !showGod;
    if (showGod) {
      const on = !!p.invincible;
      if (godBtn.dataset.on !== String(on)) {
        godBtn.dataset.on = String(on);
        godBtn.classList.toggle('on', on);
        godBtn.setAttribute('aria-pressed', String(on));
        $('godState').textContent = on ? 'AN' : 'AUS';
      }
    }
    if (ui === 'play' && p && p.alive) {
      const pct = (p.count / N) * 100;
      myBest = Math.max(myBest, pct);
      $('pct').textContent = fmtPct(pct);
      $('sub').textContent = `Kills: ${p.kills} · ${fmtTime(worldTime() - p.spawnTime)}`;
    }
  }

  const roomEl = $('roomInfo');
  function updateRoomInfo() {
    if (session.kind === 'solo' || ui === 'menu') { roomEl.classList.add('hidden'); return; }
    let humans = 0;
    for (const p of world.players) if (p && !p.isBot) humans++;
    let html;
    if (session.kind === 'host') {
      html = `<div><b>Raum ${session.code}</b> · ${humans} Spieler</div>` +
        '<button id="copyLinkBtn" type="button">Einladungslink kopieren</button>';
    } else if (session.kind === 'guest') {
      html = `<div><b>Raum ${esc(session.code)}</b> · ${humans} Spieler</div>`;
    } else {
      html = `<div><b>Online</b> · ${humans} Spieler</div>`;
    }
    if (roomEl.dataset.html !== html) {
      roomEl.innerHTML = html;
      roomEl.dataset.html = html;
      const b = $('copyLinkBtn');
      if (b) b.addEventListener('click', copyInvite);
    }
    roomEl.classList.remove('hidden');
  }

  function copyInvite() {
    const link = location.origin + location.pathname + '#raum-' + session.code;
    const b = $('copyLinkBtn');
    const show = text => {
      if (!b) return;
      b.textContent = text;
      setTimeout(() => { roomEl.dataset.html = ''; updateRoomInfo(); }, 2500);
    };
    try {
      navigator.clipboard.writeText(link).then(() => show('Kopiert!'), () => show(link));
    } catch (e) { show(link); }
  }

  // ---------- Menüs ----------
  const nameInput = $('nameInput');
  const statusEl = $('mpStatus');

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
  }
  function setBusy(on) {
    for (const id of ['soloBtn', 'hostBtn', 'joinBtn', 'onlineBtn']) { const b = $(id); if (b) b.disabled = on; }
  }

  function bestRecord() { return parseFloat(store.get('farbrevier.best') || '0') || 0; }
  function showRecord() {
    const b = bestRecord();
    $('record').textContent = b > 0 ? `Dein Rekord: ${fmtPct(b)}` : '';
  }

  function buildSwatches() {
    const el = $('swatches');
    el.innerHTML = '';
    COLORS.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.background = c.base;
      b.title = 'Farbe wählen';
      if (c.i === humanColor) b.className = 'sel';
      b.addEventListener('click', () => { humanColor = c.i; store.set('farbrevier.color', String(c.i)); buildSwatches(); });
      el.appendChild(b);
    });
  }

  function updateNameFx() {
    nameInput.classList.toggle('einhorn', FE.isRainbowName(nameInput.value));
  }

  function showGameOver() {
    if (ui !== 'dead' || !lastRun) return;
    const r = lastRun;
    const reasons = {
      self: 'Du bist über deine eigene Spur gefahren.',
      head: `${r.killer || 'Jemand'} hat dich frontal gerammt.`,
      wiped: `${r.killer || 'Jemand'} hat dein ganzes Gebiet eingenommen.`,
      trail: `${r.killer || 'Jemand'} hat deine Spur gekreuzt.`,
    };
    $('overTitle').textContent = r.isRecord ? 'Neuer Rekord!' : 'Erwischt!';
    $('overReason').textContent = reasons[r.reason] || '';
    $('resPct').textContent = fmtPct(r.pct);
    $('resKills').textContent = r.kills;
    $('resTime').textContent = fmtTime(r.survived);
    $('overRecord').textContent = `Rekord: ${fmtPct(r.best)}`;
    $('overNote').textContent = session.kind === 'host'
      ? `Dein Raum ${session.code} läuft weiter. „Zum Menü“ beendet ihn für alle.` : '';
    $('hud').classList.add('hidden');
    $('over').classList.remove('hidden');
  }

  function togglePause() {
    if (ui !== 'play' || session.kind !== 'solo') return;
    paused = !paused;
    $('pause').classList.toggle('hidden', !paused);
  }

  $('soloBtn').addEventListener('click', () => { setStatus(''); startSolo(); });
  $('hostBtn').addEventListener('click', () => startHost());
  $('joinBtn').addEventListener('click', joinRoom);
  $('onlineBtn').addEventListener('click', joinOnline);
  $('againBtn').addEventListener('click', respawn);
  $('menuBtn').addEventListener('click', () => backToMenu(''));
  nameInput.addEventListener('input', updateNameFx);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startSolo(); e.stopPropagation(); });
  $('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); e.stopPropagation(); });
  $('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

  function toggleGod() {
    const p = me();
    if (ui !== 'play' || !p || !p.alive || !isRb(p)) return;
    if (isRemote()) { if (session.link) session.link.send({ t: 'god', on: !p.invincible }); }
    else localEngine.setInvincible(localHuman, !localHuman.invincible);
  }
  godBtn.addEventListener('click', e => { e.stopPropagation(); toggleGod(); godBtn.blur(); });
  godBtn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  // ---------- Eingabe ----------
  function setMyTarget(a) {
    myTarget = a;
    if (!isRemote() && localHuman && localHuman.alive) localEngine.setTarget(localHuman, a);
  }
  function aimAt(clientX, clientY) {
    const p = me();
    if (ui !== 'play' || paused || !p || !p.alive) return;
    const hx = (viewOx + p.rx * cellPx) / dpr, hy = (viewOy + p.ry * cellPx) / dpr;
    const dx = clientX - hx, dy = clientY - hy;
    if (dx * dx + dy * dy < 16) return;
    setMyTarget(Math.atan2(dy, dx));
  }
  window.addEventListener('mousemove', e => { if (e.target !== godBtn && !godBtn.contains(e.target)) aimAt(e.clientX, e.clientY); });
  const onTouch = e => {
    if (ui !== 'play') return;
    e.preventDefault();
    const t = e.touches[0];
    if (t) aimAt(t.clientX, t.clientY);
  };
  canvas.addEventListener('touchstart', onTouch, { passive: false });
  canvas.addEventListener('touchmove', onTouch, { passive: false });

  const KEY_DIRS = {
    ArrowRight: 0, d: 0, D: 0,
    ArrowDown: Math.PI / 2, s: Math.PI / 2, S: Math.PI / 2,
    ArrowLeft: Math.PI, a: Math.PI, A: Math.PI,
    ArrowUp: -Math.PI / 2, w: -Math.PI / 2, W: -Math.PI / 2,
  };
  window.addEventListener('keydown', e => {
    if (e.key === 'p' || e.key === 'P' || e.key === 'Escape') { togglePause(); return; }
    if (e.key === 'u' || e.key === 'U') { toggleGod(); return; }
    if (e.key in KEY_DIRS) {
      e.preventDefault();
      const p = me();
      if (ui === 'play' && !paused && p && p.alive) setMyTarget(KEY_DIRS[e.key]);
    }
    if (e.key === 'Enter' && ui === 'dead' && !$('over').classList.contains('hidden')) respawn();
  });
  window.addEventListener('blur', () => { if (ui === 'play' && session.kind === 'solo' && !paused) togglePause(); });

  // ---------- Initialisierung ----------
  localEngine.prewarm(20);
  localEngine.onEvent = handleEvent;

  const savedColor = parseInt(store.get('farbrevier.color'), 10);
  if (savedColor >= 0 && savedColor < COLORS.length) humanColor = savedColor;
  nameInput.value = store.get('farbrevier.name') || '';
  updateNameFx();
  buildSwatches();
  showRecord();

  if (NO_MP) {
    $('mpBox').classList.add('hidden');
    $('mpNote').classList.remove('hidden');
  } else {
    if (!serverUrl()) $('onlineBtn').classList.add('hidden');
    const m = /^#raum-([A-Za-z0-9]{4})$/.exec(location.hash);
    if (m) {
      $('codeInput').value = m[1].toUpperCase();
      setStatus(`Einladung für Raum ${m[1].toUpperCase()}: Namen eingeben und auf „Beitreten“ tippen.`);
    }
  }

  let last = performance.now(), acc = 0, frameNo = 0, lbTimer = 0;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    if (dt < 0) dt = 0;

    if (!isRemote()) {
      if (!paused) {
        acc += dt;
        while (acc >= FE.STEP) {
          for (const q of localEngine.players) if (q) { q.px = q.x; q.py = q.y; q.pa = q.angle; }
          localEngine.step();
          if (session.kind === 'host') session.hub.afterStep();
          acc -= FE.STEP;
        }
      }
      // Zwischen zwei Simulationsschritten interpolieren → flüssig auch auf 90/120-Hz-Bildschirmen
      const alpha = paused ? 1 : Math.min(1, acc / FE.STEP);
      for (const q of localEngine.players) {
        if (!q) continue;
        if (q.px === undefined || Math.abs(q.x - q.px) + Math.abs(q.y - q.py) > 2) { q.rx = q.x; q.ry = q.y; q.ra = q.angle; continue; }
        q.rx = q.px + (q.x - q.px) * alpha;
        q.ry = q.py + (q.y - q.py) * alpha;
        q.ra = q.pa + FE.wrapAngle(q.angle - q.pa) * alpha;
      }
    } else {
      acc = 0;
      updateRemoteDisplay(dt);
      for (const q of remote.players) if (q) { q.rx = q.x; q.ry = q.y; q.ra = q.angle; }
    }

    if (!paused) {
      for (let k = particles.length - 1; k >= 0; k--) {
        const q = particles[k];
        q.x += q.vx * dt; q.y += q.vy * dt;
        q.vx *= Math.pow(0.94, dt * 60); q.vy *= Math.pow(0.94, dt * 60);
        q.life -= dt;
        if (q.life <= 0) particles.splice(k, 1);
      }
      for (let k = floaters.length - 1; k >= 0; k--) {
        const f = floaters[k];
        f.y -= dt * 1.2;
        f.life -= dt;
        if (f.life <= 0) floaters.splice(k, 1);
      }
    }

    // Kamera
    let tx = cam.x, ty = cam.y;
    const p = me();
    if (ui === 'play' && p && p.alive) { tx = p.rx; ty = p.ry; }
    else if (ui === 'dead' && deathCam) { tx = deathCam.x; ty = deathCam.y; }
    else if (ui === 'menu') {
      let leader = null;
      for (const q of world.players) if (q && q.alive && q.isBot && (!leader || q.count > leader.count)) leader = q;
      if (leader) { tx = leader.rx; ty = leader.ry; }
    }
    if (snapCam && ui === 'play' && p && p.alive) { cam.x = tx; cam.y = ty; snapCam = false; }
    const f = Math.min(1, dt * (ui === 'play' ? 14 : 2));
    cam.x += (tx - cam.x) * f;
    cam.y += (ty - cam.y) * f;

    const rt = now / 1000;
    render(rt);
    if (frameNo++ % 10 === 0) renderMinimap(rt);
    lbTimer -= dt;
    if (lbTimer <= 0) { updateLeaderboard(); updateRoomInfo(); lbTimer = 0.4; }
    updateHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // kleiner Debug-Zugang für Tests
  window.farbrevier = {
    engine: localEngine,
    get world() { return world; },
    get ui() { return ui; },
    get session() { return session; },
    get myId() { return myId; },
  };
})();
