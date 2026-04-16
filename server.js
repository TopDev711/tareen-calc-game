// ============================================================
// MR. TAREEN'S GAME SERVER
// Handles: Calculus Quest + Rocket Calc
// Run: node server.js
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
};

const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'student.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

function safeSend(ws, obj) {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e) {}
}

// ════════════════════════════════════════════
// CALCULUS QUEST
// ════════════════════════════════════════════
const rooms = {};

function cqCast(room, msg, skip) {
  if (room.host && room.host !== skip) safeSend(room.host, msg);
  room.students.forEach(ws => { if (ws !== skip) safeSend(ws, msg); });
}

function makeCode() { return Math.random().toString(36).substring(2,8).toUpperCase(); }
function lobbyList(room) {
  const out = [];
  room.students.forEach(ws => out.push({ id: ws.id, name: ws.playerName }));
  return out;
}

function handleCQ(ws, msg) {
  switch(msg.type) {
    case 'create_room': {
      const code = makeCode();
      rooms[code] = { host:ws, students:new Map(), state:null, status:'lobby' };
      ws.cqRole = 'host'; ws.cqCode = code;
      safeSend(ws, { type:'room_created', code });
      console.log(`[CQ] Room created: ${code}`);
      break;
    }
    case 'join': {
      const code = (msg.code||'').toUpperCase();
      const room = rooms[code];
      if (!room) { safeSend(ws, {type:'error', msg:'Room not found!'}); return; }
      if (room.status !== 'lobby') { safeSend(ws, {type:'error', msg:'Game already started!'}); return; }
      if (room.students.size >= 12) { safeSend(ws, {type:'error', msg:'Room full!'}); return; }
      ws.cqRole = 'student'; ws.cqCode = code;
      ws.playerName = (msg.name || `Spartan ${room.students.size+1}`).slice(0,14);
      room.students.set(ws.id, ws);
      safeSend(ws, { type:'joined', id:ws.id, name:ws.playerName, code });
      safeSend(room.host, { type:'lobby_update', players:lobbyList(room) });
      console.log(`[CQ] ${ws.playerName} joined ${code}`);
      break;
    }
    case 'start_game': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'host') return;
      room.status = 'playing'; room.state = msg.state;
      cqCast(room, { type:'game_started', state:msg.state });
      break;
    }
    case 'state_update': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'host') return;
      room.state = msg.state;
      room.students.forEach(sw => safeSend(sw, { type:'state_update', state:msg.state }));
      break;
    }
    case 'player_move': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'student') return;
      safeSend(room.host, { type:'player_move', id:ws.id, dx:msg.dx, dy:msg.dy });
      break;
    }
    case 'quiz_answer': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'student') return;
      safeSend(room.host, { type:'quiz_answer', id:ws.id, chosen:msg.chosen });
      break;
    }
    case 'send_quiz': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'host' || !msg.playerId) return;
      const t = room.students.get(msg.playerId);
      if (t) safeSend(t, { type:'quiz', question:msg.question, mode:msg.mode, opponentName:msg.opponentName||null });
      room.students.forEach((sw,id) => {
        if (id !== msg.playerId) safeSend(sw, { type:'quiz_watching', playerName:msg.playerName, playerColor:msg.playerColor });
      });
      break;
    }
    case 'quiz_result': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'host') return;
      cqCast(room, { type:'quiz_result', ...msg });
      break;
    }
    case 'game_over': {
      const room = rooms[ws.cqCode];
      if (!room || ws.cqRole !== 'host') return;
      room.status = 'finished';
      cqCast(room, { type:'game_over', players:msg.players });
      break;
    }
  }
}

// ════════════════════════════════════════════
// ROCKET CALC
// ════════════════════════════════════════════
const rrooms = {};

const FW=1000, FH=650, BR=14, GH=260, GW=22, MT=180;

