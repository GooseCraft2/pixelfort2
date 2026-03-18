const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════
//  ROOMS
// ════════════════════════════════
const rooms = {}; // roomId -> room

function makeId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function getRoomList() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    players: Object.keys(r.players).length,
    max: 4,
    hasPassword: !!r.password,
    state: r.state, // 'lobby' | 'playing' | 'ended'
  }));
}

function broadcastRoomList() {
  io.emit('room_list', getRoomList());
}

// ════════════════════════════════
//  GAME CONSTANTS
// ════════════════════════════════
const DOOR_HP_MULT  = [1,2,3.5,5,7,10,14,19,25,35];
const DOOR_UPGR_COST = [80,150,280,500,900,1500,2500,4000,7000,12000];
const BED_CPS   = [2,4,7,12,20,35,60];
const BED_COST  = [50,100,200,400,800,1500,3000];
const TURRET_LEVELS = [
  {name:'Рогатка', dmg:5,  rate:2.0, range:80, cost:60},
  {name:'Пистолет',dmg:12, rate:1.2, range:100,cost:120},
  {name:'Пулемёт', dmg:18, rate:0.4, range:100,cost:250},
  {name:'Пушка',   dmg:45, rate:1.8, range:120,cost:500},
  {name:'Лазер',   dmg:80, rate:0.3, range:140,cost:1000},
  {name:'Плазма',  dmg:200,rate:0.25,range:160,cost:2000},
];

// ════════════════════════════════
//  GAME STATE PER ROOM
// ════════════════════════════════
function makePlayerState() {
  return {
    coins: 30,
    cps: 2,
    bedLevel: 1,
    doorLevel: 0,
    doorHp: 100,
    doorMaxHp: 100,
    turrets: [],
    repairCooldown: 0,
    isRepairing: false,
    repairProgress: 0,
    wallBuff: 0,
    ready: false,
    kills: 0,
    alive: true,
  };
}

function makeRoomGame(room) {
  return {
    enemies: [],
    bullets: [],
    wave: 0,
    waveActive: false,
    enemiesLeft: 0,
    spawnTimer: 0,
    nextWaveTimer: 3,
    coinAccum: {}, // playerId -> float
    buffs: {},     // playerId -> {name: seconds}
  };
}

// ════════════════════════════════
//  GAME LOOP (server-side tick)
// ════════════════════════════════
const TICK = 1/20; // 20 ticks/sec
const PATH = buildPath();

function buildPath() {
  const GW = 40, GH = 30, CS = 20;
  const midY = Math.floor(GH / 2);
  let path = [];
  for (let x = 0; x <= Math.floor(GW*0.45); x++) path.push({x, y: midY});
  for (let y = midY; y >= Math.floor(GH*0.25); y--) path.push({x:Math.floor(GW*0.45), y});
  for (let x = Math.floor(GW*0.45); x <= Math.floor(GW*0.65); x++) path.push({x, y:Math.floor(GH*0.25)});
  for (let y = Math.floor(GH*0.25); y <= Math.floor(GH*0.75); y++) path.push({x:Math.floor(GW*0.65), y});
  for (let x = Math.floor(GW*0.65); x <= GW-4; x++) path.push({x, y:Math.floor(GH*0.75)});
  const seen = new Set();
  return path.filter(p => { const k=`${p.x},${p.y}`; if(seen.has(k))return false; seen.add(k); return true; });
}

