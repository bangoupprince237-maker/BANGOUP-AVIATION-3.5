// Serveur du simulateur : sert le dossier public/ et relaie les messages entre joueurs (WebSocket)
// ACCÈS PRIVÉ : le code est demandé À CHAQUE ouverture du jeu (rien n'est mémorisé sur l'appareil).
//   Le propriétaire change le code depuis le jeu (bouton 🔑) avec son code maître.
//   RENDER_API_KEY (facultatif, dans Render > Environment) = le nouveau code est gardé pour toujours.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const LOGIN_PAGE = path.join(__dirname, 'acces.html');
const TYPES_UNUSED = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon' };
const MAX_PER_ROOM = 32;

// ---------- code d'accès UNIQUE (toujours demandé, à chaque ouverture du jeu) ----------
// Code de départ : « BANG vol ». Le propriétaire le change depuis le jeu (bouton 🔑 Code d'accès) avec son CODE MAÎTRE.
// Le code maître n'est écrit nulle part en clair : seule son empreinte (impossible à inverser) est ici.
const MASTER_SALT = '797adae00e1efc7b943f3658e03a6e69';
const MASTER_HASH = '7464aa835d171c662869d59660154f05f95b87bb506ff29b20bd72c361c08208';
const CODE_FILE = path.join(__dirname, 'code-acces.local.txt');
let accessCode = 'BANG vol';
try { if (process.env.ACCESS_CODE) accessCode = String(process.env.ACCESS_CODE); } catch (e) { }
try { const f = fs.readFileSync(CODE_FILE, 'utf8').trim(); if (f) accessCode = f; } catch (e) { }
function sameText(a, b) { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); }
function isMaster(code) {
  code = String(code || '').trim(); if (!code) return false;
  if (process.env.MASTER_CODE && sameText(code, String(process.env.MASTER_CODE).trim())) return true;
  return sameText(crypto.scryptSync(code, MASTER_SALT, 32).toString('hex'), MASTER_HASH);
}
// billets : un billet d'entrée sert UNE seule fois (actualiser la page = redemander le code)
const entryTickets = new Map(); // billet -> expiration
const playTickets = new Map();  // billet de partie (multijoueur, changement de code) -> expiration
const newTicket = () => crypto.randomBytes(24).toString('hex');
setInterval(() => { const n = Date.now(); for (const M of [entryTickets, playTickets]) for (const [k, t] of M) if (t < n) M.delete(k); }, 60000);
// anti-devinette : 6 essais ratés -> attendre 10 minutes
const fails = new Map();
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function blockedFor(ip) { const f = fails.get(ip); if (!f) return 0; if (Date.now() - f.t > 10 * 60000) { fails.delete(ip); return 0; } return f.n >= 6 ? Math.ceil((10 * 60000 - (Date.now() - f.t)) / 60000) : 0; }
function addFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 10 * 60000) fails.set(ip, { n: 1, t: Date.now() }); else f.n++; return fails.get(ip); }

