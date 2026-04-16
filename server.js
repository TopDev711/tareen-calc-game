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
      if (!msg.playerId) return; // ignore turn-change pings with no quiz
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

// ═══════════════════════════════════════════════════════
// ROCKET CALC — Game Rooms
// ═══════════════════════════════════════════════════════
const rocketRooms = {}; // code -> { p1: ws, p2: ws, state: {...}, interval }

const FIELD_W=1000, FIELD_H=650, BALL_R=14;
const GOAL_H=180, GOAL_W=18, MATCH_TIME=180;
const POWERUP_COUNT=3;

const ROCKET_QS=[
  {t:"7.4",q:"For dy/dx=x−y, horizontal tangents occur where:",cs:["x=0","y=0","x=y","y=−x"],a:2},
  {t:"7.4",q:"dy/dx=y² has slope 0 along:",cs:["y=1","x=0","y=0","x=y"],a:2},
  {t:"7.6",q:"Separate dy/dx=2x/y. Which integral is correct?",cs:["∫y dy=∫2x dx","∫dy/y=∫2x dx","∫y dy=∫x dx","∫1/y dy=∫2 dx"],a:0},
  {t:"7.6",q:"General solution to dy/dx=ky:",cs:["y=kx+C","y=Ce^(kx)","y=e^(kx)+C","y=k ln|x|+C"],a:1},
  {t:"7.6",q:"Which DE is NOT separable?",cs:["dy/dx=xy","dy/dx=x+y","dy/dx=x/y","dy/dx=ye^x"],a:1},
  {t:"7.7",q:"Particular solution: dy/dx=2x, y(0)=5:",cs:["y=x²+5","y=2x+5","y=x²−5","y=2x²+5"],a:0},
  {t:"7.7",q:"Solve dy/dx=3y with y(0)=2:",cs:["y=3e^(2x)","y=2e^(3x)","y=2+3x","y=6e^x"],a:1},
  {t:"7.7",q:"dy/dx=−2y, y(0)=10. Find y(1):",cs:["10e^(−2)","−20","10e^2","8"],a:0},
  {t:"7.7",q:"Solve dy/dx=2xy with y(0)=1:",cs:["y=e^(x²)","y=e^(2x)","y=x²+1","y=2x+1"],a:0},
  {t:"7.8",q:"y=5e^(3t) satisfies dy/dt=ky. k=?",cs:["k=5","k=3","k=15","k=1/3"],a:1},
  {t:"7.8",q:"4% continuous decay model:",cs:["A=A₀e^(0.04t)","A=A₀(0.96)^t","A=A₀e^(−0.04t)","A=A₀−0.04t"],a:2},
  {t:"7.8",q:"Newton's Cooling: cooling object, k is:",cs:["Positive","Negative","Zero","Any real"],a:1},
  {t:"7.8",q:"Solution to logistic dP/dt=kP(1−P/M):",cs:["P=Ce^(kt)","P=M/(1+Ae^(−kt))","P=Me^(kt)","P=kMt"],a:1},
];

const TAREEN_COMMENTARY=[
  "Mr. Tareen screams into the void! 😱",
  "dy/dx of that move = INFINITE! 🔥",
  "Mr. Tareen spills his coffee! ☕",
  "The limit of that shot approaches GLORY! ✨",
  "That's separable from all other plays! 🤯",
  "e^amazing right there! 📈",
  "Mr. Tareen stands up from his chair! 🪑",
  "Newton's law of scoring = always positive! ➕",
  "That shot was exponentially good! 📊",
];

function rSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e){}
}

function makeInitState(p1ws, p2ws) {
  const goalTop=(FIELD_H-GOAL_H)/2;
  const powerups=[];
  for(let i=0;i<POWERUP_COUNT;i++){
    powerups.push({
      id:i,
      x:200+Math.random()*(FIELD_W-400),
      y:80+Math.random()*(FIELD_H-160),
      active:true
    });
  }
  return {
    players:[
      {id:p1ws.id,name:p1ws.rName,color:p1ws.rColor,
        x:180,y:FIELD_H/2,angle:0,vx:0,vy:0,boost:100},
      {id:p2ws.id,name:p2ws.rName,color:p2ws.rColor,
        x:FIELD_W-180,y:FIELD_H/2,angle:Math.PI,vx:0,vy:0,boost:100},
    ],
    ball:{x:FIELD_W/2,y:FIELD_H/2,vx:0,vy:0},
    powerups,
    p1score:0, p2score:0,
    timeLeft:MATCH_TIME,
    usedQ:new Set(),
    pendingQuiz:null,
  };
}