function tickRoom(room) {
  if (room.state !== 'playing') return;
  const g = room.game;
  const dt = TICK;

  // Coins for each alive player
  for (const pid of Object.keys(room.players)) {
    const ps = room.players[pid];
    if (!ps.alive) continue;
    if (!g.coinAccum[pid]) g.coinAccum[pid] = 0;
    const multi = (g.buffs[pid] && g.buffs[pid].doubleCoins > 0) ? 2 : 1;
    g.coinAccum[pid] += ps.cps * multi * dt;
    if (g.coinAccum[pid] >= 1) {
      ps.coins += Math.floor(g.coinAccum[pid]);
      g.coinAccum[pid] -= Math.floor(g.coinAccum[pid]);
    }
  }

  // Buff timers
  for (const pid in g.buffs) {
    for (const k in g.buffs[pid]) {
      g.buffs[pid][k] -= dt;
      if (g.buffs[pid][k] <= 0) delete g.buffs[pid][k];
    }
  }

  // Repair per player
  for (const pid of Object.keys(room.players)) {
    const ps = room.players[pid];
    if (!ps.alive) continue;
    if (ps.repairCooldown > 0) ps.repairCooldown -= dt;
    if (ps.isRepairing) {
      ps.repairProgress += dt / 10;
      if (ps.repairProgress >= 1) {
        ps.doorHp = Math.min(ps.doorMaxHp, ps.doorHp + ps.doorMaxHp * 0.5);
        ps.isRepairing = false;
        ps.repairProgress = 0;
        io.to(pid).emit('toast', {msg:'🔧 Дверь починена!', type:''});
      }
    }
  }

  // Wave timer
  if (!g.waveActive) {
    g.nextWaveTimer -= dt;
    if (g.nextWaveTimer <= 0) {
      startWave(room);
    }
    return;
  }

  // Spawn
  if (g.enemiesLeft > 0) {
    g.spawnTimer -= dt;
    if (g.spawnTimer <= 0) {
      spawnEnemy(room);
      g.enemiesLeft--;
      g.spawnTimer = Math.max(0.3, 1.2 - g.wave * 0.05);
    }
  }

  // Move enemies
  const CS = 20;
  for (let i = g.enemies.length - 1; i >= 0; i--) {
    const en = g.enemies[i];
    if (en.frozen > 0) { en.frozen -= dt; continue; }

    let dist = en.speed * CS * dt;
    while (dist > 0 && en.pathIdx < PATH.length - 1) {
      const target = PATH[en.pathIdx + 1];
      const tx = target.x * CS + CS/2, ty = target.y * CS + CS/2;
      const dx = tx - en.x, dy = ty - en.y;
      const d = Math.sqrt(dx*dx + dy*dy);
      if (d <= dist) { en.x = tx; en.y = ty; en.pathIdx++; dist -= d; }
      else { en.x += dx/d*dist; en.y += dy/d*dist; dist = 0; }
    }

    // Reached end -> attack the target player's door
    if (en.pathIdx >= PATH.length - 1) {
      const ps = room.players[en.targetPlayer];
      if (ps && ps.alive && !(ps.wallBuff > 0)) {
        ps.doorHp -= en.speed * 30 * dt;
        if (ps.doorHp <= 0) {
          ps.doorHp = 0;
          ps.alive = false;
          io.to(en.targetPlayer).emit('toast', {msg:'☠ Дверь сломана! Ты выбыл.', type:'warn'});
          // check if all dead
          const allDead = Object.values(room.players).every(p => !p.alive);
          if (allDead) { endGame(room); return; }
        }
      }
      g.enemies.splice(i, 1);
      continue;
    }
  }

  // Turrets shoot
  for (const pid of Object.keys(room.players)) {
    const ps = room.players[pid];
    if (!ps.alive) continue;
    const dmgMult = (g.buffs[pid] && g.buffs[pid].godMode > 0) ? 10 : 1;
    for (const t of ps.turrets) {
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const lvl = TURRET_LEVELS[t.level];
      let best = null, bestDist = lvl.range;
      for (const en of g.enemies) {
        if (en.targetPlayer !== pid) continue;
        const dx = en.x - t.x, dy = en.y - t.y;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d < bestDist) { best = en; bestDist = d; }
      }
      if (best) {
        t.cooldown = lvl.rate;
        best.hp -= lvl.dmg * dmgMult;
        if (best.hp <= 0) {
          ps.kills++;
          ps.coins += 5 + best.tier * 3;
          g.enemies.splice(g.enemies.indexOf(best), 1);
        }
      }
    }
  }

  // Wave done?
  if (g.waveActive && g.enemiesLeft <= 0 && g.enemies.length === 0) {
    g.waveActive = false;
    g.nextWaveTimer = 4;
    const bonus = g.wave * 10;
    for (const pid of Object.keys(room.players)) {
      const ps = room.players[pid];
      if (ps.alive) {
        ps.coins += bonus;
        io.to(pid).emit('toast', {msg:`✓ Волна ${g.wave} пройдена! +${bonus} монет`, type:'gold'});
      }
    }
  }

  // Wall buff timer per player
  for (const pid of Object.keys(room.players)) {
    const ps = room.players[pid];
    if (ps.wallBuff > 0) ps.wallBuff -= dt;
  }

  // Broadcast state
  broadcastGameState(room);
}