function sendLogin(res, status, info) {
  fs.readFile(LOGIN_PAGE, 'utf8', (err, html) => {
    if (err) html = '<h1>Accès privé</h1>';
    html = html.replace('__INFO__', JSON.stringify(info || {}).replace(/</g, '\\u003c'));
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
    res.end(html);
  });
}
// enregistre le nouveau code pour toujours dans Render (si la clé RENDER_API_KEY est réglée)
function saveToRender(code) {
  return new Promise(resolve => {
    const key = process.env.RENDER_API_KEY, sid = process.env.RENDER_SERVICE_ID; if (!key || !sid) return resolve(false);
    const body = JSON.stringify({ value: code });
    const rq = require('https').request({ method: 'PUT', hostname: 'api.render.com', path: '/v1/services/' + sid + '/env-vars/ACCESS_CODE', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => { r.resume(); resolve(r.statusCode >= 200 && r.statusCode < 300); });
    rq.on('error', () => resolve(false)); rq.setTimeout(8000, () => { rq.destroy(); resolve(false); }); rq.end(body);
  });
}
function readBody(req, max) { return new Promise(resolve => { let b = ''; req.on('data', d => { b += d; if (b.length > max) req.destroy(); }); req.on('end', () => resolve(b)); }); }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x'); let p = decodeURIComponent(url.pathname);

  // ---- vérification du code ----
  if (p === '/acces' && req.method === 'POST') {
    const ip = ipOf(req); const wait = blockedFor(ip); const body = await readBody(req, 2000);
    if (wait) return sendLogin(res, 429, { err: 'Trop d\'essais. Réessayez dans ' + wait + ' min.' });
    const code = String(new URLSearchParams(body).get('code') || '').trim();
    if (!code || !sameText(code, accessCode)) { const f = addFail(ip); return sendLogin(res, 401, { err: 'Code incorrect.', left: Math.max(0, 6 - f.n) }); }
    fails.delete(ip); const t = newTicket(); entryTickets.set(t, Date.now() + 60000);
    res.writeHead(303, { Location: '/?entree=' + t, 'Cache-Control': 'no-store' }); return res.end();
  }
  // ---- changement du code (depuis le jeu, avec le CODE MAÎTRE) ----
  if (p === '/changer-code' && req.method === 'POST') {
    const ip = ipOf(req); const wait = blockedFor(ip); let m = {}; try { m = JSON.parse(await readBody(req, 4000)); } catch (e) { }
    if (wait) return json(res, 429, { ok: false, msg: 'Trop d\'essais. Réessayez dans ' + wait + ' min.' });
    if (!m.ticket || !playTickets.has(m.ticket)) return json(res, 401, { ok: false, msg: 'Session expirée : rechargez le jeu et entrez le code.' });
    if (!isMaster(m.maitre)) { const f = addFail(ip); return json(res, 403, { ok: false, msg: 'Code maître incorrect. Il reste ' + Math.max(0, 6 - f.n) + ' essai(s).' }); }
    const nv = String(m.nouveau || '').trim();
    if (nv.length < 4 || nv.length > 40) return json(res, 400, { ok: false, msg: 'Le nouveau code doit avoir entre 4 et 40 caractères.' });
    fails.delete(ip); accessCode = nv; try { fs.writeFileSync(CODE_FILE, nv); } catch (e) { }
    const saved = await saveToRender(nv);
    return json(res, 200, { ok: true, permanent: saved, msg: saved ? 'Nouveau code enregistré pour toujours.' : 'Nouveau code actif. Attention : sans la clé RENDER_API_KEY dans Render, il reviendra à l\'ancien code au prochain redémarrage du serveur.' });
  }

  // ---- le jeu : seulement avec un billet d'entrée tout neuf (jamais mémorisé) ----
  if (p === '/' || p === '/index.html') {
    const t = url.searchParams.get('entree'); const exp = t && entryTickets.get(t);
    if (!exp || exp < Date.now()) return sendLogin(res, 200, {});
    entryTickets.delete(t); // utilisé une seule fois
    const play = newTicket(); playTickets.set(play, Date.now() + 12 * 3600 * 1000);
    return fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('Jeu introuvable'); }
      html = html.replace('<head>', '<head><script>window.__SIM_TICKET=' + JSON.stringify(play) + ';history.replaceState(null,"","/");</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', 'X-Frame-Options': 'SAMEORIGIN' });
      res.end(html);
    });
  }
  // tout le reste est fermé (le jeu tient dans un seul fichier)
  res.writeHead(303, { Location: '/' }); res.end();
});

// le multijoueur aussi est réservé à ceux qui ont le code
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, verifyClient: (info) => { try { const t = new URL(info.req.url, 'http://x').searchParams.get('ticket'); return !!(t && playTickets.has(t)); } catch (e) { return false; } } });
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

server.listen(PORT, () => console.log('Simulateur prêt : http://localhost:' + PORT + ' (accès protégé par code)'));
