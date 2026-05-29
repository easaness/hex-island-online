const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const RESOURCES = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
const RESOURCE_LABELS = { wood: '木', brick: '土', wheat: '麦', sheep: '羊', ore: '石' };
const PLAYER_COLORS = ['#2563eb', '#e11d48', '#16a34a', '#9333ea'];
const PLAYER_LIGHT = ['#dbeafe', '#ffe4e6', '#dcfce7', '#f3e8ff'];
const COSTS = {
  settlement: { wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 0 },
  city: { wood: 0, brick: 0, wheat: 2, sheep: 0, ore: 3 },
  road: { wood: 1, brick: 1, wheat: 0, sheep: 0, ore: 0 }
};

const rooms = new Map();

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do {
    id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(id));
  return id;
}

function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createBoard() {
  const coords = [];
  const radius = 2;
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) coords.push({ q, r });
  }
  const resources = shuffle([
    'wood', 'wood', 'wood', 'wood',
    'brick', 'brick', 'brick',
    'wheat', 'wheat', 'wheat', 'wheat',
    'sheep', 'sheep', 'sheep', 'sheep',
    'ore', 'ore', 'ore',
    'desert'
  ]);
  const numbers = shuffle([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
  let numberIndex = 0;
  return coords.map((coord, index) => {
    const resource = resources[index];
    return {
      id: `t${index}`,
      ...coord,
      resource,
      number: resource === 'desert' ? null : numbers[numberIndex++],
      owner: null,
      city: false
    };
  });
}

function publicRoom(room) {
  return {
    id: room.id,
    maxPlayers: room.maxPlayers,
    hostToken: room.hostToken,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      light: p.light,
      connected: p.connected,
      victoryPoints: victoryPoints(room, p.id),
      resources: p.resources
    })),
    started: room.started,
    gameOver: room.gameOver,
    currentPlayerIndex: room.currentPlayerIndex,
    board: room.board,
    roads: room.roads,
    dice: room.dice,
    phase: room.phase,
    winnerIds: room.winnerIds,
    log: room.log.slice(-16)
  };
}

function getPlayer(room, token) {
  return room.players.find(p => p.token === token);
}

function victoryPoints(room, playerId) {
  const buildings = room.board.reduce((sum, tile) => {
    if (tile.owner !== playerId) return sum;
    return sum + (tile.city ? 2 : 1);
  }, 0);
  return buildings;
}

function canAfford(player, cost) {
  return RESOURCES.every(res => (player.resources[res] || 0) >= (cost[res] || 0));
}

function pay(player, cost) {
  RESOURCES.forEach(res => player.resources[res] -= cost[res] || 0);
}

function gain(player, resource, amount) {
  if (resource && resource !== 'desert') player.resources[resource] += amount;
}

function roomLog(room, text) {
  room.log.push({ text, time: Date.now() });
  room.log = room.log.slice(-30);
}

function currentPlayer(room) {
  return room.players[room.currentPlayerIndex];
}

function emitRoom(room) {
  io.to(room.id).emit('roomState', publicRoom(room));
}