function startWave(room) {
  const g = room.game;
  g.wave++;
  const count = 3 + g.wave * 2 + (g.wave > 5 ? g.wave : 0);
  g.enemiesLeft = count;
  g.waveActive = true;
  g.spawnTimer = 0;
  io.to(room.id).emit('wave_start', {wave: g.wave});
}

function spawnEnemy(room) {
  const g = room.game;
  const CS = 20;
  const alivePlayers = Object.keys(room.players).filter(pid => room.players[pid].alive);
  if (alivePlayers.length === 0) return;
  const targetPlayer = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];

  const tier = Math.max(0, Math.floor((g.wave - 1) / 3));
  const isLast = (g.enemiesLeft === 0 && g.wave > 3);
  const hp = isLast
    ? (50 + g.wave * 30) * Math.pow(1.4, tier) * 3
    : (20 + g.wave * 10) * Math.pow(1.3, tier);

  g.enemies.push({
    id: Math.random().toString(36).substr(2,8),
    pathIdx: 0,
    x: PATH[0].x * CS + CS/2,
    y: PATH[0].y * CS + CS/2,
    hp, maxHp: hp,
    speed: 0.8 + tier * 0.15 + Math.random() * 0.2,
    tier, isLast,
    frozen: 0,
    targetPlayer,
  });
}

function broadcastGameState(room) {
  const state = {
    players: {},
    enemies: room.game.enemies.map(e => ({
      id:e.id, x:e.x, y:e.y, hp:e.hp, maxHp:e.maxHp,
      tier:e.tier, isLast:e.isLast, frozen:e.frozen>0, targetPlayer:e.targetPlayer
    })),
    wave: room.game.wave,
    waveActive: room.game.waveActive,
    nextWaveIn: room.game.nextWaveTimer,
  };
  for (const pid in room.players) {
    const ps = room.players[pid];
    state.players[pid] = {
      coins: ps.coins, cps: ps.cps, bedLevel: ps.bedLevel,
      doorLevel: ps.doorLevel, doorHp: ps.doorHp, doorMaxHp: ps.doorMaxHp,
      turrets: ps.turrets, kills: ps.kills, alive: ps.alive,
      isRepairing: ps.isRepairing, repairProgress: ps.repairProgress,
      repairCooldown: ps.repairCooldown, wallBuff: ps.wallBuff,
      name: ps.name,
    };
  }
  io.to(room.id).emit('game_state', state);
}

function endGame(room) {
  room.state = 'ended';
  if (room.interval) { clearInterval(room.interval); room.interval = null; }
  const stats = {};
  for (const pid in room.players) {
    stats[pid] = { kills: room.players[pid].kills, name: room.players[pid].name };
  }
  io.to(room.id).emit('game_over', { wave: room.game.wave, stats });
  broadcastRoomList();
}

