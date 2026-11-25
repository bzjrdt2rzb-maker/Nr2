'use strict';
/*
 * Farbrevier – ein Gebietseroberungs-Spiel mit Bots.
 * Die Karte ist ein Raster. Jede Zelle hat einen Besitzer (owner) und kann
 * zusätzlich Teil einer Spur (trailMap) sein. Wer mit seiner Spur in das eigene
 * Gebiet zurückkehrt, bekommt alle umschlossenen Zellen.
 */
(() => {
  // ---------- Konstanten ----------
  const W = 110, H = 110, N = W * H;
  const SPEED = 7.0;          // Zellen pro Sekunde
  const TURN = 5.5;           // max. Drehgeschwindigkeit (rad/s)
  const STEP = 1 / 60;        // feste Simulationsschrittweite
  const BOT_COUNT = 10;
  const START_R = 2.7;        // Radius des Startgebiets
  const HUMAN_ID = 1;

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

  const BOT_NAMES = ['Blitz', 'Kringel', 'Pixelfuchs', 'Zickzack', 'Quadrat', 'Rakete', 'Kurve',
    'Nebel', 'Kobold', 'Schnecke', 'Turbo', 'Glitzer', 'Wirbel', 'Funke', 'Brummer', 'Klecks',
    'Komet', 'Zappel', 'Murmel', 'Flitzer', 'Krümel', 'Sputnik', 'Bummler', 'Tornado', 'Schatten',
    'Biber', 'Pinguin', 'Panda', 'Igel', 'Kaktus', 'Waffel', 'Socke', 'Pudding', 'Kiwi'];

  // ---------- Zustand ----------
  const owner = new Uint8Array(N);
  const trailMap = new Uint8Array(N);
  const visit = new Uint32Array(N);
  const queue = new Int32Array(N);
  let stamp = 0;

  const players = [null];
  let time = 0;
  let state = 'menu';         // menu | play | dead
  let paused = false;
  let human = null;
  let humanColor = 7;
  let deathCam = null;
  const particles = [];
  const floaters = [];
  const cam = { x: W / 2, y: H / 2 };
  const deathStats = {};

  // ---------- Hilfsfunktionen ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const randi = (a, b) => Math.floor(rand(a, b + 1));
  const wrapAngle = a => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  const turnToward = (a, t, max) => {
    const d = wrapAngle(t - a);
    return Math.abs(d) <= max ? t : a + Math.sign(d) * max;
  };
  const pctOf = p => (p.count / N) * 100;
  const fmtPct = v => (v >= 10 ? v.toFixed(1) : v.toFixed(2)) + '%';
  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } },
  };

  function newPlayer(id, isBot) {
    return {
      id, isBot, name: '', color: COLORS[0], alive: false,
      x: 0, y: 0, cx: 0, cy: 0, angle: 0, target: 0,
      trail: [], count: 0, bx0: W, by0: H, bx1: -1, by1: -1,
      kills: 0, bestPct: 0, spawnTime: 0, respawnAt: 0,
      ai: { mode: 'home', plan: null, home: null, homeTimer: 0, tick: 0, aggr: Math.random(), hunt: -1, huntUntil: 0 },
    };
  }

  function setOwner(i, id) {
    const old = owner[i];
    if (old === id) return;
    if (old) players[old].count--;
    owner[i] = id;
    if (id) {
      const p = players[id];
      p.count++;
      const x = i % W, y = (i / W) | 0;
      if (x < p.bx0) p.bx0 = x;
      if (x > p.bx1) p.bx1 = x;
      if (y < p.by0) p.by0 = y;
      if (y > p.by1) p.by1 = y;
    }
  }

  // ---------- Spawnen & Sterben ----------
  function areaFree(cx, cy, r) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        const i = y * W + x;
        if (owner[i] || trailMap[i]) return false;
      }
    return true;
  }

  function farFromHeads(cx, cy, d) {
    for (const q of players) {
      if (q && q.alive && Math.hypot(q.x - cx, q.y - cy) < d) return false;
    }
    return true;
  }

  function findSpawn() {
    for (let t = 0; t < 300; t++) {
      const cx = randi(6, W - 7), cy = randi(6, H - 7);
      if (areaFree(cx, cy, 5) && farFromHeads(cx, cy, 12)) return [cx, cy];
    }
    for (let t = 0; t < 300; t++) {
      const cx = randi(6, W - 7), cy = randi(6, H - 7);
      if (areaFree(cx, cy, 3)) return [cx, cy];
    }
    return [randi(6, W - 7), randi(6, H - 7)];
  }

  function spawn(p) {
    const [cx, cy] = findSpawn();
    p.bx0 = W; p.by0 = H; p.bx1 = -1; p.by1 = -1;
    p.count = 0; p.trail = []; p.kills = 0; p.bestPct = 0;
    const r = Math.ceil(START_R);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= START_R * START_R) setOwner((cy + dy) * W + cx + dx, p.id);
    p.x = cx + 0.5; p.y = cy + 0.5; p.cx = cx; p.cy = cy;
    p.angle = rand(-Math.PI, Math.PI); p.target = p.angle;
    p.alive = true; p.spawnTime = time;
    Object.assign(p.ai, { mode: 'home', plan: null, home: null, homeTimer: rand(0.2, 1), hunt: -1 });
    checkWipeouts(p);
  }

  function checkWipeouts(by) {
    for (const q of players) {
      if (q && q.alive && q !== by && q.count <= 0) kill(q, by, 'wiped');
    }
  }

  function kill(p, killer, reason) {
    if (!p.alive) return;
    p.alive = false;
    for (const i of p.trail) if (trailMap[i] === p.id) trailMap[i] = 0;
    p.trail = [];
    for (let y = Math.max(0, p.by0); y <= Math.min(H - 1, p.by1); y++)
      for (let x = Math.max(0, p.bx0); x <= Math.min(W - 1, p.bx1); x++) {
        const i = y * W + x;
        if (owner[i] === p.id) owner[i] = 0;
      }
    p.count = 0;
    deathStats[reason] = (deathStats[reason] || 0) + 1;
    burst(p.x, p.y, p.color);
    if (killer && killer !== p) killer.kills++;

    let msg;
    if (reason === 'self') msg = `${p.name} ist über die eigene Spur gestolpert`;
    else if (reason === 'head') msg = `${killer.name} hat ${p.name} gerammt`;
    else if (reason === 'wiped') msg = `${killer.name} hat ${p.name} komplett eingenommen`;
    else msg = `${killer.name} hat ${p.name} abgeschnitten`;
    addFeed(msg, p === human || killer === human);

    if (p.isBot) p.respawnAt = time + rand(1.5, 3.5);
    else onHumanDeath(killer, reason);
  }

  // ---------- Bewegung & Eroberung ----------
  function move(p) {
    p.angle = wrapAngle(turnToward(p.angle, p.target, TURN * STEP));
    const ox = p.x, oy = p.y;
    const nx = Math.min(W - 0.001, Math.max(0.001, ox + Math.cos(p.angle) * SPEED * STEP));
    const ny = Math.min(H - 0.001, Math.max(0.001, oy + Math.sin(p.angle) * SPEED * STEP));
    p.x = nx; p.y = ny;
    const ncx = nx | 0, ncy = ny | 0;
    if (ncx === p.cx && ncy === p.cy) return;
    if (ncx !== p.cx && ncy !== p.cy) {
      // diagonaler Schritt: Zwischenzelle einfügen, damit die Spur lückenlos bleibt
      const bx = ncx > p.cx ? ncx : p.cx, by = ncy > p.cy ? ncy : p.cy;
      const tx = (bx - ox) / (nx - ox), ty = (by - oy) / (ny - oy);
      if (tx < ty) enterCell(p, ncx, p.cy); else enterCell(p, p.cx, ncy);
      if (!p.alive) return;
    }
    enterCell(p, ncx, ncy);
  }

  function enterCell(p, cx, cy) {
    p.cx = cx; p.cy = cy;
    const i = cy * W + cx;
    const t = trailMap[i];
    if (t) {
      if (t === p.id) {
        // Zurückrutschen in eine der zuletzt gezogenen Zellen (Streifen einer
        // Zellgrenze) zählt nicht als Selbstkollision.
        if (p.trail.lastIndexOf(i) >= p.trail.length - 4) return;
        kill(p, p, 'self');
        return;
      }
      kill(players[t], p, 'trail');
    }
    if (owner[i] === p.id) {
      if (p.trail.length) capture(p);
    } else {
      trailMap[i] = p.id;
      p.trail.push(i);
    }
  }

  function capture(p) {
    const id = p.id;
    const before = p.count;
    for (const i of p.trail) {
      if (trailMap[i] === id) trailMap[i] = 0;
      setOwner(i, id);
    }
    p.trail = [];

    // Flutfüllung vom Rand der (erweiterten) Bounding-Box: alles, was nicht
    // erreichbar ist, ist umschlossen.
    const x0 = Math.max(0, p.bx0 - 1), x1 = Math.min(W - 1, p.bx1 + 1);
    const y0 = Math.max(0, p.by0 - 1), y1 = Math.min(H - 1, p.by1 + 1);
    stamp++;
    let qn = 0;
    const seed = i => {
      if (owner[i] !== id && visit[i] !== stamp) { visit[i] = stamp; queue[qn++] = i; }
    };
    for (let x = x0; x <= x1; x++) { seed(y0 * W + x); seed(y1 * W + x); }
    for (let y = y0; y <= y1; y++) { seed(y * W + x0); seed(y * W + x1); }
    while (qn > 0) {
      const i = queue[--qn];
      const x = i % W, y = (i / W) | 0;
      if (x > x0) seed(i - 1);
      if (x < x1) seed(i + 1);
      if (y > y0) seed(i - W);
      if (y < y1) seed(i + W);
    }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        if (owner[i] !== id && visit[i] !== stamp) setOwner(i, id);
      }

    const gained = p.count - before;
    if (p === human && gained > 0) {
      floaters.push({ x: p.x, y: p.y - 1, text: '+' + fmtPct((gained / N) * 100), life: 1.2, color: p.color.dark });
    }
    checkWipeouts(p);
  }

  function headCollisions() {
    for (let a = 1; a < players.length; a++) {
      const p = players[a];
      if (!p.alive) continue;
      for (let b = a + 1; b < players.length; b++) {
        const q = players[b];
        if (!q.alive || !p.alive) continue;
        const dx = p.x - q.x, dy = p.y - q.y;
        if (dx * dx + dy * dy > 0.7 * 0.7) continue;
        const pIn = owner[p.cy * W + p.cx] === p.id;
        const qIn = owner[q.cy * W + q.cx] === q.id;
        if (pIn && !qIn) kill(q, p, 'head');
        else if (qIn && !pIn) kill(p, q, 'head');
        else if (!pIn && !qIn) {
          // beide draußen: wer die längere Spur hat, verliert
          if (p.trail.length > q.trail.length) kill(p, q, 'head');
          else if (q.trail.length > p.trail.length) kill(q, p, 'head');
          else { kill(p, q, 'head'); kill(q, p, 'head'); }
        }
      }
    }
  }

  // ---------- Bot-KI ----------
  // Prüft, ob die gerade Linie von (ax,ay) nach (bx,by) die eigene Spur kreuzt
  function lineHitsTrail(p, ax, ay, bx, by) {
    const len = Math.hypot(bx - ax, by - ay), here = p.cy * W + p.cx;
    for (let d = 0.8; d < len; d += 0.4) {
      const x = ax + (bx - ax) * d / len, y = ay + (by - ay) * d / len;
      const i = (y | 0) * W + (x | 0);
      if (i !== here && trailMap[i] === p.id) return true;
    }
    return false;
  }

  // Nächste eigene Zelle, deren direkter Weg nicht über die eigene Spur führt
  function nearestOwn(p) {
    const cand = [];
    for (let y = Math.max(0, p.by0); y <= Math.min(H - 1, p.by1); y++)
      for (let x = Math.max(0, p.bx0); x <= Math.min(W - 1, p.bx1); x++) {
        if (owner[y * W + x] !== p.id) continue;
        const dx = x + 0.5 - p.x, dy = y + 0.5 - p.y;
        cand.push([dx * dx + dy * dy, x + 0.5, y + 0.5]);
      }
    if (!cand.length) return null;
    cand.sort((a, b) => a[0] - b[0]);
    const lim = Math.min(cand.length, 60);
    for (let k = 0; k < lim; k += (k < 10 ? 1 : 3)) {
      const c = cand[k];
      if (!lineHitsTrail(p, p.x, p.y, c[1], c[2])) return { x: c[1], y: c[2] };
    }
    return { x: cand[0][1], y: cand[0][2] };
  }

  function threatened(p) {
    const ai = p.ai;
    const homeD = ai.home ? Math.hypot(ai.home.x - p.x, ai.home.y - p.y) : 8;
    const margin = 2 + (1 - ai.aggr) * 5;
    const tr = p.trail;
    for (const q of players) {
      if (!q || !q.alive || q === p) continue;
      let d2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      for (let k = 0; k < tr.length; k += 2) {
        const i = tr[k];
        const dx = (i % W) + 0.5 - q.x, dy = ((i / W) | 0) + 0.5 - q.y;
        const dd = dx * dx + dy * dy;
        if (dd < d2) d2 = dd;
      }
      if (Math.sqrt(d2) < homeD + margin) return true;
    }
    return false;
  }

  function findPrey(p, r) {
    let best = -1, bd = Infinity;
    for (let y = Math.max(0, p.cy - r); y <= Math.min(H - 1, p.cy + r); y++)
      for (let x = Math.max(0, p.cx - r); x <= Math.min(W - 1, p.cx + r); x++) {
        const t = trailMap[y * W + x];
        if (!t || t === p.id) continue;
        const d = (x - p.cx) ** 2 + (y - p.cy) ** 2;
        if (d < bd) { bd = d; best = y * W + x; }
      }
    return best;
  }

  function planExcursion(p, forced) {
    let out = forced;
    if (out === undefined) {
      let best = -Infinity;
      for (let k = 0; k < 12; k++) {
        const ang = k * Math.PI / 6 + rand(-0.2, 0.2);
        const c = Math.cos(ang), s = Math.sin(ang);
        let sc = rand(0, 4);
        for (let d = 2; d <= 16; d += 2) {
          const x = Math.floor(p.x + c * d), y = Math.floor(p.y + s * d);
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) { sc -= d < 10 ? 50 : 10; break; }
          const o = owner[y * W + x];
          if (o !== p.id) sc += o === 0 ? 1 : 1.4;
        }
        sc -= Math.abs(wrapAngle(ang - p.angle)) * 0.8;
        if (sc > best) { best = sc; out = ang; }
      }
    }
    const k = 0.6 + p.ai.aggr * 1.2;
    return {
      out,
      side: Math.random() < 0.5 ? -1 : 1,
      len1: Math.round(rand(3, 9) * k),
      len2: Math.round(rand(3, 9) * k),
      maxL: Math.round(25 + p.ai.aggr * 45),
    };
  }

  // Simuliert die echte Fahrt (inkl. Wenderadius) Richtung "target" und liefert
  // den Schritt, an dem die eigene Spur oder der Rand getroffen würde.
  const SIM_DT = 0.05, SIM_STEPS = 16;
  function pathHit(p, target) {
    let x = p.x, y = p.y, a = p.angle;
    const here = p.cy * W + p.cx;
    for (let k = 0; k < SIM_STEPS; k++) {
      a = turnToward(a, target, TURN * SIM_DT);
      x += Math.cos(a) * SPEED * SIM_DT;
      y += Math.sin(a) * SPEED * SIM_DT;
      if (x < 0.3 || y < 0.3 || x > W - 0.3 || y > H - 0.3) return k;
      const i = (y | 0) * W + (x | 0);
      if (i !== here && trailMap[i] === p.id) return k;
    }
    return SIM_STEPS;
  }

  const OFFSETS = [0, 0.3, -0.3, 0.65, -0.65, 1.0, -1.0, 1.4, -1.4, 1.9, -1.9, 2.5, -2.5, 3.1];
  function safeAngle(p, desired) {
    let best = desired, bestHit = -1;
    for (const o of OFFSETS) {
      const a = desired + o;
      const h = pathHit(p, a);
      if (h >= SIM_STEPS) return a;
      if (h > bestHit) { bestHit = h; best = a; }
    }
    return best;
  }

  function botThink(p) {
    const ai = p.ai, id = p.id;
    ai.tick++;
    const inHome = owner[p.cy * W + p.cx] === id;
    let desired = p.angle;

    if (inHome) {
      if (ai.mode !== 'home') { ai.mode = 'home'; ai.plan = null; ai.homeTimer = rand(0.1, 0.9); }
      ai.homeTimer -= STEP;
      if (!ai.plan && ai.homeTimer <= 0) ai.plan = planExcursion(p);
      if (ai.plan) desired = ai.plan.out;
    } else {
      if (!ai.plan) ai.plan = planExcursion(p, p.angle);
      if (ai.mode === 'home') ai.mode = 'out';
      if (ai.tick % 6 === 0 || !ai.home) ai.home = nearestOwn(p);
      const L = p.trail.length;
      if (ai.mode === 'out' && L >= ai.plan.len1) ai.mode = 'side';
      if (ai.mode === 'side' && L >= ai.plan.len1 + ai.plan.len2) ai.mode = 'back';
      if (L > ai.plan.maxL) ai.mode = 'back';
      if (ai.mode !== 'back' && ai.tick % 4 === 0 && threatened(p)) ai.mode = 'back';

      if (ai.mode === 'out') desired = ai.plan.out;
      else if (ai.mode === 'side') desired = ai.plan.out + ai.plan.side * Math.PI / 2;
      else if (ai.home) desired = Math.atan2(ai.home.y - p.y, ai.home.x - p.x);
    }

    // Jagen: fremde Spuren in der Nähe angreifen
    if (ai.tick % 8 === 0 && p.trail.length < 14) {
      const prey = findPrey(p, Math.round(3 + ai.aggr * 5));
      if (prey >= 0) { ai.hunt = prey; ai.huntUntil = time + 1.5; }
    }
    if (ai.hunt >= 0) {
      const t = trailMap[ai.hunt];
      if (t && t !== id && time < ai.huntUntil) {
        desired = Math.atan2(((ai.hunt / W) | 0) + 0.5 - p.y, (ai.hunt % W) + 0.5 - p.x);
      } else ai.hunt = -1;
    }

    p.target = safeAngle(p, desired);
  }

  function giveBotIdentity(p) {
    const usedNames = new Set(), usedColors = new Set([humanColor]);
    for (const q of players) {
      if (q && q !== p && (q.alive || q === human)) { usedNames.add(q.name); usedColors.add(q.color.i); }
    }
    const names = BOT_NAMES.filter(n => !usedNames.has(n));
    p.name = names[randi(0, names.length - 1)] || 'Bot';
    const cols = COLORS.filter(c => !usedColors.has(c.i));
    p.color = cols.length ? cols[randi(0, cols.length - 1)] : COLORS[randi(0, COLORS.length - 1)];
    p.ai.aggr = Math.random();
  }

  // ---------- Effekte ----------
  function burst(x, y, color) {
    for (let k = 0; k < 26; k++) {
      const a = rand(0, Math.PI * 2), v = rand(2, 9);
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.5, 1.1), color, size: rand(0.2, 0.5) });
    }
  }

  const feedEl = document.getElementById('feed');
  function addFeed(text, important) {
    if (state === 'menu' && !important) return;
    const el = document.createElement('div');
    el.className = 'msg';
    el.textContent = text;
    if (important) el.style.background = 'rgba(59,130,246,.85)';
    feedEl.appendChild(el);
    while (feedEl.children.length > 4) feedEl.firstChild.remove();
    setTimeout(() => { el.style.opacity = '0'; }, 2600);
    setTimeout(() => el.remove(), 3300);
  }

  // ---------- Simulation ----------
  function update() {
    time += STEP;
    for (let k = 1; k < players.length; k++) {
      const p = players[k];
      if (p.alive && p.isBot) botThink(p);
    }
    for (let k = 1; k < players.length; k++) {
      const p = players[k];
      if (p.alive) move(p);
    }
    headCollisions();
    for (let k = 1; k < players.length; k++) {
      const p = players[k];
      if (p.isBot && !p.alive && time >= p.respawnAt) { giveBotIdentity(p); spawn(p); }
      if (p.alive) p.bestPct = Math.max(p.bestPct, pctOf(p));
    }
    for (let k = particles.length - 1; k >= 0; k--) {
      const q = particles[k];
      q.x += q.vx * STEP; q.y += q.vy * STEP;
      q.vx *= 0.94; q.vy *= 0.94;
      q.life -= STEP;
      if (q.life <= 0) particles.splice(k, 1);
    }
    for (let k = floaters.length - 1; k >= 0; k--) {
      const f = floaters[k];
      f.y -= STEP * 1.2;
      f.life -= STEP;
      if (f.life <= 0) floaters.splice(k, 1);
    }
  }

  // ---------- Rendering ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const mini = document.getElementById('minimap');
  const mctx = mini.getContext('2d');
  const miniOff = document.createElement('canvas');
  miniOff.width = W; miniOff.height = H;
  const moctx = miniOff.getContext('2d');
  const miniImg = moctx.createImageData(W, H);

  let dpr = 1, cw = 0, ch = 0, cellPx = 30, viewOx = 0, viewOy = 0;
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

  function render() {
    const cell = cellPx;
    const ox = Math.round(cw / 2 - cam.x * cell), oy = Math.round(ch / 2 - cam.y * cell);
    viewOx = ox; viewOy = oy;

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
        let x = x0;
        while (x <= x1) {
          const o = owner[row + x];
          if (!o) { x++; continue; }
          let e = x;
          while (e + 1 <= x1 && owner[row + e + 1] === o) e++;
          const col = players[o].color;
          ctx.fillStyle = pass === 0 ? col.dark : col.base;
          ctx.fillRect(ox + x * cell, oy + y * cell + (pass === 0 ? depth : 0), (e - x + 1) * cell, cell);
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
        if (!t) { x++; continue; }
        let e = x;
        while (e + 1 <= x1 && trailMap[row + e + 1] === t) e++;
        ctx.fillStyle = players[t].color.trail;
        ctx.fillRect(ox + x * cell, oy + y * cell, (e - x + 1) * cell, cell);
        x = e + 1;
      }
    }

    // Spielfeldrand
    ctx.strokeStyle = 'rgba(239,68,68,.6)';
    ctx.lineWidth = Math.max(2, cell * 0.12);
    ctx.strokeRect(ox, oy, W * cell, H * cell);

    // Spieler
    const size = cell * 1.05;
    for (let k = 1; k < players.length; k++) {
      const p = players[k];
      if (!p.alive) continue;
      const sx = ox + p.x * cell, sy = oy + p.y * cell;
      if (sx < -cell * 4 || sy < -cell * 4 || sx > cw + cell * 4 || sy > ch + cell * 4) continue;
      const hx = sx - size / 2, hy = sy - size / 2, r = size * 0.22;
      ctx.fillStyle = p.color.dark;
      rrect(hx, hy + depth, size, size, r); ctx.fill();
      ctx.fillStyle = p.color.base;
      rrect(hx, hy, size, size, r); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = Math.max(1.5, cell * 0.07);
      ctx.stroke();

      // Augen
      const c = Math.cos(p.angle), s = Math.sin(p.angle);
      const ex = c * size * 0.15, ey = s * size * 0.15;
      const px = -s * size * 0.2, py = c * size * 0.2;
      for (const sign of [-1, 1]) {
        const cx2 = sx + ex + px * sign, cy2 = sy + ey + py * sign;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(cx2, cy2, size * 0.15, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1f2430';
        ctx.beginPath(); ctx.arc(cx2 + c * size * 0.06, cy2 + s * size * 0.06, size * 0.075, 0, Math.PI * 2); ctx.fill();
      }

      // Name
      ctx.font = `700 ${Math.round(cell * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = Math.max(2, cell * 0.12);
      ctx.strokeStyle = 'rgba(20,24,34,.75)';
      ctx.strokeText(p.name, sx, hy - cell * 0.15);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.name, sx, hy - cell * 0.15);
    }

    // Partikel
    for (const q of particles) {
      ctx.globalAlpha = Math.max(0, Math.min(1, q.life * 1.5));
      ctx.fillStyle = q.color.base;
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

  function renderMinimap() {
    const d = miniImg.data;
    for (let i = 0; i < N; i++) {
      const t = trailMap[i], o = owner[i];
      let r = 243, g = 245, b = 249;
      if (t) [r, g, b] = players[t].color.trailRgb;
      else if (o) [r, g, b] = players[o].color.rgb;
      const k = i * 4;
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
    }
    moctx.putImageData(miniImg, 0, 0);
    const mw = mini.width, mh = mini.height;
    mctx.imageSmoothingEnabled = false;
    mctx.clearRect(0, 0, mw, mh);
    mctx.drawImage(miniOff, 0, 0, mw, mh);
    // Sichtbereich
    const cell = cellPx;
    mctx.strokeStyle = 'rgba(31,36,48,.5)';
    mctx.lineWidth = 1;
    mctx.strokeRect((-viewOx / cell) * mw / W, (-viewOy / cell) * mh / H, (cw / cell) * mw / W, (ch / cell) * mh / H);
    if (human && human.alive) {
      mctx.fillStyle = '#1f2430';
      mctx.beginPath();
      mctx.arc(human.x * mw / W, human.y * mh / H, 4, 0, Math.PI * 2);
      mctx.fill();
      mctx.fillStyle = '#fff';
      mctx.beginPath();
      mctx.arc(human.x * mw / W, human.y * mh / H, 2, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  // ---------- HUD ----------
  const lbEl = document.getElementById('leaderboard');
  const hudEl = document.getElementById('hud');
  const pctEl = document.getElementById('pct');
  const subEl = document.getElementById('sub');

  function esc(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function updateLeaderboard() {
    const alive = players.filter(p => p && p.alive).sort((a, b) => b.count - a.count);
    let html = '<div class="title">Rangliste</div>';
    const rowHtml = (p, rank) =>
      `<div class="row${p === human ? ' me' : ''}"><span>${rank}.</span>` +
      `<span class="dot" style="background:${p.color.base}"></span>` +
      `<span class="name">${esc(p.name)}</span><span>${fmtPct(pctOf(p))}</span></div>`;
    alive.slice(0, 6).forEach((p, k) => { html += rowHtml(p, k + 1); });
    const myRank = alive.indexOf(human);
    if (myRank >= 6) html += rowHtml(human, myRank + 1);
    lbEl.innerHTML = html;
  }

  function updateHud() {
    if (state === 'play' && human.alive) {
      pctEl.textContent = fmtPct(pctOf(human));
      subEl.textContent = `Kills: ${human.kills} · ${fmtTime(time - human.spawnTime)}`;
    }
  }

  // ---------- Spielablauf ----------
  const menuEl = document.getElementById('menu');
  const overEl = document.getElementById('over');
  const pauseEl = document.getElementById('pause');
  const nameInput = document.getElementById('nameInput');
  const swatchesEl = document.getElementById('swatches');
  const recordEl = document.getElementById('record');
  let lastRun = null;

  function bestRecord() {
    return parseFloat(store.get('farbrevier.best') || '0') || 0;
  }

  function showRecord() {
    const b = bestRecord();
    recordEl.textContent = b > 0 ? `Dein Rekord: ${fmtPct(b)}` : '';
  }

  function buildSwatches() {
    swatchesEl.innerHTML = '';
    COLORS.forEach(c => {
      const b = document.createElement('button');
      b.style.background = c.base;
      b.title = 'Farbe wählen';
      if (c.i === humanColor) b.className = 'sel';
      b.addEventListener('click', () => { humanColor = c.i; store.set('farbrevier.color', String(c.i)); buildSwatches(); });
      swatchesEl.appendChild(b);
    });
  }

  function startGame() {
    const name = (nameInput.value || '').trim().slice(0, 14) || 'Du';
    store.set('farbrevier.name', name);
    human.name = name;
    human.color = COLORS[humanColor];
    // Bots mit derselben Farbe bekommen eine andere
    for (const p of players) {
      if (p && p.isBot && p.color.i === humanColor) giveBotIdentity(p);
    }
    spawn(human);
    cam.x = human.x; cam.y = human.y;
    state = 'play';
    paused = false;
    menuEl.classList.add('hidden');
    overEl.classList.add('hidden');
    pauseEl.classList.add('hidden');
    hudEl.classList.remove('hidden');
  }

  function onHumanDeath(killer, reason) {
    state = 'dead';
    deathCam = { x: human.x, y: human.y };
    const survived = time - human.spawnTime;
    const best = bestRecord();
    const isRecord = best > 0 && human.bestPct > best;
    if (human.bestPct > best) store.set('farbrevier.best', String(human.bestPct));
    lastRun = { killer, reason, pct: human.bestPct, kills: human.kills, survived, isRecord, best: Math.max(best, human.bestPct) };
    setTimeout(showGameOver, 900);
  }

  function showGameOver() {
    if (state !== 'dead' || !lastRun) return;
    const r = lastRun;
    const reasons = {
      self: 'Du bist über deine eigene Spur gefahren.',
      head: `${r.killer ? r.killer.name : 'Jemand'} hat dich frontal gerammt.`,
      wiped: `${r.killer ? r.killer.name : 'Jemand'} hat dein ganzes Gebiet eingenommen.`,
      trail: `${r.killer ? r.killer.name : 'Jemand'} hat deine Spur gekreuzt.`,
    };
    document.getElementById('overTitle').textContent = r.isRecord ? 'Neuer Rekord!' : 'Erwischt!';
    document.getElementById('overReason').textContent = reasons[r.reason] || '';
    document.getElementById('resPct').textContent = fmtPct(r.pct);
    document.getElementById('resKills').textContent = r.kills;
    document.getElementById('resTime').textContent = fmtTime(r.survived);
    document.getElementById('overRecord').textContent = `Rekord: ${fmtPct(r.best)}`;
    hudEl.classList.add('hidden');
    overEl.classList.remove('hidden');
  }

  function togglePause() {
    if (state !== 'play') return;
    paused = !paused;
    pauseEl.classList.toggle('hidden', !paused);
  }

  document.getElementById('playBtn').addEventListener('click', startGame);
  document.getElementById('againBtn').addEventListener('click', startGame);
  document.getElementById('menuBtn').addEventListener('click', () => {
    state = 'menu';
    overEl.classList.add('hidden');
    menuEl.classList.remove('hidden');
    showRecord();
  });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') startGame(); e.stopPropagation(); });

  // ---------- Eingabe ----------
  function aimAt(clientX, clientY) {
    if (state !== 'play' || paused || !human.alive) return;
    const hx = (viewOx + human.x * cellPx) / dpr, hy = (viewOy + human.y * cellPx) / dpr;
    const dx = clientX - hx, dy = clientY - hy;
    if (dx * dx + dy * dy < 16) return;
    human.target = Math.atan2(dy, dx);
  }
  window.addEventListener('mousemove', e => aimAt(e.clientX, e.clientY));
  const onTouch = e => {
    if (state !== 'play') return;
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
    if (e.key in KEY_DIRS) {
      e.preventDefault();
      if (state === 'play' && !paused && human.alive) human.target = KEY_DIRS[e.key];
    }
    if (e.key === 'Enter' && state === 'dead' && !overEl.classList.contains('hidden')) startGame();
  });
  window.addEventListener('blur', () => { if (state === 'play' && !paused) togglePause(); });

  // ---------- Initialisierung ----------
  human = newPlayer(HUMAN_ID, false);
  players.push(human);
  for (let k = 0; k < BOT_COUNT; k++) {
    const p = newPlayer(players.length, true);
    players.push(p);
  }
  for (const p of players) {
    if (p && p.isBot) { giveBotIdentity(p); spawn(p); }
  }
  // Welt etwas "vorspulen", damit schon Gebiete existieren
  for (let k = 0; k < 60 * 20; k++) update();

  const savedColor = parseInt(store.get('farbrevier.color'), 10);
  if (savedColor >= 0 && savedColor < COLORS.length) humanColor = savedColor;
  nameInput.value = store.get('farbrevier.name') || '';
  buildSwatches();
  showRecord();

  let last = performance.now(), acc = 0, frameNo = 0, lbTimer = 0;
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    if (!paused) {
      acc += dt;
      while (acc >= STEP) { update(); acc -= STEP; }
    }

    // Kamera
    let tx = cam.x, ty = cam.y;
    if (state === 'play' && human.alive) { tx = human.x; ty = human.y; }
    else if (state === 'dead' && deathCam) { tx = deathCam.x; ty = deathCam.y; }
    else {
      let leader = null;
      for (const p of players) if (p && p.alive && p.isBot && (!leader || p.count > leader.count)) leader = p;
      if (leader) { tx = leader.x; ty = leader.y; }
    }
    const f = Math.min(1, dt * (state === 'play' ? 12 : 2));
    cam.x += (tx - cam.x) * f;
    cam.y += (ty - cam.y) * f;

    render();
    if (frameNo++ % 10 === 0) renderMinimap();
    lbTimer -= dt;
    if (lbTimer <= 0) { updateLeaderboard(); lbTimer = 0.4; }
    updateHud();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // kleiner Debug-Zugang für Tests
  window.farbrevier = { players, owner, trailMap, W, H, update, deathStats, get state() { return state; } };
})();