function resetBall(state) {
  state.ball={x:FIELD_W/2,y:FIELD_H/2,
    vx:(Math.random()-.5)*120,vy:(Math.random()-.5)*80};
}

function pickRocketQ(state) {
  const avail=ROCKET_QS.map((_,i)=>i).filter(i=>!state.usedQ.has(i));
  if(!avail.length){ state.usedQ=new Set(); return ROCKET_QS[0]; }
  const idx=avail[Math.floor(Math.random()*avail.length)];
  state.usedQ.add(idx);
  return ROCKET_QS[idx];
}

function startRocketLoop(code) {
  const room=rocketRooms[code];
  if(!room) return;
  if(room.interval) clearInterval(room.interval);

  let tick=0;
  room.interval=setInterval(()=>{
    const s=room.state;
    if(!s) return;
    // countdown
    s.timeLeft=Math.max(0,s.timeLeft-0.1);

    // Check goals
    const ball=s.ball;
    const goalTop=(FIELD_H-GOAL_H)/2, goalBot=(FIELD_H+GOAL_H)/2;

    // Left goal scored (P2 scores)
    if(ball.x-BALL_R<=0 && ball.y>goalTop && ball.y<goalBot){
      s.p2score++;
      const scorer=s.players[1];
      broadcastRocket(room,{type:'rocket_goal',
        scorer:scorer.name,scorerColor:scorer.color,
        p1score:s.p1score,p2score:s.p2score});
      resetBall(s);
    }
    // Right goal scored (P1 scores)
    if(ball.x+BALL_R>=FIELD_W && ball.y>goalTop && ball.y<goalBot){
      s.p1score++;
      const scorer=s.players[0];
      broadcastRocket(room,{type:'rocket_goal',
        scorer:scorer.name,scorerColor:scorer.color,
        p1score:s.p1score,p2score:s.p2score});
      resetBall(s);
    }

    // Powerup collision
    s.powerups.forEach(p=>{
      if(!p.active) return;
      s.players.forEach((car,pidx)=>{
        const dx=car.x-p.x, dy=car.y-p.y;
        if(Math.sqrt(dx*dx+dy*dy)<28){
          p.active=false;
          // Send question to that player
          const q=pickRocketQ(s);
          s.pendingQuiz={playerId:car.id,playerIdx:pidx,powerupId:p.id};
          const targetWs=pidx===0?room.p1:room.p2;
          rSend(targetWs,{type:'rocket_powerup',question:q});
          // Respawn powerup after 10s
          setTimeout(()=>{
            if(rocketRooms[code]) p.active=true;
          },10000);
        }
      });
    });

    // Random commentary every ~20s
    tick++;
    if(tick%200===0){
      broadcastRocket(room,{type:'rocket_commentary',
        text:TAREEN_COMMENTARY[Math.floor(Math.random()*TAREEN_COMMENTARY.length)]});
    }

    // Broadcast state every 3 ticks (~300ms)
    if(tick%3===0){
      const statePush={
        players:s.players.map(p=>({
          id:p.id,name:p.name,color:p.color,
          x:p.x,y:p.y,angle:p.angle,
          vx:p.vx,vy:p.vy,boost:p.boost
        })),
        ball:{...s.ball},
        powerups:s.powerups.map(p=>({id:p.id,x:p.x,y:p.y,active:p.active})),
        p1score:s.p1score, p2score:s.p2score, timeLeft:s.timeLeft
      };
      broadcastRocket(room,{type:'rocket_state',state:statePush});
    }

    // End game
    if(s.timeLeft<=0){
      clearInterval(room.interval);
      broadcastRocket(room,{type:'rocket_end',
        p1score:s.p1score, p2score:s.p2score,
        p1name:s.players[0].name, p2name:s.players[1].name,
        p1color:s.players[0].color, p2color:s.players[1].color});
      setTimeout(()=>delete rocketRooms[code],30000);
    }
  },100);
}