// ════════════════════════════════
//  SOCKET HANDLERS
// ════════════════════════════════
io.on('connection', (socket) => {
  console.log('connect', socket.id);

  socket.emit('room_list', getRoomList());

  // Create room
  socket.on('create_room', ({ name, password, playerName }) => {
    const id = makeId();
    const room = {
      id, name: name || 'Комната', password: password || '',
      state: 'lobby',
      players: {},
      game: null,
      interval: null,
      admin: socket.id,
    };
    room.players[socket.id] = { ...makePlayerState(), name: playerName || 'Игрок' };
    rooms[id] = room;
    socket.join(id);
    socket.emit('joined_room', {
      roomId: id, playerId: socket.id,
      isAdmin: true,
      players: getPlayersInfo(room),
    });
    broadcastRoomList();
  });

  // Join room
  socket.on('join_room', ({ roomId, password, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', 'Комната не найдена');
    if (room.state !== 'lobby') return socket.emit('error', 'Игра уже идёт');
    if (Object.keys(room.players).length >= 4) return socket.emit('error', 'Комната полна');
    if (room.password && room.password !== password) return socket.emit('error', 'Неверный пароль');

    room.players[socket.id] = { ...makePlayerState(), name: playerName || 'Игрок' };
    socket.join(roomId);
    socket.emit('joined_room', {
      roomId, playerId: socket.id,
      isAdmin: room.admin === socket.id,
      players: getPlayersInfo(room),
    });
    io.to(roomId).emit('lobby_update', { players: getPlayersInfo(room) });
    broadcastRoomList();
  });

  // Ready toggle
  socket.on('set_ready', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.players[socket.id]) return;
    const ps = room.players[socket.id];
    ps.ready = !ps.ready;
    io.to(roomId).emit('lobby_update', { players: getPlayersInfo(room) });
  });

  // Start game (admin only)
  socket.on('start_game', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.admin !== socket.id) return;
    const players = Object.values(room.players);
    if (players.length < 1) return;
    // non-admin players must be ready (skip if solo)
    const nonAdmin = players.filter(p => p !== room.players[room.admin]);
    if (nonAdmin.length > 0 && !nonAdmin.every(p => p.ready)) {
      return socket.emit('error', 'Не все игроки готовы!');
    }
    room.state = 'playing';
    room.game = makeRoomGame(room);
    room.game.coinAccum = {};
    for (const pid of Object.keys(room.players)) room.game.coinAccum[pid] = 0;
    io.to(roomId).emit('game_started', { path: PATH });
    room.interval = setInterval(() => tickRoom(room), TICK * 1000);
    broadcastRoomList();
  });

  // ── GAME ACTIONS ──

  socket.on('upgrade_bed', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const ps = room.players[socket.id];
    if (!ps || !ps.alive || ps.bedLevel >= BED_CPS.length) return;
    const cost = BED_COST[ps.bedLevel - 1];
    if (ps.coins < cost) return;
    ps.coins -= cost;
    ps.bedLevel++;
    ps.cps = BED_CPS[ps.bedLevel - 1];
  });

  socket.on('upgrade_door', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const ps = room.players[socket.id];
    if (!ps || !ps.alive || ps.doorLevel + 1 >= 10) return;
    const cost = DOOR_UPGR_COST[ps.doorLevel];
    if (ps.coins < cost) return;
    ps.coins -= cost;
    ps.doorLevel++;
    ps.doorMaxHp = 100 * DOOR_HP_MULT[ps.doorLevel];
    ps.doorHp = ps.doorMaxHp;
  });

  socket.on('place_turret', ({ roomId, cx, cy }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const ps = room.players[socket.id];
    if (!ps || !ps.alive) return;
    const cost = TURRET_LEVELS[0].cost;
    if (ps.coins < cost) return;
    const CS = 20;
    // validate not on path
    const onPath = PATH.some(p => p.x === cx && p.y === cy);
    if (onPath) return;
    const onBase = cx >= 40 - 4;
    if (onBase) return;
    const occupied = ps.turrets.some(t => t.cx === cx && t.cy === cy);
    if (occupied) return;
    ps.coins -= cost;
    ps.turrets.push({ cx, cy, x: cx*CS+CS/2, y: cy*CS+CS/2, level: 0, cooldown: 0 });
  });

  socket.on('upgrade_turret', ({ roomId, cx, cy }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const ps = room.players[socket.id];
    if (!ps || !ps.alive) return;
    const t = ps.turrets.find(t => t.cx === cx && t.cy === cy);
    if (!t || t.level >= TURRET_LEVELS.length - 1) return;
    const cost = TURRET_LEVELS[t.level + 1].cost;
    if (ps.coins < cost) return;
    ps.coins -= cost;
    t.level++;
  });

  socket.on('repair_door', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const ps = room.players[socket.id];
    if (!ps || !ps.alive || ps.isRepairing || ps.repairCooldown > 0) return;
    ps.isRepairing = true;
    ps.repairProgress = 0;
    ps.repairCooldown = 15;
  });

  socket.on('use_buff', ({ roomId, buffId }) => {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return;
    const g = room.game;
    if (!g.buffs[socket.id]) g.buffs[socket.id] = {};
    const ps = room.players[socket.id];
    if (!ps) return;

    if (buffId === 'freeze') {
      for (const en of g.enemies) if (en.targetPlayer === socket.id) en.frozen = 8;
      io.to(socket.id).emit('toast', {msg:'❄ Заморозка!', type:''});
    } else if (buffId === 'doubleCoins') {
      g.buffs[socket.id].doubleCoins = 30;
      io.to(socket.id).emit('toast', {msg:'💰 Двойные монеты 30с!', type:'gold'});
    } else if (buffId === 'airstrike') {
      const killed = g.enemies.filter(e => e.targetPlayer === socket.id).length;
      g.enemies = g.enemies.filter(e => e.targetPlayer !== socket.id);
      ps.kills += killed; ps.coins += killed * 8;
      io.to(socket.id).emit('toast', {msg:`💥 Авиаудар! -${killed} мобов`, type:'gold'});
    } else if (buffId === 'repair_instant') {
      ps.doorHp = ps.doorMaxHp; ps.isRepairing = false; ps.repairProgress = 0;
      io.to(socket.id).emit('toast', {msg:'🔧 Мгновенный ремонт!', type:''});
    } else if (buffId === 'wall') {
      ps.wallBuff = 60;
      io.to(socket.id).emit('toast', {msg:'🛡 Стена неуязвима 60с!', type:''});
    } else if (buffId === 'goldRush') {
      ps.coins += 500;
      io.to(socket.id).emit('toast', {msg:'💰 +500 монет!', type:'gold'});
    } else if (buffId === 'godMode') {
      g.buffs[socket.id].godMode = 20;
      io.to(socket.id).emit('toast', {msg:'⚡ РЕЖИМ БОГА 20с!', type:'gold'});
    } else if (buffId === 'redirect') {
      // send random enemy of mine back to start
      const mine = g.enemies.filter(e => e.targetPlayer === socket.id);
      if (mine.length > 0) {
        const en = mine[0];
        en.pathIdx = 0;
        en.x = PATH[0].x*20+10; en.y = PATH[0].y*20+10;
        io.to(socket.id).emit('toast', {msg:'👹 Моб перенаправлен!', type:''});
      }
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const rid in rooms) {
      const room = rooms[rid];
      if (!room.players[socket.id]) continue;
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        if (room.interval) clearInterval(room.interval);
        delete rooms[rid];
      } else {
        if (room.admin === socket.id) {
          room.admin = Object.keys(room.players)[0];
          io.to(rid).emit('new_admin', { adminId: room.admin });
        }
        io.to(rid).emit('lobby_update', { players: getPlayersInfo(room) });
      }
      broadcastRoomList();
      break;
    }
  });
});

function getPlayersInfo(room) {
  return Object.entries(room.players).map(([id, ps]) => ({
    id, name: ps.name, ready: ps.ready, isAdmin: id === room.admin
  }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PixelFort server on port ${PORT}`));
