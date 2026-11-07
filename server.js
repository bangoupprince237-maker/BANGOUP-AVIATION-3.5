// Serveur du simulateur : sert le dossier public/ et relaie les messages entre joueurs (WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon' };
const MAX_PER_ROOM = 32;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const rooms = new Map(); // nom du salon -> Map(id -> socket)
let nextId = 1;
const clean = (s, n) => String(s || '').replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, n);

function broadcast(room, msg, except) {
  const r = rooms.get(room); if (!r) return; const data = JSON.stringify(msg);
  for (const [id, c] of r) if (id !== except && c.readyState === 1) c.send(data);
}

wss.on('connection', ws => {
  ws.id = nextId++; ws.room = null; ws.alive = true; ws.chatTimes = [];
  ws.on('pong', () => ws.alive = true);
  ws.on('message', raw => {
    if (raw.length > 16000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join' && !ws.room) {
      const room = clean(m.room, 24) || 'public'; ws.name = clean(m.name, 20) || 'Pilote'; ws.plane = clean(m.plane, 30);
      if (!rooms.has(room)) rooms.set(room, new Map());
      const r = rooms.get(room);
      if (r.size >= MAX_PER_ROOM) { ws.send(JSON.stringify({ t: 'full' })); return; }
      ws.room = room;
      ws.send(JSON.stringify({ t: 'welcome', id: ws.id, players: [...r.values()].map(c => ({ id: c.id, name: c.name, plane: c.plane })) }));
      r.set(ws.id, ws);
      broadcast(room, { t: 'join', id: ws.id, name: ws.name, plane: ws.plane }, ws.id);
      return;
    }
    if (!ws.room) return;
    if (m.t === 'chat') {
      const now = Date.now(); ws.chatTimes = ws.chatTimes.filter(t => now - t < 10000);
      if (ws.chatTimes.length >= 5) return; // anti-spam : 5 messages / 10 s
      ws.chatTimes.push(now);
      broadcast(ws.room, { t: 'chat', id: ws.id, name: ws.name, text: clean(m.text, 200) });
      return;
    }
    // positions, tirs, etc. : relayés tels quels avec l'identifiant de l'expéditeur
    m.id = ws.id; broadcast(ws.room, m, ws.id);
  });
  ws.on('close', () => {
    if (!ws.room) return; const r = rooms.get(ws.room); if (!r) return;
    r.delete(ws.id); broadcast(ws.room, { t: 'leave', id: ws.id });
    if (!r.size) rooms.delete(ws.room);
  });
});
// déconnexions silencieuses
setInterval(() => { wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; try { ws.ping(); } catch (e) { } }); }, 15000);

server.listen(PORT, () => console.log('Simulateur prêt : http://localhost:' + PORT));