const RQS=[
  // ── DISK METHOD ──────────────────────────────────────────────
  {t:"Disk",
   q:"The region bounded by y=√x, x=4, and y=0 is rotated about the x-axis. Which integral gives the volume?",
   cs:["π∫₀⁴ x dx","π∫₀⁴ √x dx","π∫₀⁴ x² dx","2π∫₀⁴ x dx"],a:0},

  {t:"Disk",
   q:"The region bounded by y=2x, x=3, and y=0 is rotated about the x-axis. Find the volume.",
   cs:["12π","18π","36π","72π"],a:2},

  {t:"Disk",
   q:"The region bounded by y=x², x=0, x=2, and y=0 is rotated about the x-axis. Find the volume.",
   cs:["32π/5","8π/3","16π/3","4π"],a:0},

  {t:"Disk",
   q:"Which method is used when a region is rotated about the x-axis and cross-sections perpendicular to the x-axis are circles?",
   cs:["Shell method","Washer method","Disk method","Cylindrical method"],a:2},

  // ── WASHER METHOD ────────────────────────────────────────────
  {t:"Washer",
   q:"The region between y=x and y=x² is rotated about the x-axis. Which integral gives the volume?",
   cs:["π∫₀¹(x−x²)dx","π∫₀¹(x²−x⁴)dx","π∫₀¹(x+x²)dx","2π∫₀¹ x(x−x²)dx"],a:1},

  {t:"Washer",
   q:"The region between y=√x and y=x is rotated about the x-axis. The OUTER radius is:",
   cs:["x","x²","√x","x−√x"],a:2},

  {t:"Washer",
   q:"The region between y=x² and y=2x is rotated about the x-axis. Find the volume.",
   cs:["64π/15","32π/3","64π/3","16π/5"],a:2},

  {t:"Washer",
   q:"When using the washer method, the volume formula is:",
   cs:["π∫(outer)² dx","π∫[(outer)²−(inner)²]dx","π∫[(outer)−(inner)]² dx","2π∫r·h dx"],a:1},

  // ── ROTATION ABOUT OTHER AXES ────────────────────────────────
  {t:"Other Axes",
   q:"The region bounded by y=x² and y=4 is rotated about y=4. The radius of a typical disk is:",
   cs:["x²","4−x²","x²−4","4+x²"],a:1},

  {t:"Other Axes",
   q:"The region bounded by y=x and y=x² is rotated about y=−1. The OUTER radius is:",
   cs:["x−1","x+1","x²+1","x−x²"],a:1},

  {t:"Other Axes",
   q:"The region bounded by y=x² and x=y² is rotated about the x-axis. The intersections occur at:",
   cs:["x=0 and x=2","x=0 and x=1","x=1 and x=2","x=0 and x=4"],a:1},
];

const LINES=[
  "Mr. Tareen screams: That's a perfect solid of revolution! 😱",
  "The volume of that play = INFINITE! 🔥",
  "Mr. Tareen spills his coffee — disk method style! ☕",
  "Rotate that around the x-axis — GOAL! ✨",
  "π·r²·h of amazing right there! 📈",
  "Mr. Tareen stands up — washer method wins! 🪑",
  "The cross-section of that shot = circle! 📊",
  "Integrate that! Mr. Tareen is impressed! 💪",
];

function rCast(room, obj) { safeSend(room.p1, obj); safeSend(room.p2, obj); }

function makeRS(p1, p2) {
  const pu=[];
  for(let i=0;i<3;i++) pu.push({
    id:i,
    x:150+Math.random()*(FW-300),
    y:60+Math.random()*(FH-120),
    active:true
  });
  return {
    players:[
      {id:p1.id,name:p1.rName,color:p1.rColor,x:180,y:FH/2,angle:0,vx:0,vy:0,boost:100,speed:0},
      {id:p2.id,name:p2.rName,color:p2.rColor,x:FW-180,y:FH/2,angle:Math.PI,vx:0,vy:0,boost:100,speed:0}
    ],
    // Ball is tracked server-side ONLY for goal detection
    ball:{x:FW/2,y:FH/2,vx:0,vy:0},
    pu, p1score:0, p2score:0, timeLeft:MT, usedQ:new Set()
  };
}

function resetBall(s, scoringTeam){
  // Kick off toward the team that just conceded (to give them a chance)
  const dir = scoringTeam===1 ? -1 : 1; // if P1 scored, kick toward P1's side
  const angle = (Math.random()*0.6)-0.3; // slight random angle
  s.ball = {
    x: FW/2, y: FH/2,
    vx: Math.cos(angle) * dir * 200,
    vy: Math.sin(angle) * 120
  };
}

function pickQ(s){
  let av=RQS.map((_,i)=>i).filter(i=>!s.usedQ.has(i));
  if(!av.length){s.usedQ=new Set();av=RQS.map((_,i)=>i);}
  const i=av[Math.floor(Math.random()*av.length)];
  s.usedQ.add(i); return RQS[i];
}

