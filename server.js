// ============================================================
// CALCULUS QUEST — Game Server
// Ubuntu/Debian + Node.js
// Run: node server.js
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Railway (and most cloud platforms) assign a port via environment variable
const PORT = process.env.PORT || 3000;

// ── Static file server ──────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'student.html' : req.url);
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ── WebSocket server ─────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// rooms[code] = { host: ws, students: Map<id, ws>, state: {...} }
const rooms = {};

function broadcast(room, msg, excludeWs = null) {
  const str = JSON.stringify(msg);
  if (room.host && room.host !== excludeWs) safeSend(room.host, str);
  room.students.forEach((ws) => {
    if (ws !== excludeWs) safeSend(ws, str);
  });
}

function safeSend(ws, str) {
  try { if (ws.readyState === 1) ws.send(str); } catch(e) {}
}

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  ws.role = null;
  ws.roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, msg);
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (ws.role === 'host') {
      // Host left — notify students, clean up room
      broadcast(room, { type: 'host_disconnected' });
      delete rooms[code];
      console.log(`[${code}] Room closed (host left)`);
    } else {
      // Student left
      room.students.delete(ws.id);
      if (room.state && room.state.players) {
        room.state.players = room.state.players.filter(p => p.id !== ws.id);
      }
      broadcast(room, { type: 'player_left', id: ws.id });
      safeSend(room.host, JSON.stringify({
        type: 'lobby_update',
        players: getLobbyPlayers(room)
      }));
      console.log(`[${code}] ${ws.id} disconnected`);
    }
  });
});

function handle(ws, msg) {
  switch (msg.type) {

    // ── HOST creates a room ──────────────────────────────────
    case 'create_room': {
      const code = makeCode();
      rooms[code] = {
        host: ws,
        students: new Map(),
        state: null,
        duration: msg.duration || 600,
        status: 'lobby',
      };
      ws.role = 'host';
      ws.roomCode = code;
      safeSend(ws, JSON.stringify({ type: 'room_created', code }));
      console.log(`[${code}] Room created`);
      break;
    }

    // ── STUDENT joins ────────────────────────────────────────
    case 'join': {
      const code = msg.code?.toUpperCase();
      const room = rooms[code];
      if (!room) {
        safeSend(ws, JSON.stringify({ type: 'error', msg: 'Room not found. Check the code!' }));
        return;
      }
      if (room.status === 'playing') {
        safeSend(ws, JSON.stringify({ type: 'error', msg: 'Game already in progress!' }));
        return;
      }
      if (room.status === 'finished') {
        safeSend(ws, JSON.stringify({ type: 'error', msg: 'That game is already over!' }));
        return;
      }
      if (room.students.size >= 12) {
        safeSend(ws, JSON.stringify({ type: 'error', msg: 'Room is full (max 12 players)!' }));
        return;
      }

      ws.role = 'student';
      ws.roomCode = code;
      ws.playerName = msg.name || `Spartan ${room.students.size + 1}`;
      room.students.set(ws.id, ws);

      safeSend(ws, JSON.stringify({
        type: 'joined',
        id: ws.id,
        name: ws.playerName,
        code,
      }));

      // Tell host about new player
      safeSend(room.host, JSON.stringify({
        type: 'lobby_update',
        players: getLobbyPlayers(room),
      }));

      console.log(`[${code}] ${ws.playerName} joined (${room.students.size} players)`);
      break;
    }

    // ── HOST starts the game ─────────────────────────────────
    case 'start_game': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'host') return;
      room.status = 'playing';
      room.state = msg.state; // full initial game state from host
      broadcast(room, { type: 'game_started', state: msg.state });
      console.log(`[${ws.roomCode}] Game started with ${room.students.size} players`);
      break;
    }

    // ── HOST pushes updated game state ───────────────────────
    case 'state_update': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'host') return;
      room.state = msg.state;
      // Forward to all students
      room.students.forEach((sw) => safeSend(sw, JSON.stringify({
        type: 'state_update',
        state: msg.state,
      })));
      break;
    }

    // ── STUDENT sends a move ─────────────────────────────────
    case 'player_move': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'student') return;
      safeSend(room.host, JSON.stringify({
        type: 'player_move',
        id: ws.id,
        dx: msg.dx,
        dy: msg.dy,
      }));
      break;
    }

    // ── STUDENT sends a quiz answer ──────────────────────────
    case 'quiz_answer': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'student') return;
      safeSend(room.host, JSON.stringify({
        type: 'quiz_answer',
        id: ws.id,
        chosen: msg.chosen,
      }));
      break;
    }

    // ── HOST sends quiz to a specific student ────────────────
    case 'send_quiz': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'host') return;
      const targetWs = room.students.get(msg.playerId);
      if (targetWs) {
        safeSend(targetWs, JSON.stringify({
          type: 'quiz',
          question: msg.question,
          mode: msg.mode,
          opponentName: msg.opponentName || null,
        }));
      }
      // Tell all other students to show "quiz in progress" screen
      room.students.forEach((sw, id) => {
        if (id !== msg.playerId) {
          safeSend(sw, JSON.stringify({
            type: 'quiz_watching',
            playerName: msg.playerName,
            playerColor: msg.playerColor,
          }));
        }
      });
      break;
    }

    // ── HOST broadcasts quiz result ──────────────────────────
    case 'quiz_result': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'host') return;
      broadcast(room, { type: 'quiz_result', ...msg });
      break;
    }

    // ── HOST ends the game ───────────────────────────────────
    case 'game_over': {
      const room = rooms[ws.roomCode];
      if (!room || ws.role !== 'host') return;
      room.status = 'finished';
      broadcast(room, { type: 'game_over', players: msg.players });
      console.log(`[${ws.roomCode}] Game over`);
      break;
    }

    // ── Generic chat/log message ─────────────────────────────
    case 'log': {
      const room = rooms[ws.roomCode];
      if (!room) return;
      broadcast(room, { type: 'log', text: msg.text }, ws);
      break;
    }

    default:
      break;
  }
}

function getLobbyPlayers(room) {
  const players = [];
  room.students.forEach((ws) => {
    players.push({ id: ws.id, name: ws.playerName });
  });
  return players;
}

// ── Start ────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║    CALCULUS QUEST — Server Ready     ║');
  console.log(`  ║    Port: ${PORT.toString().padEnd(28)}║`);
  console.log('  ║    Ctrl+C to stop                    ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    console.log(`  🌐 Public URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
    console.log(`  📋 Host page:  https://${process.env.RAILWAY_PUBLIC_DOMAIN}/host.html`);
    console.log(`  👩‍🎓 Students:   https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  }
  console.log('');
});
