'use strict';
/*
 * Papierfresser – Online-Server.
 * Liefert das Spiel aus (statische Dateien) und betreibt eine gemeinsame
 * Spielwelt, mit der sich alle Browser per WebSocket unter /ws verbinden.
 *
 * Start: npm install && npm start   (Port über die Umgebungsvariable PORT, Standard 8080)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const FE = require('../engine.js');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.join(__dirname, '..');
const MAX_HUMANS = Number(process.env.MAX_PLAYERS) || 30;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};
const PUBLIC = new Set(['/index.html', '/style.css', '/game.js', '/engine.js', '/icon.png', '/manifest.webmanifest']);

// ---------- Spielwelt ----------
const engine = FE.createEngine({ targetPlayers: 11 });
// Tempo des Online-Servers: Umgebungsvariable SPEED (1, 1.25, 1.5, 2, 2.5, 5 oder 10)
engine.setSpeed(process.env.SPEED || 1);
engine.prewarm(20);
const hub = FE.createHub(engine, { maxHumans: MAX_HUMANS });

let last = process.hrtime.bigint();
let acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Math.min(0.25, Number(now - last) / 1e9);
  last = now;
  while (acc >= FE.STEP) {
    engine.step();
    hub.afterStep();
    acc -= FE.STEP;
  }
}, 1000 / 60);

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  if (url === '/config.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-cache' });
    res.end("window.FARBREVIER_SERVER = 'same-origin';\n");
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!PUBLIC.has(url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Nicht gefunden');
    return;
  }
  fs.readFile(path.join(ROOT, url), (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(url)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', ws => {
  const client = hub.add(msg => {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1e6) ws.send(JSON.stringify(msg));
  });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    hub.message(client, msg);
  });
  ws.on('close', () => hub.remove(client));
  ws.on('error', () => hub.remove(client));
});

// tote Verbindungen aufräumen
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

server.listen(PORT, () => {
  console.log(`Papierfresser-Server läuft auf http://localhost:${PORT}`);
});