function startLoop(code){
  const r=rrooms[code]; if(!r) return;
  if(r.interval) clearInterval(r.interval);
  r.goalCooldown=0; // on the room so handleRocket can check it
  let tick=0;

  r.interval=setInterval(()=>{
    const rm=rrooms[code]; if(!rm||!rm.state) return;
    const s=rm.state;
    s.timeLeft=Math.max(0,s.timeLeft-0.1);
    const ball=s.ball;
    const gt=(FH-GH)/2, gb=(FH+GH)/2;

    // Goal cooldown — ignore ball position for 30 ticks (3s) after a goal
    if(rm.goalCooldown>0){ rm.goalCooldown--; }
    else {
      // Client sends ballX=-1 or ballX=FW+1 as goal signals
      // Also catch any ball that somehow makes it past the wall
      const isLeftGoal  = (ball.x <= 0 || ball.x-BR <= GW) && ball.y>gt && ball.y<gb;
      const isRightGoal = (ball.x >= FW || ball.x+BR >= FW-GW) && ball.y>gt && ball.y<gb;

      if(isLeftGoal){
        s.p2score++;
        rm.goalCooldown=30;
        s.ball={x:FW/2,y:FH/2,vx:0,vy:0};
        rCast(rm,{type:'rocket_goal',
          scorer:s.players[1].name, scorerColor:s.players[1].color,
          p1score:s.p1score, p2score:s.p2score,
          ballX:FW/2, ballY:FH/2, ballVx:0, ballVy:0});
        console.log(`[ROCKET ${code}] GOAL! ${s.players[1].name} scores! ${s.p1score}-${s.p2score}`);
      }
      else if(isRightGoal){
        s.p1score++;
        rm.goalCooldown=30;
        s.ball={x:FW/2,y:FH/2,vx:0,vy:0};
        rCast(rm,{type:'rocket_goal',
          scorer:s.players[0].name, scorerColor:s.players[0].color,
          p1score:s.p1score, p2score:s.p2score,
          ballX:FW/2, ballY:FH/2, ballVx:0, ballVy:0});
        console.log(`[ROCKET ${code}] GOAL! ${s.players[0].name} scores! ${s.p1score}-${s.p2score}`);
      }
    }

    // Powerups
    s.pu.forEach(p=>{
      if(!p.active) return;
      s.players.forEach((car,pi)=>{
        const dx=car.x-p.x,dy=car.y-p.y;
        if(Math.sqrt(dx*dx+dy*dy)<30){
          p.active=false;
          const q=pickQ(s);
          const tw=pi===0?rm.p1:rm.p2;
          safeSend(tw,{type:'rocket_powerup',question:q});
          setTimeout(()=>{if(rrooms[code])p.active=true;},10000);
        }
      });
    });

    tick++;
    if(tick%250===0) rCast(rm,{type:'rocket_commentary',text:LINES[Math.floor(Math.random()*LINES.length)]});

    if(tick%3===0){
      // NOTE: We do NOT broadcast ball position — ball physics run entirely
      // client-side to avoid rubber-banding. P1 sends ball pos to server
      // only for goal detection. We only sync player positions + scores.
      rCast(rm,{type:'rocket_state',state:{
        players:s.players.map(p=>({
          id:p.id,name:p.name,color:p.color,
          x:p.x,y:p.y,angle:p.angle,
          vx:p.vx,vy:p.vy,boost:p.boost,speed:p.speed||0
        })),
        // Only send powerup state + scores + time — NO ball
        powerups:s.pu.map(p=>({id:p.id,x:p.x,y:p.y,active:p.active})),
        p1score:s.p1score,p2score:s.p2score,timeLeft:s.timeLeft
      }});
    }

    if(s.timeLeft<=0){
      clearInterval(rm.interval);
      rCast(rm,{type:'rocket_end',p1score:s.p1score,p2score:s.p2score,
        p1name:s.players[0].name,p2name:s.players[1].name,
        p1color:s.players[0].color,p2color:s.players[1].color});
      setTimeout(()=>delete rrooms[code],30000);
      console.log(`[ROCKET ${code}] Game over ${s.p1score}-${s.p2score}`);
    }
  },100);
}