function broadcastRocket(room,msg){
  const str=JSON.stringify(msg);
  try { if(room.p1&&room.p1.readyState===1) room.p1.send(str); }catch(e){}
  try { if(room.p2&&room.p2.readyState===1) room.p2.send(str); }catch(e){}
}

// Hook rocket messages into main handler
const _origHandle=handle;
function handle(ws,msg){
  if(msg.type&&msg.type.startsWith('rocket_')){
    handleRocket(ws,msg); return;
  }
  _origHandle(ws,msg);
}

function handleRocket(ws,msg){
  switch(msg.type){
    case 'rocket_join': {
      const code=msg.code?.toUpperCase();
      if(!code){ rSend(ws,{type:'error',msg:'No room code provided.'}); return; }

      ws.rName=msg.name||'Spartan';
      ws.rColor=msg.color||'#ff6a00';
      ws.rCode=code;

      if(!rocketRooms[code]){
        rocketRooms[code]={p1:ws,p2:null,state:null};
        ws.rNum=1;
        rSend(ws,{type:'rocket_joined',id:ws.id,playerNum:1});
        rSend(ws,{type:'rocket_waiting',msg:'Waiting for opponent…'});
        console.log(`[ROCKET ${code}] P1 joined: ${ws.rName}`);
      } else if(!rocketRooms[code].p2){
        const room=rocketRooms[code];
        room.p2=ws; ws.rNum=2;
        rSend(ws,{type:'rocket_joined',id:ws.id,playerNum:2});
        // Both players ready — start!
        room.state=makeInitState(room.p1,room.p2);
        const initMsg={type:'rocket_start',state:{
          players:room.state.players,
          ball:room.state.ball,
          powerups:room.state.powerups,
          p1score:0,p2score:0,timeLeft:MATCH_TIME
        }};
        broadcastRocket(room,initMsg);
        setTimeout(()=>startRocketLoop(code),1000);
        console.log(`[ROCKET ${code}] P2 joined: ${ws.rName} — MATCH START!`);
      } else {
        rSend(ws,{type:'error',msg:'Room is full! Try a different code.'});
      }
      break;
    }

    case 'rocket_input': {
      const code=ws.rCode;
      const room=rocketRooms[code];
      if(!room||!room.state) return;
      const s=room.state;
      const idx=ws.rNum===1?0:1;
      // Update authoritative state from player's input
      s.players[idx].x=msg.x;
      s.players[idx].y=msg.y;
      s.players[idx].angle=msg.angle;
      s.players[idx].vx=msg.vx;
      s.players[idx].vy=msg.vy;
      s.players[idx].boost=msg.boost;
      // Accept ball updates from P1 (host-of-ball)
      if(ws.rNum===1 && msg.ballX!==undefined){
        s.ball.x=msg.ballX; s.ball.y=msg.ballY;
        s.ball.vx=msg.ballVx; s.ball.vy=msg.ballVy;
      }
      break;
    }

    case 'rocket_quiz_answer': {
      const code=ws.rCode;
      const room=rocketRooms[code];
      if(!room||!room.state) return;
      const s=room.state;
      const correct=msg.correct;
      const idx=ws.rNum===1?0:1;
      const otherIdx=idx===0?1:0;

      if(correct){
        s.players[idx].boost=Math.min(100,s.players[idx].boost+70);
        rSend(ws,{type:'rocket_boost',targetId:ws.id,granted:true});
      } else {
        // Opponent gets boost
        s.players[otherIdx].boost=Math.min(100,s.players[otherIdx].boost+50);
        const otherWs=idx===0?room.p2:room.p1;
        rSend(ws,{type:'rocket_boost',targetId:ws.id,granted:false});
        rSend(otherWs,{type:'rocket_boost',targetId:otherWs.id,granted:true});
      }
      s.pendingQuiz=null;
      break;
    }
  }
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
