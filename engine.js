/*
 * Farbrevier – Spiel-Engine (Simulation ohne Darstellung).
 * Läuft im Browser (allein spielen, Raum-Gastgeber) und in Node.js (Online-Server).
 *
 * Die Karte ist ein Raster. Jede Zelle hat einen Besitzer (owner) und kann
 * zusätzlich Teil einer Spur (trailMap) sein. Wer mit seiner Spur in das eigene
 * Gebiet zurückkehrt, bekommt alle umschlossenen Zellen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FarbEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const W = 110, H = 110, N = W * H;
  const SPEED = 11;           // Zellen pro Sekunde bei Tempo 1×
  const TURN = 8.7;           // max. Drehgeschwindigkeit (rad/s) bei Tempo 1× – Wenderadius ca. 1,3 Zellen
  const SPEEDS = [1, 1.25, 1.5, 2, 2.5, 5, 10];  // wählbare Tempo-Stufen
  const MAX_SUBSTEP = 0.45;   // max. Weg pro Teilschritt, damit keine Zelle übersprungen wird
  const STEP = 1 / 60;        // feste Simulationsschrittweite
  const START_R = 2.7;        // Radius des Startgebiets
  const COLOR_COUNT = 13;
  const MAX_ID = 250;
  const NET_EVERY = 2;        // alle 2 Schritte (30x pro Sekunde) Netzwerk-Update

  const BOT_NAMES = ['Blitz', 'Kringel', 'Pixelfuchs', 'Zickzack', 'Quadrat', 'Rakete', 'Kurve',
    'Nebel', 'Kobold', 'Schnecke', 'Turbo', 'Glitzer', 'Wirbel', 'Funke', 'Brummer', 'Klecks',
    'Komet', 'Zappel', 'Murmel', 'Flitzer', 'Krümel', 'Sputnik', 'Bummler', 'Tornado', 'Schatten',
    'Biber', 'Pinguin', 'Panda', 'Igel', 'Kaktus', 'Waffel', 'Socke', 'Pudding', 'Kiwi'];

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

  /** Heißt ein Spieler "Einhorn", wird sein Gebiet zum glitzernden Regenbogen. */
  function isRainbowName(name) {
    return typeof name === 'string' && name.trim().toLowerCase() === 'einhorn';
  }

  function cleanName(name, fallback) {
    const n = String(name == null ? '' : name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
    return n || fallback;
  }

  function cleanColor(c) {
    c = Number(c) | 0;
    return c >= 0 && c < COLOR_COUNT ? c : 0;
  }

  function rleEncode(arr) {
    const out = [];
    let v = arr[0], n = 1;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === v) n++;
      else { out.push(v, n); v = arr[i]; n = 1; }
    }
    out.push(v, n);
    return out;
  }

  function rleDecode(rle, target) {
    let k = 0;
    for (let j = 0; j < rle.length; j += 2) {
      const v = rle[j], n = rle[j + 1];
      for (let m = 0; m < n && k < target.length; m++) target[k++] = v;
    }
  }

  function createEngine(opts) {
    opts = opts || {};
    const targetPlayers = opts.targetPlayers || 11;
    const minBots = opts.minBots != null ? opts.minBots : 3;

    const owner = new Uint8Array(N);
    const trailMap = new Uint8Array(N);
    const visit = new Uint32Array(N);
    const queue = new Int32Array(N);
    const dirtyMark = new Uint8Array(N);
    let stamp = 0;
    let lastMetaSent = -1;
    const players = [null];

    const eng = {
      W, H, N, STEP, SPEED, TURN,
      owner, trailMap, players,
      time: 0,
      stepCount: 0,
      trackDirty: false,
      dirty: [],
      events: [],
      metaVersion: 0,
      onEvent: opts.onEvent || null,
      deathStats: {},
      speedMul: 1,
    };

    function markDirty(i) {
      if (eng.trackDirty && !dirtyMark[i]) { dirtyMark[i] = 1; eng.dirty.push(i); }
    }
    function emit(ev) {
      if (eng.onEvent) eng.onEvent(ev);
      if (eng.trackDirty) eng.events.push(ev);
    }

    function newPlayer(id, isBot) {
      return {
        id, isBot, name: '', color: 0, alive: false,
        x: 0, y: 0, cx: 0, cy: 0, angle: 0, target: 0,
        trail: [], count: 0, bx0: W, by0: H, bx1: -1, by1: -1,
        kills: 0, bestPct: 0, spawnTime: 0, respawnAt: 0, invincible: false,
        ai: { mode: 'home', plan: null, home: null, homeTimer: 0, tick: 0, aggr: Math.random(), hunt: -1, huntUntil: 0 },
      };
    }

    function allocId() {
      for (let i = 1; i < players.length; i++) if (!players[i]) return i;
      if (players.length <= MAX_ID) { players.push(null); return players.length - 1; }
      return -1;
    }

    function setOwner(i, id) {
      const old = owner[i];
      if (old === id) return;
      if (old && players[old]) players[old].count--;
      owner[i] = id;
      markDirty(i);
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

    function setTrail(i, id) {
      if (trailMap[i] === id) return;
      trailMap[i] = id;
      markDirty(i);
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
      p.alive = true; p.spawnTime = eng.time;
      Object.assign(p.ai, { mode: 'home', plan: null, home: null, homeTimer: rand(0.2, 1), hunt: -1 });
      checkWipeouts(p);
    }

    function checkWipeouts(by) {
      for (const q of players) {
        if (!q || !q.alive || q.count > 0) continue;
        if (q.invincible) rehome(q);
        else if (q !== by) kill(q, by, 'wiped');
      }
    }

    // Ein unsterblicher Spieler, dessen Gebiet komplett erobert wurde, bekommt
    // an seiner aktuellen Position ein neues Startgebiet.
    function rehome(p) {
      const cx = Math.min(W - 4, Math.max(3, p.cx)), cy = Math.min(H - 4, Math.max(3, p.cy));
      const r = Math.ceil(START_R);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (dx * dx + dy * dy <= START_R * START_R) setOwner((cy + dy) * W + cx + dx, p.id);
      checkWipeouts(p);
    }

    function kill(p, killer, reason) {
      if (!p.alive) return;
      if (p.invincible && reason !== 'leave') return;
      p.alive = false;
      for (const i of p.trail) if (trailMap[i] === p.id) setTrail(i, 0);
      p.trail = [];
      for (let y = Math.max(0, p.by0); y <= Math.min(H - 1, p.by1); y++)
        for (let x = Math.max(0, p.bx0); x <= Math.min(W - 1, p.bx1); x++) {
          const i = y * W + x;
          if (owner[i] === p.id) { owner[i] = 0; markDirty(i); }
        }
      p.count = 0;
      eng.deathStats[reason] = (eng.deathStats[reason] || 0) + 1;
      if (killer && killer !== p) killer.kills++;
      emit({
        k: 'kill', v: p.id, by: killer ? killer.id : 0, r: reason,
        x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100,
        vn: p.name, kn: killer ? killer.name : '', c: p.color,
      });
      if (p.isBot) p.respawnAt = eng.time + rand(1.5, 3.5);
    }

    // ---------- Bewegung & Eroberung ----------
    function move(p, dist, turn) {
      p.angle = wrapAngle(turnToward(p.angle, p.target, turn));
      const ox = p.x, oy = p.y;
      const nx = Math.min(W - 0.001, Math.max(0.001, ox + Math.cos(p.angle) * dist));
      const ny = Math.min(H - 0.001, Math.max(0.001, oy + Math.sin(p.angle) * dist));
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
        if (players[t]) kill(players[t], p, 'trail');
      }
      if (owner[i] === p.id) {
        if (p.trail.length) capture(p);
      } else {
        setTrail(i, p.id);
        p.trail.push(i);
      }
    }

    function capture(p) {
      const id = p.id;
      const before = p.count;
      for (const i of p.trail) {
        if (trailMap[i] === id) setTrail(i, 0);
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
      if (gained > 0) emit({ k: 'cap', id, g: gained, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
      checkWipeouts(p);
    }

    function headCollisions() {
      for (let a = 1; a < players.length; a++) {
        const p = players[a];
        if (!p || !p.alive) continue;
        for (let b = a + 1; b < players.length; b++) {
          const q = players[b];
          if (!q || !q.alive || !p.alive) continue;
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
          if (!t || t === p.id || (players[t] && players[t].invincible)) continue;
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

    function botThink(p, gdt) {
      const ai = p.ai, id = p.id;
      ai.tick++;
      const inHome = owner[p.cy * W + p.cx] === id;
      let desired = p.angle;

      if (inHome) {
        if (ai.mode !== 'home') { ai.mode = 'home'; ai.plan = null; ai.homeTimer = rand(0.1, 0.9); }
        ai.homeTimer -= gdt;
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
        if (prey >= 0) { ai.hunt = prey; ai.huntUntil = eng.time + 1.5; }
      }
      if (ai.hunt >= 0) {
        const t = trailMap[ai.hunt];
        if (t && t !== id && eng.time < ai.huntUntil) {
          desired = Math.atan2(((ai.hunt / W) | 0) + 0.5 - p.y, (ai.hunt % W) + 0.5 - p.x);
        } else ai.hunt = -1;
      }

      p.target = safeAngle(p, desired);
    }

    function giveBotIdentity(p) {
      const usedNames = new Set(), usedColors = new Set();
      for (const q of players) {
        if (!q || q === p) continue;
        if (!q.isBot || q.alive) { usedNames.add(q.name); usedColors.add(q.color); }
      }
      const names = BOT_NAMES.filter(n => !usedNames.has(n));
      p.name = names.length ? names[randi(0, names.length - 1)] : 'Bot';
      const cols = [];
      for (let c = 0; c < COLOR_COUNT; c++) if (!usedColors.has(c)) cols.push(c);
      p.color = cols.length ? cols[randi(0, cols.length - 1)] : randi(0, COLOR_COUNT - 1);
      p.ai.aggr = Math.random();
      eng.metaVersion++;
    }

    function humanCount() {
      let n = 0;
      for (const p of players) if (p && !p.isBot) n++;
      return n;
    }

    function manageBots() {
      const desired = Math.max(minBots, targetPlayers - humanCount());
      let bots = 0;
      for (const p of players) if (p && p.isBot) bots++;
      for (let k = 1; k < players.length; k++) {
        const p = players[k];
        if (!p || !p.isBot || p.alive || eng.time < p.respawnAt) continue;
        if (bots > desired) { players[k] = null; bots--; eng.metaVersion++; continue; }
        giveBotIdentity(p);
        spawn(p);
      }
      if (bots < desired) {
        const id = allocId();
        if (id > 0) {
          const b = newPlayer(id, true);
          b.respawnAt = eng.time + 0.5;
          players[id] = b;
        }
      }
    }

    // ---------- Öffentliche Schnittstelle ----------
    eng.step = function () {
      eng.time += STEP;
      eng.stepCount++;
      // Bei hohem Tempo in Teilschritte zerlegen, damit kein Feld übersprungen wird
      const mul = eng.speedMul;
      const n = Math.max(1, Math.ceil((SPEED * mul * STEP) / MAX_SUBSTEP));
      const dist = (SPEED * mul * STEP) / n, turn = (TURN * mul * STEP) / n, gdt = (STEP * mul) / n;
      for (let sub = 0; sub < n; sub++) {
        for (let k = 1; k < players.length; k++) {
          const p = players[k];
          if (p && p.alive && p.isBot) botThink(p, gdt);
        }
        for (let k = 1; k < players.length; k++) {
          const p = players[k];
          if (p && p.alive) move(p, dist, turn);
        }
        headCollisions();
      }
      manageBots();
      for (const p of players) if (p && p.alive) p.bestPct = Math.max(p.bestPct, (p.count / N) * 100);
    };

    eng.prewarm = function (seconds) {
      const n = Math.round(seconds / STEP);
      for (let k = 0; k < n; k++) eng.step();
    };

    eng.addHuman = function (name, color) {
      const id = allocId();
      if (id < 0) return null;
      const p = newPlayer(id, false);
      p.name = cleanName(name, 'Spieler');
      p.color = cleanColor(color);
      players[id] = p;
      eng.metaVersion++;
      emit({ k: 'join', id, n: p.name });
      return p;
    };

    eng.spawnPlayer = function (p, name, color) {
      if (!p || p.alive || players[p.id] !== p) return;
      if (name !== undefined) p.name = cleanName(name, p.name || 'Spieler');
      if (color !== undefined) p.color = cleanColor(color);
      if (!isRainbowName(p.name)) p.invincible = false;
      // Bots mit derselben Farbe bekommen eine andere
      for (const q of players) if (q && q.isBot && q.color === p.color) giveBotIdentity(q);
      spawn(p);
      eng.metaVersion++;
    };

    eng.removePlayer = function (p) {
      if (!p || players[p.id] !== p) return;
      if (p.alive) kill(p, null, 'leave');
      players[p.id] = null;
      eng.metaVersion++;
    };

    /** Unsterblichkeit an/aus – nur für Spieler namens "Einhorn". */
    eng.setInvincible = function (p, on) {
      if (!p || p.isBot || players[p.id] !== p || !isRainbowName(p.name)) return false;
      on = !!on;
      if (p.invincible === on) return true;
      p.invincible = on;
      emit({ k: 'god', id: p.id, on: on ? 1 : 0, n: p.name });
      return true;
    };

    /** Tempo-Stufe setzen (1, 1.25, 1.5, 2, 2.5, 5 oder 10). */
    eng.setSpeed = function (mul) {
      mul = Number(mul);
      if (SPEEDS.indexOf(mul) < 0) mul = 1;
      eng.speedMul = mul;
      return mul;
    };

    eng.setTarget = function (p, angle) {
      if (p && Number.isFinite(angle)) p.target = angle;
    };

    eng.setTrackDirty = function (on) {
      eng.trackDirty = !!on;
      for (const i of eng.dirty) dirtyMark[i] = 0;
      eng.dirty.length = 0;
      eng.events.length = 0;
      lastMetaSent = -1;
    };

    // ---------- Netzwerk-Kodierung ----------
    function encodeMeta() {
      const m = [];
      for (const p of players) if (p) m.push([p.id, p.name, p.color, p.isBot ? 1 : 0]);
      return m;
    }
    function encodePlayers() {
      const out = [];
      for (const p of players) {
        if (!p) continue;
        out.push([p.id, Math.round(p.x * 100), Math.round(p.y * 100), Math.round(p.angle * 1000),
          p.alive ? 1 : 0, p.count, p.kills, Math.round(p.spawnTime * 10), p.invincible ? 1 : 0]);
      }
      return out;
    }

    eng.fullSnapshot = function () {
      return {
        t: 'full', W, H, time: Math.round(eng.time * 100) / 100, sp: eng.speedMul,
        o: rleEncode(owner), tr: rleEncode(trailMap),
        m: encodeMeta(), p: encodePlayers(),
      };
    };

    eng.takeDelta = function () {
      const c = [];
      for (const i of eng.dirty) { c.push(i, owner[i], trailMap[i]); dirtyMark[i] = 0; }
      eng.dirty.length = 0;
      const msg = { t: 'd', time: Math.round(eng.time * 100) / 100, sp: eng.speedMul, c, p: encodePlayers() };
      if (eng.events.length) msg.ev = eng.events.splice(0);
      if (eng.metaVersion !== lastMetaSent) { msg.m = encodeMeta(); lastMetaSent = eng.metaVersion; }
      return msg;
    };

    // Startbots
    const startBots = Math.max(minBots, targetPlayers);
    for (let k = 0; k < startBots; k++) {
      const id = allocId();
      const b = newPlayer(id, true);
      players[id] = b;
      giveBotIdentity(b);
      spawn(b);
    }

    return eng;
  }

  /**
   * Verbindet Netzwerk-Clients mit einer Engine. Wird vom Online-Server und vom
   * Raum-Gastgeber im Browser benutzt. Ein Client braucht nur eine send(obj)-Funktion.
   */
  function createHub(engine, opts) {
    opts = opts || {};
    const maxHumans = opts.maxHumans || 30;
    const clients = new Set();
    const hub = {
      clients,
      add(send) {
        const c = { send, player: null };
        clients.add(c);
        return c;
      },
      remove(c) {
        if (!clients.has(c)) return;
        clients.delete(c);
        if (c.player) engine.removePlayer(c.player);
        c.player = null;
      },
      message(c, msg) {
        if (!msg || typeof msg !== 'object' || !clients.has(c)) return;
        if (msg.t === 'join' && !c.player) {
          let humans = 0;
          for (const p of engine.players) if (p && !p.isBot) humans++;
          const p = humans < maxHumans ? engine.addHuman(msg.name, msg.color) : null;
          if (!p) { c.send({ t: 'full-room' }); return; }
          c.player = p;
          engine.spawnPlayer(p);
          c.send({ t: 'welcome', id: p.id });
          c.send(engine.fullSnapshot());
        } else if (msg.t === 'spawn' && c.player && !c.player.alive) {
          engine.spawnPlayer(c.player, msg.name, msg.color);
        } else if (msg.t === 'dir' && c.player && c.player.alive) {
          engine.setTarget(c.player, Number(msg.a));
        } else if (msg.t === 'god' && c.player) {
          engine.setInvincible(c.player, !!msg.on);
        }
      },
      // Nach jedem Simulationsschritt aufrufen; schickt 20x pro Sekunde ein Update.
      afterStep() {
        if (engine.stepCount % NET_EVERY !== 0) return;
        const d = engine.takeDelta();
        for (const c of clients) if (c.player) c.send(d);
      },
    };
    engine.setTrackDirty(true);
    return hub;
  }

  return {
    W, H, N, SPEED, TURN, STEP, COLOR_COUNT, SPEEDS,
    createEngine, createHub, isRainbowName, cleanName, wrapAngle, turnToward, rleDecode,
  };
});