function checkWin(room) {
  const scores = room.players.map(p => ({ id: p.id, score: victoryPoints(room, p.id) }));
  const max = Math.max(...scores.map(s => s.score));
  if (max >= 10) {
    room.gameOver = true;
    room.winnerIds = scores.filter(s => s.score === max).map(s => s.id);
    const names = room.players.filter(p => room.winnerIds.includes(p.id)).map(p => p.name).join('・');
    roomLog(room, `${names} が10点に到達しました！`);
  }
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, maxPlayers }, cb) => {
    const id = makeRoomId();
    const token = makeToken();
    const player = {
      id: 1,
      token,
      name: (name || 'プレイヤー1').trim().slice(0, 16),
      color: PLAYER_COLORS[0],
      light: PLAYER_LIGHT[0],
      connected: true,
      resources: { wood: 2, brick: 2, wheat: 2, sheep: 2, ore: 2 }
    };
    const room = {
      id,
      maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)),
      hostToken: token,
      players: [player],
      started: false,
      gameOver: false,
      currentPlayerIndex: 0,
      board: createBoard(),
      roads: [],
      dice: null,
      phase: 'waiting',
      winnerIds: [],
      log: []
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    socket.data.token = token;
    roomLog(room, `${player.name} が部屋を作りました。`);
    cb?.({ ok: true, roomId: id, token, playerId: 1, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = rooms.get(String(roomId || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。' });
    if (room.started) return cb?.({ ok: false, message: 'この部屋はすでに開始しています。' });
    if (room.players.length >= room.maxPlayers) return cb?.({ ok: false, message: 'この部屋は満員です。' });
    const id = room.players.length + 1;
    const token = makeToken();
    const player = {
      id,
      token,
      name: (name || `プレイヤー${id}`).trim().slice(0, 16),
      color: PLAYER_COLORS[id - 1],
      light: PLAYER_LIGHT[id - 1],
      connected: true,
      resources: { wood: 2, brick: 2, wheat: 2, sheep: 2, ore: 2 }
    };
    room.players.push(player);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.token = token;
    roomLog(room, `${player.name} が入室しました。`);
    cb?.({ ok: true, roomId: room.id, token, playerId: id, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on('reconnectPlayer', ({ roomId, token }, cb) => {
    const room = rooms.get(String(roomId || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。' });
    const player = getPlayer(room, token);
    if (!player) return cb?.({ ok: false, message: '再接続情報が一致しません。' });
    player.connected = true;
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.token = token;
    roomLog(room, `${player.name} が再接続しました。`);
    cb?.({ ok: true, roomId: room.id, token, playerId: player.id, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on('startGame', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, message: '部屋がありません。' });
    if (room.hostToken !== token) return cb?.({ ok: false, message: '部屋主だけが開始できます。' });
    if (room.players.length < 2) return cb?.({ ok: false, message: '2人以上で開始できます。' });
    room.started = true;
    room.gameOver = false;
    room.currentPlayerIndex = 0;
    room.dice = null;
    room.phase = 'roll';
    roomLog(room, 'ゲーム開始！最初のプレイヤーはサイコロを振ってください。');
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('rename', ({ roomId, token, name }, cb) => {
    const room = rooms.get(roomId);
    const player = room && getPlayer(room, token);
    if (!player) return cb?.({ ok: false, message: 'プレイヤーが見つかりません。' });
    const old = player.name;
    player.name = (name || player.name).trim().slice(0, 16);
    roomLog(room, `${old} は ${player.name} に名前を変えました。`);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('rollDice', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId);
    const player = room && getPlayer(room, token);
    if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (!room.started || room.gameOver) return cb?.({ ok: false, message: 'ゲーム中ではありません。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (room.phase !== 'roll') return cb?.({ ok: false, message: 'このターンはすでにサイコロを振りました。' });
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const sum = d1 + d2;
    room.dice = { d1, d2, sum };
    const gains = [];
    room.board.forEach(tile => {
      if (tile.number === sum && tile.owner) {
        const owner = room.players.find(p => p.id === tile.owner);
        if (owner) {
          const amount = tile.city ? 2 : 1;
          gain(owner, tile.resource, amount);
          gains.push(`${owner.name}+${RESOURCE_LABELS[tile.resource]}${amount}`);
        }
      }
    });
    room.phase = 'action';
    roomLog(room, `${player.name} が ${d1}+${d2}=${sum} を出しました。${gains.length ? gains.join('、') : '資源獲得なし。'}`);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('buildSettlement', ({ roomId, token, tileId }, cb) => {
    const room = rooms.get(roomId);
    const player = room && getPlayer(room, token);
    if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.gameOver) return cb?.({ ok: false, message: 'ゲームは終了しています。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    const tile = room.board.find(t => t.id === tileId);
    if (!tile) return cb?.({ ok: false, message: '土地が見つかりません。' });
    if (tile.owner) return cb?.({ ok: false, message: 'この土地にはすでに拠点があります。' });
    if (tile.resource === 'desert') return cb?.({ ok: false, message: '砂漠には拠点を作れません。' });
    if (!canAfford(player, COSTS.settlement)) return cb?.({ ok: false, message: '資源が足りません。拠点には 木・土・麦・羊 が1つずつ必要です。' });
    pay(player, COSTS.settlement);
    tile.owner = player.id;
    tile.city = false;
    roomLog(room, `${player.name} が ${RESOURCE_LABELS[tile.resource]} の土地に拠点を作りました。`);
    checkWin(room);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('upgradeCity', ({ roomId, token, tileId }, cb) => {
    const room = rooms.get(roomId);
    const player = room && getPlayer(room, token);
    if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.gameOver) return cb?.({ ok: false, message: 'ゲームは終了しています。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    const tile = room.board.find(t => t.id === tileId);
    if (!tile || tile.owner !== player.id) return cb?.({ ok: false, message: '自分の拠点を選んでください。' });
    if (tile.city) return cb?.({ ok: false, message: 'すでに都市です。' });
    if (!canAfford(player, COSTS.city)) return cb?.({ ok: false, message: '資源が足りません。都市化には 麦2・石3 が必要です。' });
    pay(player, COSTS.city);
    tile.city = true;
    roomLog(room, `${player.name} が拠点を都市にしました。`);
    checkWin(room);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('buildRoad', ({ roomId, token, edgeKey }, cb) => {
    const room = rooms.get(roomId);
    const player = room && getPlayer(room, token);
    if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.gameOver) return cb?.({ ok: false, message: 'ゲームは終了しています。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (room.roads.find(r => r.edgeKey === edgeKey)) return cb?.({ ok: false, message: 'ここにはすでに道があります。' });
    if (!canAfford(player, COSTS.road)) return cb?.({ ok: false, message: '資源が足りません。道には 木・土 が1つずつ必要です。' });
    pay(player, COSTS.road);
    room.roads.push({ edgeKey, owner: player.id });
    roomLog(room, `${player.name} が道を作りました。`);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('bankTrade', ({ roomId, token, give, receive }, cb) => {
    const room = rooms.get(roomId);
    const player = room && getPlayer(room, token);
    if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (!RESOURCES.includes(give) || !RESOURCES.includes(receive) || give === receive) return cb?.({ ok: false, message: '交換内容が正しくありません。' });
    if ((player.resources[give] || 0) < 4) return cb?.({ ok: false, message: `${RESOURCE_LABELS[give]}が4つ必要です。` });
    player.resources[give] -= 4;
    player.resources[receive] += 1;
    roomLog(room, `${player.name} が銀行交換：${RESOURCE_LABELS[give]}4 → ${RESOURCE_LABELS[receive]}1`);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('endTurn', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (room.gameOver) return cb?.({ ok: false, message: 'ゲームは終了しています。' });
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
    room.dice = null;
    room.phase = 'roll';
    roomLog(room, `${currentPlayer(room).name} の番です。`);
    cb?.({ ok: true });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const player = getPlayer(room, socket.data.token);
    if (player) {
      player.connected = false;
      roomLog(room, `${player.name} が切断しました。`);
      emitRoom(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hex Island server running on port ${PORT}`);
});