function handleRocket(ws, msg){
  switch(msg.type){
    case 'rocket_join': {
      const code=(msg.code||'').toUpperCase().trim();
      if(!code){safeSend(ws,{type:'error',msg:'No room code!'});return;}
      ws.rName=(msg.name||'Racer').slice(0,14);
      ws.rColor=msg.color||'#ff6a00';
      ws.rCode=code;

      if(!rrooms[code]){
        rrooms[code]={p1:ws,p2:null,state:null,interval:null};
        ws.rNum=1;
        safeSend(ws,{type:'rocket_joined',id:ws.id,playerNum:1});
        safeSend(ws,{type:'rocket_waiting',msg:'Waiting for opponent…'});
        console.log(`[ROCKET ${code}] P1 waiting: ${ws.rName}`);
      } else if(!rrooms[code].p2){
        const rm=rrooms[code];
        rm.p2=ws; ws.rNum=2;
        safeSend(ws,{type:'rocket_joined',id:ws.id,playerNum:2});
        rm.state=makeRS(rm.p1,rm.p2);
        const sp={type:'rocket_start',state:{
          players:rm.state.players,ball:rm.state.ball,
          powerups:rm.state.pu,p1score:0,p2score:0,timeLeft:MT
        }};
        rCast(rm,sp);
        setTimeout(()=>startLoop(code),500);
        console.log(`[ROCKET ${code}] MATCH: ${rm.p1.rName} vs ${ws.rName}`);
      } else {
        safeSend(ws,{type:'error',msg:'Room full! Try a different code.'});
      }
      break;
    }
    case 'rocket_input': {
      const rm=rrooms[ws.rCode]; if(!rm||!rm.state) return;
      const s=rm.state, idx=ws.rNum===1?0:1;
      if(typeof msg.x==='number'){
        s.players[idx].x=msg.x; s.players[idx].y=msg.y;
        s.players[idx].angle=msg.angle;
        s.players[idx].vx=msg.vx; s.players[idx].vy=msg.vy;
        s.players[idx].boost=msg.boost;
      }
      if(ws.rNum===1&&typeof msg.ballX==='number'&&!(rm.goalCooldown>0)){
        s.ball.x=msg.ballX; s.ball.y=msg.ballY;
        s.ball.vx=msg.ballVx; s.ball.vy=msg.ballVy;
      }
      break;
    }
    case 'rocket_quiz_answer': {
      const rm=rrooms[ws.rCode]; if(!rm||!rm.state) return;
      const s=rm.state, idx=ws.rNum===1?0:1, other=1-idx;
      const otherWs=idx===0?rm.p2:rm.p1;
      if(msg.correct){
        // Give winner FULL boost
        s.players[idx].boost=100;
        safeSend(ws,{type:'rocket_boost',granted:true,amount:100});
        safeSend(otherWs,{type:'rocket_boost',granted:false,amount:0});
      } else {
        // Give opponent significant boost as penalty
        s.players[other].boost=Math.min(100,s.players[other].boost+60);
        safeSend(ws,{type:'rocket_boost',granted:false,amount:0});
        safeSend(otherWs,{type:'rocket_boost',granted:true,amount:60});
      }
      break;
    }
  }
}

// ════════════════════════════════════════════
// MAIN ROUTER
// ════════════════════════════════════════════
wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).slice(2,10);

  ws.on('message', (raw) => {
    let msg;
    try { msg=JSON.parse(raw); } catch { return; }
    if(!msg||!msg.type) return;
    if(msg.type.startsWith('rocket_')) handleRocket(ws,msg);
    else handleCQ(ws,msg);
  });

  ws.on('close', () => {
    // CQ cleanup
    if(ws.cqCode && rooms[ws.cqCode]){
      const room=rooms[ws.cqCode];
      if(ws.cqRole==='host'){
        cqCast(room,{type:'host_disconnected'});
        delete rooms[ws.cqCode];
      } else {
        room.students.delete(ws.id);
        if(room.state&&room.state.players)
          room.state.players=room.state.players.filter(p=>p.id!==ws.id);
        cqCast(room,{type:'player_left',id:ws.id});
        if(room.host) safeSend(room.host,{type:'lobby_update',players:lobbyList(room)});
      }
    }
    // Rocket cleanup
    if(ws.rCode && rrooms[ws.rCode]){
      const rm=rrooms[ws.rCode];
      if(rm.interval) clearInterval(rm.interval);
      const other=ws.rNum===1?rm.p2:rm.p1;
      if(other) safeSend(other,{type:'error',msg:'Opponent disconnected!'});
      delete rrooms[ws.rCode];
      console.log(`[ROCKET ${ws.rCode}] Closed on disconnect`);
    }
  });
});

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   MR. TAREEN\'S SERVER — Ready!           ║');
  console.log(`  ║   Port: ${String(PORT).padEnd(32)}║`);
  console.log('  ║   Calculus Quest + Rocket Calc active    ║');
  console.log('  ╚══════════════════════════════════════════╝');
  if(process.env.RAILWAY_PUBLIC_DOMAIN){
    const u=`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    console.log(`  🎮 Calc Quest: ${u}/host.html`);
    console.log(`  🚀 Rocket:     ${u}/rocket.html`);
  }
  console.log('');
});
