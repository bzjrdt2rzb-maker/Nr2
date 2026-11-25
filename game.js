'use strict';
/*
 * Papierfresser – Darstellung, Eingabe, Menüs und Netzwerk im Browser.
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
  const RB_TOP = [], RB_DARK = [], RB_RGB = [], RB_TRAIL_RGB = [];
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
    RB_RGB.push(hslRgb(h, 0.9, 0.62));
    RB_TRAIL_RGB.push(hslRgb(h, 0.95, 0.82));
  }
  const RAINBOW_CSS = 'linear-gradient(135deg,#f43f5e,#f59e0b,#84cc16,#06b6d4,#8b5cf6,#ec4899)';
  const rbIndex = (x, y, t) => ((((x + y) * 3 + Math.floor(t * 24)) % HUES) + HUES) % HUES;
  const cellHash = (x, y) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  const isRb = p => FE.isRainbowName(p.name);
  const SP_CODE = { einhorn: 1, kaktus: 2, mcqueen: 3, stein: 4 };
  const blasts = [];                // kleine Stachel-Effekte, wenn der Kaktus jemanden erwischt

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
  const remote = { owner: new Uint8Array(N), trailMap: new Uint8Array(N), players: [null], time: 0, timeAt: 0, speedMul: 1 };
  const curSpeed = () => (isRemote() ? remote.speedMul : localEngine.speedMul);
  const fmtSpeed = m => String(m).replace('.', ',') + '×';
  let world = localEngine;          // was gerade gezeichnet wird: { owner, trailMap, players }
  let session = { kind: 'solo' };
  let localHuman = null;
  let myId = 0;
  let ui = 'menu';                  // menu | connecting | play | dead
  let paused = false;
  let humanColor = 7;
  let speedMul = 1;                 // im Menü gewähltes Tempo (allein + eigener Raum)
  let zoom = 1;                     // bei hohem Tempo etwas herauszoomen
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
      if (ev.r === 'cactus') blasts.push({ x: ev.x, y: ev.y, r: 1.6, life: 0.6 });
      const mine = myId !== 0 && (ev.v === myId || ev.by === myId);
      let msg;
      if (ev.r === 'self') msg = `${ev.vn} ist über die eigene Spur gestolpert`;
      else if (ev.r === 'head') msg = `${ev.kn} hat ${ev.vn} gerammt`;
      else if (ev.r === 'wiped') msg = `${ev.kn} hat ${ev.vn} komplett eingenommen`;
      else if (ev.r === 'cactus') msg = `${ev.kn} hat ${ev.vn} aufgespießt`;
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
    } else if (ev.k === 'boost') {
      const mine = myId && ev.id === myId;
      if (session.kind !== 'solo' || mine) addFeed(ev.on ? `${mine ? 'Du gibst' : ev.n + ' gibt'} Vollgas!` : `${mine ? 'Du fährst' : ev.n + ' fährt'} wieder normal`, mine);
    } else if (ev.k === 'spikes') {
      const mine = myId && ev.id === myId;
      if (session.kind !== 'solo' || mine) addFeed(ev.on ? `${mine ? 'Deine' : ev.n + 's'} Stacheln sind ausgefahren!` : `${mine ? 'Deine' : ev.n + 's'} Stacheln sind eingezogen`, mine);
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
    for (const [id, x, y, a, alive, count, kills, st, inv, bst, spk] of arr) {
      const p = remotePlayer(id);
      p.sx = x / 100; p.sy = y / 100; p.sa = a / 1000;
      p.boost = !!bst;
      p.spikes = !!spk;
      const was = p.alive;
      p.alive = !!alive;
      if ((!was && p.alive) || Math.hypot(p.x - p.sx, p.y - p.sy) > 4 + SPEED * remote.speedMul * (p.boost ? FE.BOOST : 1) * 0.15) {
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
      remote.speedMul = Number(msg.sp) || 1;
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
      if (msg.sp) remote.speedMul = Number(msg.sp) || 1;
      if (msg.m) applyMeta(msg.m);
      if (msg.p) applyPlayers(msg.p);
      remote.time = msg.time; remote.timeAt = performance.now();
      if (msg.ev) for (const ev of msg.ev) handleEvent(ev);
    } else if (msg.t === 'full-room') {
      backToMenu('Dieser Raum ist voll.', true);
    }
  }

  function updateRemoteDisplay(dt) {
    const mul = remote.speedMul;
    const myP = me();
    predAngle = FE.wrapAngle(FE.turnToward(predAngle, myTarget, TURN * mul * (myP && myP.boost ? FE.BOOST : 1) * dt));
    const now = performance.now();
    const k = Math.min(1, dt * 14);
    for (const p of remote.players) {
      if (!p || !p.alive) continue;
      const age = Math.min(0.2, (now - p.snapAt) / 1000);
      const a = p.id === myId ? predAngle : p.sa;
      const v = SPEED * mul * (p.boost ? FE.BOOST : 1);
      const tx = p.sx + Math.cos(a) * v * age, ty = p.sy + Math.sin(a) * v * age;
      p.x += (tx - p.x) * k;
      p.y += (ty - p.y) * k;
      p.angle = p.id === myId ? predAngle : FE.wrapAngle(FE.turnToward(p.angle, p.sa, 12 * mul * dt));
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
    localEngine.setSpeed(speedMul);
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
      localEngine.setSpeed(speedMul);
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
  const spFlag = new Uint8Array(256);

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
  const cellNow = () => Math.max(6, Math.round(cellPx / zoom));   // ganze Pixel → keine Lücken zwischen Zeilen

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

  const FONT = '"Fredoka", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif';

  // ---------- Gebiets-Muster für Geheimnamen ----------
  // Kaktus: Sandwüste mit Kakteen und Blüten. Lightning McQueen: Rennstrecke.
  // Die Kacheln werden nur bei neuer Zellgröße neu gezeichnet und am Spielfeld ausgerichtet.
  const SKIN_RGB = { 2: [242, 207, 134], 3: [63, 63, 70], 4: [148, 155, 168] };
  const SKIN_TRAIL_RGB = { 2: [236, 214, 170], 3: [140, 140, 150], 4: [107, 114, 128] };
  const skinCache = { cell: 0 };

  function drawCactus(g, x, y, h) {
    g.fillStyle = 'rgba(150, 100, 40, .25)';
    g.beginPath(); g.ellipse(x, y, h * 0.32, h * 0.07, 0, 0, Math.PI * 2); g.fill();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const arms = [[x, y, x, y - h], [x, y - h * 0.42, x - h * 0.32, y - h * 0.42, x - h * 0.32, y - h * 0.72],
      [x, y - h * 0.58, x + h * 0.3, y - h * 0.58, x + h * 0.3, y - h * 0.86]];
    for (const [w, col] of [[0.24, '#2f9e44'], [0.09, '#69db7c']]) {
      g.strokeStyle = col;
      g.lineWidth = h * w;
      for (const pts of arms) {
        g.beginPath();
        g.moveTo(pts[0] + (col === '#69db7c' ? -h * 0.04 : 0), pts[1]);
        for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k] + (col === '#69db7c' ? -h * 0.04 : 0), pts[k + 1]);
        g.stroke();
      }
    }
  }

  function drawFlower(g, x, y, r) {
    g.fillStyle = '#f472b6';
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
      g.beginPath(); g.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.8, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#fde047';
    g.beginPath(); g.arc(x, y, r * 0.65, 0, Math.PI * 2); g.fill();
  }

  function makeSkinTile(kind, cell) {
    const n = kind === 'kaktus' ? 6 : kind === 'stein' ? 4 : 8;   // Kachelgröße in Feldern
    const T = Math.round(cell * n);
    const c = document.createElement('canvas');
    c.width = c.height = T;
    const g = c.getContext('2d');
    let seed = kind === 'kaktus' ? 7 : kind === 'stein' ? 29 : 13;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    if (kind === 'kaktus') {
      g.fillStyle = '#f2cf86';
      g.fillRect(0, 0, T, T);
      // Dünen (Wellen mit Kachel-Periode, damit die Kacheln nahtlos sind)
      for (const [yy, col] of [[0.18, 'rgba(255,241,205,.8)'], [0.5, 'rgba(255,241,205,.8)'], [0.82, 'rgba(255,241,205,.8)']]) {
        for (const [dy, c2, lw] of [[cell * 0.12, 'rgba(196,140,60,.3)', 0.14], [0, col, 0.12]]) {
          g.strokeStyle = c2;
          g.lineWidth = cell * lw;
          g.beginPath();
          for (let x = 0; x <= T; x += 2) {
            const y = yy * T + dy + Math.sin((x / T) * Math.PI * 4 + yy * 9) * cell * 0.3;
            if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
      // Steinchen
      for (let k = 0; k < 10; k++) {
        g.fillStyle = k % 2 ? 'rgba(161,110,55,.45)' : 'rgba(255,255,255,.5)';
        g.beginPath(); g.arc(cell * (0.5 + rnd() * (n - 1)), cell * (0.5 + rnd() * (n - 1)), cell * (0.05 + rnd() * 0.06), 0, Math.PI * 2); g.fill();
      }
      drawCactus(g, cell * 1.6, cell * 4.6, cell * 2.1);
      drawCactus(g, cell * 4.4, cell * 2.2, cell * 1.4);
      drawFlower(g, cell * 1.6, cell * 2.4, cell * 0.17);   // Blüte auf dem großen Kaktus
      drawFlower(g, cell * 4.7, cell * 4.7, cell * 0.22);
      drawFlower(g, cell * 0.7, cell * 0.8, cell * 0.16);
      drawFlower(g, cell * 3.2, cell * 5.5, cell * 0.14);
    } else if (kind === 'stein') {
      // Kopfsteinpflaster: Fugen dunkel, Steine in leicht unterschiedlichen Grautönen
      g.fillStyle = '#4b5563';
      g.fillRect(0, 0, T, T);
      const greys = ['#9ca3af', '#a8afba', '#8f96a3', '#b4bac4', '#959cab'];
      const sz = T / 4;
      for (let row = 0; row < 4; row++) {
        const shift = row % 2 ? sz / 2 : 0;
        for (let col = -1; col < 4; col++) {
          const x = col * sz + shift, y = row * sz;
          const gap = cell * 0.08, w = sz - gap * 2, h = sz - gap * 2;
          g.fillStyle = greys[Math.floor(rnd() * greys.length)];
          g.beginPath();
          g.roundRect ? g.roundRect(x + gap, y + gap, w, h, sz * 0.3) : g.rect(x + gap, y + gap, w, h);
          g.fill();
          g.fillStyle = 'rgba(255,255,255,.18)';
          g.beginPath(); g.ellipse(x + sz * 0.38, y + sz * 0.32, sz * 0.22, sz * 0.1, -0.3, 0, Math.PI * 2); g.fill();
          if (rnd() < 0.4) {
            g.strokeStyle = 'rgba(55,65,81,.5)';
            g.lineWidth = cell * 0.04;
            g.beginPath(); g.moveTo(x + sz * 0.3, y + sz * 0.55); g.lineTo(x + sz * 0.5, y + sz * 0.7); g.lineTo(x + sz * 0.65, y + sz * 0.62); g.stroke();
          }
        }
      }
    } else {
      // Asphalt mit Körnung
      g.fillStyle = '#3f3f46';
      g.fillRect(0, 0, T, T);
      for (let k = 0; k < n * n * 6; k++) {
        g.fillStyle = k % 2 ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.18)';
        g.fillRect(rnd() * T, rnd() * T, cell * 0.06, cell * 0.06);
      }
      // Reifenspuren
      g.strokeStyle = 'rgba(0,0,0,.28)';
      g.lineWidth = cell * 0.12;
      for (const off of [0, cell * 0.35]) {
        g.beginPath();
        g.moveTo(cell * 0.8, cell * 6.6 + off);
        g.quadraticCurveTo(cell * 3, cell * 5.6 + off, cell * 5.5, cell * 6.4 + off);
        g.stroke();
      }
      // Fahrbahnmarkierungen
      g.fillStyle = '#f4f4f5';
      for (let k = 0; k < n / 2; k++) g.fillRect(cell * (k * 2 + 0.3), cell * 1.92, cell * 1.3, cell * 0.16);
      g.fillStyle = 'rgba(250, 204, 21, .9)';
      for (let k = 0; k < n / 2; k++) g.fillRect(cell * (k * 2 + 1.3), cell * 5.92, cell * 1.3, cell * 0.16);
      // kleine Start-/Ziellinie
      const q = cell * 0.25;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) {
        g.fillStyle = (i + j) % 2 ? '#18181b' : '#fafafa';
        g.fillRect(cell * 6.2 + i * q, cell * 3 + j * q, q, q);
      }
    }
    return c;
  }

  function skinPattern(kind, cell, ox, oy) {
    if (skinCache.cell !== cell) { skinCache.cell = cell; skinCache.kaktus = null; skinCache.mcqueen = null; skinCache.stein = null; }
    if (!skinCache[kind]) skinCache[kind] = ctx.createPattern(makeSkinTile(kind, cell), 'repeat');
    const pat = skinCache[kind];
    if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy]));
    return pat;
  }

  // Punktraster als Hintergrund-Muster (wird nur bei neuer Zellgröße neu erzeugt)
  let bgPattern = null, bgPatternCell = 0;
  function bgPatternFor(cell) {
    if (bgPattern && bgPatternCell === cell) return bgPattern;
    // 2×2 Felder: helles Papier mit bunten Konfetti-Punkten
    const c = document.createElement('canvas');
    c.width = c.height = cell * 2;
    const g = c.getContext('2d');
    g.fillStyle = '#fffaf0';
    g.fillRect(0, 0, cell * 2, cell * 2);
    const dots = ['#ffc8dd', '#bde0fe', '#caffbf', '#ffe5a0'];
    for (let k = 0; k < 4; k++) {
      g.fillStyle = dots[k];
      g.beginPath();
      g.arc(((k % 2) + 0.5) * cell, (((k >> 1) + 0.5)) * cell, Math.max(1.5, cell * 0.1), 0, Math.PI * 2);
      g.fill();
    }
    bgPattern = ctx.createPattern(c, 'repeat');
    bgPatternCell = cell;
    return bgPattern;
  }

  // ---------- Weiche Konturen ----------
  // Das Raster wird pro Spieler leicht geglättet (Mitte + Nachbarn) und daraus
  // mit "Marching Squares" eine weiche Umrisslinie berechnet. So werden aus
  // Treppenstufen runde Kurven.
  let fieldBuf = new Float32Array(0);
  function smoothField(src, id, xa, ya, ww, wh) {
    if (fieldBuf.length < ww * wh) fieldBuf = new Float32Array(ww * wh * 2);
    const v = fieldBuf;
    const occ = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : (src[y * W + x] === id ? 1 : 0));
    for (let j = 0; j < wh; j++) {
      const y = ya + j;
      for (let i = 0; i < ww; i++) {
        const x = xa + i;
        if (i === 0 || j === 0 || i === ww - 1 || j === wh - 1) { v[j * ww + i] = 0; continue; }
        v[j * ww + i] = 0.5 * occ(x, y)
          + 0.1 * (occ(x - 1, y) + occ(x + 1, y) + occ(x, y - 1) + occ(x, y + 1))
          + 0.025 * (occ(x - 1, y - 1) + occ(x + 1, y - 1) + occ(x - 1, y + 1) + occ(x + 1, y + 1));
      }
    }
    return v;
  }

  // Fließender Regenbogen-Verlauf über den Bildschirm (diagonal, bewegt sich mit der Zeit).
  // Ein Farbzyklus entspricht 16 Feldern – passend zur Minikarte.
  function rainbowGradient(ox, oy, cell, rt, light, alpha) {
    const D = cw + ch;
    const g = ctx.createLinearGradient(0, 0, D, D);
    const cycles = (2 * D) / cell / 16;
    const n = Math.min(400, Math.ceil(cycles * 12) + 2);
    for (let k = 0; k <= n; k++) {
      const pos = k / n;
      const sum = (pos * 2 * D - ox - oy) / cell;               // ≈ x + y in Feldern
      const hue = ((((sum * 3 + rt * 24) / HUES) * 360) % 360 + 360) % 360;
      g.addColorStop(pos, `hsla(${hue.toFixed(1)},90%,${light}%,${alpha})`);
    }
    return g;
  }

  // Berechnet aus dem geglätteten Feld geschlossene Umrisslinien (Marching Squares)
  // und fügt sie als weiche Kurven zum Pfad hinzu. Füllen mit 'evenodd' (Löcher!).
  // Segmente je Fall: Kanten 0=oben 1=rechts 2=unten 3=links
  const MS_SEGS = [[], [3, 2], [2, 1], [3, 1], [0, 1], [3, 0, 2, 1], [0, 2], [3, 0],
    [3, 0], [0, 2], [0, 1, 3, 2], [0, 1], [3, 1], [2, 1], [3, 2], []];
  let msNb1 = new Int32Array(0), msNb2 = new Int32Array(0), msX = new Float32Array(0), msY = new Float32Array(0), msSeen = new Uint8Array(0);
  function traceInto(path, v, ww, wh, xa, ya, iso, cell, ox, oy) {
    const E = ww * wh * 2;
    if (msNb1.length < E) {
      msNb1 = new Int32Array(E * 2); msNb2 = new Int32Array(E * 2);
      msX = new Float32Array(E * 2); msY = new Float32Array(E * 2); msSeen = new Uint8Array(E * 2);
    }
    const used = [];
    const edgeId = (i, j, k) => (k === 0 ? (j * ww + i) * 2 : k === 2 ? ((j + 1) * ww + i) * 2 : k === 3 ? (j * ww + i) * 2 + 1 : (j * ww + i + 1) * 2 + 1);
    for (let j = 0; j < wh - 1; j++) {
      for (let i = 0; i < ww - 1; i++) {
        const a = v[j * ww + i], b = v[j * ww + i + 1], c = v[(j + 1) * ww + i + 1], d = v[(j + 1) * ww + i];
        const cs = (a >= iso ? 8 : 0) | (b >= iso ? 4 : 0) | (c >= iso ? 2 : 0) | (d >= iso ? 1 : 0);
        const segs = MS_SEGS[cs];
        if (!segs.length) continue;
        const X0 = ox + (xa + i + 0.5) * cell, Y0 = oy + (ya + j + 0.5) * cell;
        for (let s2 = 0; s2 < segs.length; s2 += 2) {
          const ids = [];
          for (const k of [segs[s2], segs[s2 + 1]]) {
            const id = edgeId(i, j, k);
            if (!msSeen[id]) {
              msSeen[id] = 1; msNb1[id] = -1; msNb2[id] = -1; used.push(id);
              if (k === 0) { msX[id] = X0 + cell * (iso - a) / (b - a); msY[id] = Y0; }
              else if (k === 2) { msX[id] = X0 + cell * (iso - d) / (c - d); msY[id] = Y0 + cell; }
              else if (k === 3) { msX[id] = X0; msY[id] = Y0 + cell * (iso - a) / (d - a); }
              else { msX[id] = X0 + cell; msY[id] = Y0 + cell * (iso - b) / (c - b); }
            }
            ids.push(id);
          }
          const [e1, e2] = ids;
          if (msNb1[e1] < 0) msNb1[e1] = e2; else msNb2[e1] = e2;
          if (msNb1[e2] < 0) msNb1[e2] = e1; else msNb2[e2] = e1;
        }
      }
    }
    // Schleifen ablaufen und als Kurve durch die Kantenmitten zeichnen
    for (const start of used) {
      if (msSeen[start] !== 1) continue;
      const xs = [], ys = [];
      let prev = -1, cur = start;
      while (cur >= 0 && msSeen[cur] === 1) {
        msSeen[cur] = 2;
        xs.push(msX[cur]); ys.push(msY[cur]);
        const nxt = msNb1[cur] !== prev ? msNb1[cur] : msNb2[cur];
        prev = cur; cur = nxt;
      }
      const n = xs.length;
      if (n < 3) continue;
      path.moveTo((xs[n - 1] + xs[0]) / 2, (ys[n - 1] + ys[0]) / 2);
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        path.quadraticCurveTo(xs[k], ys[k], (xs[k] + xs[k2]) / 2, (ys[k] + ys[k2]) / 2);
      }
      path.closePath();
    }
    for (const id of used) msSeen[id] = 0;
  }

  function render(rt) {
    const cell = cellNow();
    const { owner, trailMap, players } = world;
    const ox = Math.round(cw / 2 - cam.x * cell), oy = Math.round(ch / 2 - cam.y * cell);
    viewOx = ox; viewOy = oy;

    rbFlag.fill(0);
    spFlag.fill(0);
    let anyRb = false;
    for (const p of players) {
      if (!p) continue;
      const sp = SP_CODE[FE.specialOf(p.name)] || 0;
      spFlag[p.id] = sp;
      if (sp === 1) { rbFlag[p.id] = 1; anyRb = true; }
    }

    // Hintergrund außerhalb und Spielfeld mit runden Ecken
    const bg = ctx.createLinearGradient(0, 0, cw, ch);
    bg.addColorStop(0, '#7c3aed');
    bg.addColorStop(0.5, '#ec4899');
    bg.addColorStop(1, '#fb923c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch);
    const mapR = cell * 0.8;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = cell * 0.5;
    rrect(ox - cell * 0.25, oy - cell * 0.25, W * cell + cell * 0.5, H * cell + cell * 0.5, mapR + cell * 0.25);
    ctx.stroke();
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = bgPatternFor(cell);
    rrect(0, 0, W * cell, H * cell, mapR);
    ctx.fill();
    ctx.restore();
    const mapClip = new Path2D();
    mapClip.roundRect ? mapClip.roundRect(ox, oy, W * cell, H * cell, mapR) : mapClip.rect(ox, oy, W * cell, H * cell);

    const x0 = Math.max(0, Math.floor(-ox / cell) - 1), x1 = Math.min(W - 1, Math.ceil((cw - ox) / cell) + 1);
    const y0 = Math.max(0, Math.floor(-oy / cell) - 1), y1 = Math.min(H - 1, Math.ceil((ch - oy) / cell) + 1);

    // Welche Spieler haben Gebiet bzw. Spur im sichtbaren Ausschnitt?
    const xa = x0 - 2, ya = y0 - 2, ww = x1 - x0 + 5, wh = y1 - y0 + 5;
    const ownIds = new Set(), trailIds = new Set();
    for (let y = Math.max(0, ya); y <= Math.min(H - 1, ya + wh - 1); y++)
      for (let x = Math.max(0, xa); x <= Math.min(W - 1, xa + ww - 1); x++) {
        const i = y * W + x;
        if (owner[i] && players[owner[i]]) ownIds.add(owner[i]);
        if (trailMap[i] && players[trailMap[i]]) trailIds.add(trailMap[i]);
      }

    // Gebiete: weiche Formen, je Spieler ein Pfad
    let rbTop = null, rbDark = null, rbTrail = null;
    if (anyRb) {
      rbTop = rainbowGradient(ox, oy, cell, rt, 64, 1);
      rbDark = rainbowGradient(ox, oy, cell, rt, 44, 1);
      rbTrail = rainbowGradient(ox, oy, cell, rt, 74, 0.7);
    }
    const groups = [];
    for (const o of ownIds) {
      const col = colorOf(players[o]);
      const sp = spFlag[o];
      const g = { path: new Path2D(), sp, top: col.base, dark: col.dark };
      if (sp === 1) { g.top = rbTop; g.dark = rbDark; }
      else if (sp === 2) { g.top = skinPattern('kaktus', cell, ox, oy); g.dark = '#c9974a'; }
      else if (sp === 3) { g.top = skinPattern('mcqueen', cell, ox, oy); g.dark = '#1f1f23'; }
      else if (sp === 4) { g.top = skinPattern('stein', cell, ox, oy); g.dark = '#374151'; }
      traceInto(g.path, smoothField(owner, o, xa, ya, ww, wh), ww, wh, xa, ya, 0.4, cell, ox, oy);
      groups.push(g);
    }
    const depth = Math.max(2, Math.round(cell * 0.16));
    ctx.save();
    ctx.clip(mapClip);
    ctx.save();
    ctx.translate(0, depth);
    for (const g of groups) { ctx.fillStyle = g.dark; ctx.fill(g.path, 'evenodd'); }
    ctx.restore();
    for (const g of groups) { ctx.fillStyle = g.top; ctx.fill(g.path, 'evenodd'); }

    // Rennstrecke: rot-weiße Randsteine um McQueen-Gebiete, Sandkante um Kaktus-Gebiete
    for (const g of groups) {
      if (g.sp === 3) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(3, cell * 0.3);
        ctx.strokeStyle = '#ef4444';
        ctx.stroke(g.path);
        ctx.setLineDash([cell * 0.55, cell * 0.55]);
        ctx.strokeStyle = '#ffffff';
        ctx.stroke(g.path);
        ctx.setLineDash([]);
      } else if (g.sp === 2) {
        ctx.lineWidth = Math.max(1.5, cell * 0.1);
        ctx.strokeStyle = 'rgba(180, 120, 50, .55)';
        ctx.stroke(g.path);
      } else if (g.sp === 4) {
        ctx.lineWidth = Math.max(1.5, cell * 0.12);
        ctx.strokeStyle = '#374151';
        ctx.stroke(g.path);
      }
    }

    // Spuren als weiche Schläuche
    for (const t of trailIds) {
      const path = new Path2D();
      if (spFlag[t] === 4) {
        // Stein: doppelt so breite, massive Steinmauer
        traceInto(path, smoothField(trailMap, t, xa, ya, ww, wh), ww, wh, xa, ya, 0.2, cell, ox, oy);
        ctx.save();
        ctx.translate(0, depth);
        ctx.fillStyle = '#374151';
        ctx.fill(path, 'evenodd');
        ctx.restore();
        ctx.fillStyle = skinPattern('stein', cell, ox, oy);
        ctx.fill(path, 'evenodd');
        ctx.lineWidth = Math.max(1.5, cell * 0.1);
        ctx.strokeStyle = '#374151';
        ctx.stroke(path);
        continue;
      }
      traceInto(path, smoothField(trailMap, t, xa, ya, ww, wh), ww, wh, xa, ya, 0.5, cell, ox, oy);
      ctx.fillStyle = rbFlag[t] ? rbTrail : spFlag[t] === 2 ? 'rgba(222, 178, 96, .75)' : spFlag[t] === 3 ? 'rgba(63, 63, 70, .6)' : colorOf(players[t]).trail;
      ctx.fill(path, 'evenodd');
    }
    ctx.restore();

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

    // Spieler
    const hr = cell * 0.56;
    const size = hr * 2;
    for (const p of players) {
      if (!p || !p.alive) continue;
      const sx = ox + p.rx * cell, sy = oy + p.ry * cell;
      if (sx < -cell * 4 || sy < -cell * 4 || sx > cw + cell * 4 || sy > ch + cell * 4) continue;
      const rb = rbFlag[p.id] === 1;
      const col = colorOf(p);

      // Kaktus mit ausgefahrenen Stacheln: Gefahrenzone mit drehendem Stachelkranz
      if (p.spikes) {
        const R = FE.SPIKE_RADIUS * cell;
        const pulse = 0.5 + 0.5 * Math.sin(rt * 5);
        ctx.fillStyle = `rgba(34, 197, 94, ${0.1 + 0.06 * pulse})`;
        ctx.beginPath(); ctx.arc(sx, sy, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(22, 163, 74, .85)';
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.setLineDash([cell * 0.4, cell * 0.25]);
        ctx.lineDashOffset = -rt * cell * 2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#15803d';
        const nSp = 28;
        for (let k = 0; k < nSp; k++) {
          const a = (k / nSp) * Math.PI * 2 + rt * 0.6;
          const ca = Math.cos(a), sa = Math.sin(a), w = cell * 0.18;
          ctx.beginPath();
          ctx.moveTo(sx + ca * (R + cell * 0.5), sy + sa * (R + cell * 0.5));
          ctx.lineTo(sx + ca * R - sa * w, sy + sa * R + ca * w);
          ctx.lineTo(sx + ca * R + sa * w, sy + sa * R - ca * w);
          ctx.closePath();
          ctx.fill();
        }
      }

      // Unsterblich: pulsierender Leuchtring
      if (p.invincible) {
        const pulse = 0.5 + 0.5 * Math.sin(rt * 8);
        ctx.save();
        ctx.shadowColor = '#fde68a';
        ctx.shadowBlur = cell * (0.4 + 0.4 * pulse);
        ctx.strokeStyle = `rgba(253, 230, 138, ${0.6 + 0.4 * pulse})`;
        ctx.lineWidth = Math.max(2, cell * 0.12);
        ctx.beginPath();
        ctx.arc(sx, sy + depth / 2, hr * (1.45 + 0.15 * pulse), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Körper: runde Kugel (Stein: Felsbrocken) mit Unterkante, Rand und Glanzlicht
      const sp = spFlag[p.id];
      const bodyPath = y => {
        ctx.beginPath();
        if (sp === 4) {
          const f = [1.08, 0.92, 1.04, 0.95, 1.1, 0.9, 1.02, 0.96, 1.06];
          for (let k = 0; k < f.length; k++) {
            const a = (k / f.length) * Math.PI * 2 - 0.3;
            const r2 = hr * 1.05 * f[k];
            if (k === 0) ctx.moveTo(sx + Math.cos(a) * r2, y + Math.sin(a) * r2);
            else ctx.lineTo(sx + Math.cos(a) * r2, y + Math.sin(a) * r2);
          }
          ctx.closePath();
        } else ctx.arc(sx, y, hr, 0, Math.PI * 2);
      };
      let fill;
      if (rb) {
        const k = rbIndex(Math.floor(p.rx), Math.floor(p.ry), rt);
        ctx.fillStyle = RB_DARK[k];
        const g = ctx.createLinearGradient(sx - hr, sy - hr, sx + hr, sy + hr);
        for (let s = 0; s <= 4; s++) g.addColorStop(s / 4, RB_TOP[(k + s * 8) % HUES]);
        fill = g;
      } else {
        ctx.fillStyle = col.dark;
        fill = col.base;
      }
      if (sp === 4) { ctx.fillStyle = '#374151'; fill = '#9ca3af'; }
      bodyPath(sy + depth); ctx.fill();
      ctx.fillStyle = fill;
      bodyPath(sy); ctx.fill();
      ctx.strokeStyle = sp === 4 ? '#374151' : '#fff';
      ctx.lineWidth = Math.max(1.5, cell * 0.09);
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.28)';
      ctx.beginPath(); ctx.ellipse(sx - hr * 0.3, sy - hr * 0.38, hr * 0.42, hr * 0.24, -0.5, 0, Math.PI * 2); ctx.fill();
      if (sp === 4) {
        // Risse im Felsbrocken
        ctx.strokeStyle = 'rgba(55, 65, 81, .75)';
        ctx.lineWidth = Math.max(1, cell * 0.05);
        ctx.beginPath();
        ctx.moveTo(sx + hr * 0.55, sy - hr * 0.55); ctx.lineTo(sx + hr * 0.3, sy - hr * 0.2); ctx.lineTo(sx + hr * 0.45, sy + hr * 0.05);
        ctx.moveTo(sx - hr * 0.7, sy + hr * 0.3); ctx.lineTo(sx - hr * 0.4, sy + hr * 0.5);
        ctx.stroke();
      }
      if (sp === 2) {
        // Kaktus: Rillen und Stacheln rundherum
        ctx.save();
        ctx.beginPath(); ctx.arc(sx, sy, hr * 0.92, 0, Math.PI * 2); ctx.clip();
        ctx.strokeStyle = 'rgba(21, 128, 61, .7)';
        ctx.lineWidth = Math.max(1, cell * 0.06);
        for (const f of [-0.5, 0, 0.5]) {
          ctx.beginPath(); ctx.ellipse(sx + f * hr, sy, hr * 0.12, hr, 0, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = '#fff';
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2 + 0.26;
          const ca = Math.cos(a), sa = Math.sin(a);
          ctx.beginPath();
          ctx.moveTo(sx + ca * (hr + hr * 0.38), sy + sa * (hr + hr * 0.38));
          ctx.lineTo(sx + ca * hr * 0.95 - sa * hr * 0.1, sy + sa * hr * 0.95 + ca * hr * 0.1);
          ctx.lineTo(sx + ca * hr * 0.95 + sa * hr * 0.1, sy + sa * hr * 0.95 - ca * hr * 0.1);
          ctx.closePath();
          ctx.fill();
        }
      }

      // Augen
      const c = Math.cos(p.ra), s = Math.sin(p.ra);
      const ex = c * size * 0.15, ey = s * size * 0.15;
      const px = -s * size * 0.19, py = c * size * 0.19;
      for (const sign of [-1, 1]) {
        const cx2 = sx + ex + px * sign, cy2 = sy + ey + py * sign;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx2, cy2, size * 0.14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1f2430';
        ctx.beginPath(); ctx.arc(cx2 + c * size * 0.055, cy2 + s * size * 0.055, size * 0.075, 0, Math.PI * 2); ctx.fill();
      }

      let nameY = sy - hr - cell * 0.2;
      if (sp === 2) {
        // Kaktus: pinke Blüte oben drauf
        const fx = sx + hr * 0.15, fy = sy - hr * 1.05, pr = hr * 0.2;
        ctx.fillStyle = '#f472b6';
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 - Math.PI / 2;
          ctx.beginPath(); ctx.arc(fx + Math.cos(a) * pr, fy + Math.sin(a) * pr, pr * 0.85, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = '#fde047';
        ctx.beginPath(); ctx.arc(fx, fy, pr * 0.7, 0, Math.PI * 2); ctx.fill();
        nameY = fy - pr * 1.9;
      } else if (sp === 3) {
        // Lightning McQueen: gelber Blitz oben drauf
        const bx = sx, by = sy - hr * 0.7, u = hr * 0.32;
        ctx.beginPath();
        ctx.moveTo(bx + u * 0.6, by - u * 2.6);
        ctx.lineTo(bx - u * 1.1, by - u * 0.6);
        ctx.lineTo(bx - u * 0.05, by - u * 0.6);
        ctx.lineTo(bx - u * 0.6, by + u * 0.9);
        ctx.lineTo(bx + u * 1.1, by - u * 1.2);
        ctx.lineTo(bx + u * 0.05, by - u * 1.2);
        ctx.closePath();
        ctx.fillStyle = '#facc15';
        ctx.fill();
        ctx.strokeStyle = '#b45309';
        ctx.lineWidth = Math.max(1, cell * 0.04);
        ctx.lineJoin = 'round';
        ctx.stroke();
        nameY = by - u * 2.8;
      }

      // Einhorn-Horn
      if (rb) {
        const bx = sx, by = sy - hr * 0.75, tipX = bx + size * 0.05, tipY = by - size * 0.6;
        ctx.beginPath();
        ctx.moveTo(bx - size * 0.15, by);
        ctx.quadraticCurveTo(bx, by + size * 0.06, bx + size * 0.15, by);
        ctx.lineTo(tipX, tipY);
        ctx.closePath();
        ctx.fillStyle = '#fcd34d';
        ctx.fill();
        ctx.strokeStyle = '#d97706';
        ctx.lineWidth = Math.max(1, cell * 0.04);
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.beginPath();
        for (const f of [0.3, 0.6]) {
          const lx = bx - size * 0.15 + (tipX - (bx - size * 0.15)) * f, ly = by + (tipY - by) * f;
          const rx = bx + size * 0.15 + (tipX - (bx + size * 0.15)) * f;
          ctx.moveTo(lx, ly + size * 0.03);
          ctx.lineTo(rx, ly - size * 0.03);
        }
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(rt * 6);
        sparkle(tipX, tipY - size * 0.04, size * 0.16);
        ctx.globalAlpha = 1;
        nameY = tipY - cell * 0.15;
      }

      // Namensschild
      const fs = Math.max(10, Math.round(cell * 0.42));
      ctx.font = `800 ${fs}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(p.name).width;
      const ph = fs * 1.45, pw = tw + fs * 1.1;
      rrect(sx - pw / 2, nameY - ph, pw, ph, ph / 2);
      ctx.fillStyle = rb ? '#c026d3' : col.dark;
      ctx.fill();
      if (p.id === myId) { ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, fs * 0.16); ctx.stroke(); }
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, sx, nameY - ph / 2 + fs * 0.05);
    }

    // Partikel
    for (const q of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, q.life * 1.5));
      ctx.fillStyle = q.color;
      ctx.beginPath();
      ctx.arc(ox + q.x * cell, oy + q.y * cell, (q.size * cell) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Kaktus-Stachelringe
    for (const b of blasts) {
      const t = 1 - b.life / 0.6;
      const R = b.r * cell * (0.25 + 0.75 * Math.sqrt(t));
      const bx = ox + b.x * cell, by = oy + b.y * cell;
      ctx.globalAlpha = Math.max(0, b.life / 0.6);
      ctx.fillStyle = 'rgba(34, 197, 94, .18)';
      ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#16a34a';
      ctx.lineWidth = Math.max(2, cell * 0.14);
      ctx.stroke();
      ctx.fillStyle = '#15803d';
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2 + t;
        const ca = Math.cos(a), sa = Math.sin(a), w = cell * 0.22;
        ctx.beginPath();
        ctx.moveTo(bx + ca * (R + cell * 0.6), by + sa * (R + cell * 0.6));
        ctx.lineTo(bx + ca * R - sa * w, by + sa * R + ca * w);
        ctx.lineTo(bx + ca * R + sa * w, by + sa * R - ca * w);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Eroberungs-Anzeige
    for (const f of floaters) {
      ctx.globalAlpha = Math.min(1, f.life * 2);
      ctx.font = `900 ${Math.round(cell * 0.75)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = cell * 0.18;
      ctx.lineJoin = 'round';
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
      if (t && players[t]) rgb = rbFlag[t] ? RB_TRAIL_RGB[rbIndex(i % W, (i / W) | 0, rt)] : SKIN_TRAIL_RGB[spFlag[t]] || colorOf(players[t]).trailRgb;
      else if (o && players[o]) rgb = rbFlag[o] ? RB_RGB[rbIndex(i % W, (i / W) | 0, rt)] : SKIN_RGB[spFlag[o]] || colorOf(players[o]).rgb;
      const k = i * 4;
      if (rgb) { d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; } else { d[k] = 255; d[k + 1] = 250; d[k + 2] = 240; }
      d[k + 3] = 255;
    }
    moctx.putImageData(miniImg, 0, 0);
    const mw = mini.width, mh = mini.height;
    mctx.imageSmoothingEnabled = true;
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(miniOff, 0, 0, mw, mh);
    const cell = cellNow();
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
      const rb = isRb(p);
      const dot = rb ? RAINBOW_CSS : colorOf(p).base;
      const [r, g, b] = colorOf(p).rgb;
      const a = p.id === myId ? 0.32 : 0.16;
      const tint = rb ? `linear-gradient(90deg,rgba(255,95,109,${a}),rgba(255,230,109,${a}),rgba(79,195,247,${a}),rgba(140,124,255,${a}))` : `rgba(${r},${g},${b},${a})`;
      const tag = showHumans && !p.isBot && p.id !== myId ? '<span class="human" title="Mensch">●</span>' : '';
      return `<div class="row${p.id === myId ? ' me' : ''}" style="background:${tint}"><span class="rank r${rank}">${rank}</span>` +
        `<span class="dot" style="background:${dot}"></span>` +
        `<span class="name">${tag}${esc(p.name)}</span><span>${fmtPct((p.count / N) * 100)}</span></div>`;
    };
    alive.slice(0, 6).forEach((p, k) => { html += rowHtml(p, k + 1); });
    const my = me();
    const myRank = my ? alive.indexOf(my) : -1;
    if (myRank >= 6) html += rowHtml(my, myRank + 1);
    lbEl.innerHTML = html;
  }

  const powerBtn = $('powerBtn');
  const statsEl = $('stats');
  function updateHud() {
    const p = me();
    if (p) {
      const bgc = isRb(p) ? RAINBOW_CSS : `linear-gradient(135deg, ${colorOf(p).base}, ${colorOf(p).dark})`;
      if (statsEl.dataset.bg !== bgc) { statsEl.dataset.bg = bgc; statsEl.style.background = bgc; }
    }
    // Spezialkraft-Knopf für Geheimnamen
    let kind = ui === 'play' && p && p.alive ? FE.specialOf(p.name) : null;
    if (kind === 'stein') kind = null;   // Stein braucht keinen Knopf – seine Kraft wirkt immer
    if (powerBtn.hidden === !!kind) powerBtn.hidden = !kind;
    if (kind) {
      let label, on = false;
      if (kind === 'einhorn') { on = !!p.invincible; label = `🦄 Unsterblich: ${on ? 'AN' : 'AUS'}`; }
      else if (kind === 'mcqueen') { on = !!p.boost; label = `⚡ Turbo 5×: ${on ? 'AN' : 'AUS'}`; }
      else { on = !!p.spikes; label = `🌵 Stacheln: ${on ? 'AN' : 'AUS'}`; }
      if (powerBtn.textContent !== label) powerBtn.textContent = label;
      if (powerBtn.dataset.kind !== kind) powerBtn.dataset.kind = kind;
      powerBtn.classList.toggle('on', on);
      powerBtn.setAttribute('aria-pressed', String(on));
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
      html = `<div><b>Raum ${session.code}</b> · ${humans} Spieler · ${fmtSpeed(curSpeed())}</div>` +
        '<button id="copyLinkBtn" type="button">Einladungslink kopieren</button>';
    } else if (session.kind === 'guest') {
      html = `<div><b>Raum ${esc(session.code)}</b> · ${humans} Spieler · ${fmtSpeed(curSpeed())}</div>`;
    } else {
      html = `<div><b>Online</b> · ${humans} Spieler · ${fmtSpeed(curSpeed())}</div>`;
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

  function buildSpeedBtns() {
    const el = $('speedBtns');
    el.innerHTML = '';
    for (const m of FE.SPEEDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = fmtSpeed(m);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(m === speedMul));
      if (m === speedMul) b.className = 'sel';
      b.addEventListener('click', () => {
        speedMul = m;
        store.set('farbrevier.speed', String(m));
        if (session.kind === 'solo') localEngine.setSpeed(m);   // Vorschau im Hintergrund
        buildSpeedBtns();
      });
      el.appendChild(b);
    }
  }

  function updateNameFx() {
    const kind = FE.specialOf(nameInput.value);
    for (const k of ['einhorn', 'kaktus', 'mcqueen', 'stein']) nameInput.classList.toggle(k, kind === k);
  }

  function showGameOver() {
    if (ui !== 'dead' || !lastRun) return;
    const r = lastRun;
    const reasons = {
      self: 'Du bist über deine eigene Spur gefahren.',
      head: `${r.killer || 'Jemand'} hat dich frontal gerammt.`,
      wiped: `${r.killer || 'Jemand'} hat dein ganzes Gebiet eingenommen.`,
      cactus: `${r.killer || 'Jemand'} hat dich mit Stacheln erwischt.`,
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

  // Spezialkraft auslösen: Einhorn = unsterblich an/aus, McQueen = Turbo an/aus, Kaktus = Stacheln
  function usePower() {
    const p = me();
    if (ui !== 'play' || !p || !p.alive) return;
    const kind = FE.specialOf(p.name);
    const send = m => { if (session.link) session.link.send(m); };
    if (kind === 'einhorn') {
      if (isRemote()) send({ t: 'god', on: !p.invincible }); else localEngine.setInvincible(localHuman, !localHuman.invincible);
    } else if (kind === 'mcqueen') {
      if (isRemote()) send({ t: 'boost', on: !p.boost }); else localEngine.setBoost(localHuman, !localHuman.boost);
    } else if (kind === 'kaktus') {
      if (isRemote()) send({ t: 'spikes', on: !p.spikes }); else localEngine.setSpikes(localHuman, !localHuman.spikes);
    }
  }
  powerBtn.addEventListener('click', e => { e.stopPropagation(); usePower(); powerBtn.blur(); });
  powerBtn.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });

  // ---------- Eingabe ----------
  function setMyTarget(a) {
    myTarget = a;
    if (!isRemote() && localHuman && localHuman.alive) localEngine.setTarget(localHuman, a);
  }
  function aimAt(clientX, clientY) {
    const p = me();
    if (ui !== 'play' || paused || !p || !p.alive) return;
    const hx = (viewOx + p.rx * cellNow()) / dpr, hy = (viewOy + p.ry * cellNow()) / dpr;
    const dx = clientX - hx, dy = clientY - hy;
    if (dx * dx + dy * dy < 16) return;
    setMyTarget(Math.atan2(dy, dx));
  }
  window.addEventListener('mousemove', e => { if (e.target !== powerBtn && !powerBtn.contains(e.target)) aimAt(e.clientX, e.clientY); });
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
    if (e.key === 'u' || e.key === 'U' || e.key === ' ') { e.preventDefault(); usePower(); return; }
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
  const savedSpeed = parseFloat(store.get('farbrevier.speed'));
  if (FE.SPEEDS.indexOf(savedSpeed) >= 0) speedMul = savedSpeed;
  localEngine.setSpeed(speedMul);
  buildSpeedBtns();
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
        if (q.px === undefined || Math.abs(q.x - q.px) + Math.abs(q.y - q.py) > 2 + 3 * SPEED * localEngine.speedMul * FE.BOOST * FE.STEP) { q.rx = q.x; q.ry = q.y; q.ra = q.angle; continue; }
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
      for (let k = blasts.length - 1; k >= 0; k--) {
        blasts[k].life -= dt;
        if (blasts[k].life <= 0) blasts.splice(k, 1);
      }
      // Turbo-Flammen hinter Lightning McQueen
      for (const q of world.players) {
        if (!q || !q.alive || !q.boost || q.rx === undefined) continue;
        for (let n = 0; n < 2; n++) {
          const a = q.ra + Math.PI + rand(-0.35, 0.35), v = rand(3, 7);
          particles.push({
            x: q.rx + Math.cos(q.ra + Math.PI) * 0.55, y: q.ry + Math.sin(q.ra + Math.PI) * 0.55,
            vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.2, 0.4),
            color: ['#facc15', '#fb923c', '#ef4444'][n + (Math.random() < 0.5 ? 0 : 1)], size: rand(0.25, 0.45),
          });
        }
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
    if (ui === 'play' && p && p.alive) { cam.x = tx; cam.y = ty; }   // Kamera klebt an der eigenen Figur
    else {
      const f = Math.min(1, dt * 2);
      cam.x += (tx - cam.x) * f;
      cam.y += (ty - cam.y) * f;
    }
    const zTarget = 1 + 0.22 * Math.log2(curSpeed() * (p && p.alive && p.boost ? 2.5 : 1));
    zoom += (zTarget - zoom) * Math.min(1, dt * 3);

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
