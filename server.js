const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

const RESOURCES = ['wood', 'brick', 'wheat', 'sheep', 'ore'];
const RESOURCE_LABELS = { wood: '木', brick: '土', wheat: '麦', sheep: '羊', ore: '石', desert: '砂漠' };
const RESOURCE_ICONS = { wood: '🌲', brick: '🧱', wheat: '🌾', sheep: '🐑', ore: '⛰️', desert: '🏜️' };
const PLAYER_COLORS = ['#2563eb', '#e11d48', '#16a34a', '#9333ea'];
const PLAYER_LIGHT = ['#dbeafe', '#ffe4e6', '#dcfce7', '#f3e8ff'];
const COSTS = {
  settlement: { wood: 1, brick: 1, wheat: 1, sheep: 1, ore: 0 },
  city: { wood: 0, brick: 0, wheat: 2, sheep: 0, ore: 3 },
  road: { wood: 1, brick: 1, wheat: 0, sheep: 0, ore: 0 }
};
const TARGET_POINTS = 10;
const rooms = new Map();

function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do id = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); while (rooms.has(id));
  return id;
}
function makeToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function blankResources(amount = 0) { return { wood: amount, brick: amount, wheat: amount, sheep: amount, ore: amount }; }
function canAfford(player, cost) { return RESOURCES.every(res => (player.resources[res] || 0) >= (cost[res] || 0)); }
function pay(player, cost) { RESOURCES.forEach(res => player.resources[res] -= cost[res] || 0); }
function resourceTotal(player) { return RESOURCES.reduce((s, r) => s + (player.resources[r] || 0), 0); }
function roomLog(room, text, type = 'info') { room.log.push({ text, type, time: Date.now() }); room.log = room.log.slice(-80); }
function getPlayer(room, token) { return room.players.find(p => p.token === token); }
function currentPlayer(room) { return room.players[room.currentPlayerIndex]; }
function currentSetupPlayerId(room) { return room.setupOrder[room.setupIndex]; }
function resourceText(bag) { return RESOURCES.filter(r => bag[r] > 0).map(r => `${RESOURCE_LABELS[r]}${bag[r]}`).join('・') || 'なし'; }

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
  const tiles = coords.map((coord, index) => {
    const resource = resources[index];
    return { id: `t${index}`, ...coord, resource, number: resource === 'desert' ? null : numbers[numberIndex++] };
  });
  const desert = tiles.find(t => t.resource === 'desert');
  const { nodes, edges } = createGraph(tiles);
  return { tiles, nodes, edges, robberTileId: desert ? desert.id : tiles[0].id };
}
function axialToPixel(q, r) {
  const size = 100;
  return { x: size * Math.sqrt(3) * (q + r / 2), y: size * 1.5 * r };
}
function hexVertices(q, r) {
  const center = axialToPixel(q, r);
  const size = 100;
  const vertices = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    vertices.push({ x: center.x + size * Math.cos(a), y: center.y + size * Math.sin(a) });
  }
  return vertices;
}
function keyPoint(p) { return `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`; }
function edgeKey(a, b) { return [a, b].sort().join('__'); }
function createGraph(tiles) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  tiles.forEach(tile => {
    const vertices = hexVertices(tile.q, tile.r);
    const nodeIds = vertices.map(v => {
      const k = keyPoint(v);
      if (!nodeMap.has(k)) {
        const id = `n${nodeMap.size}`;
        nodeMap.set(k, { id, x: v.x, y: v.y, owner: null, city: false, adjacentTiles: [], edges: [] });
      }
      const node = nodeMap.get(k);
      if (!node.adjacentTiles.includes(tile.id)) node.adjacentTiles.push(tile.id);
      return node.id;
    });
    for (let i = 0; i < 6; i++) {
      const n1 = nodeIds[i];
      const n2 = nodeIds[(i + 1) % 6];
      const k = edgeKey(n1, n2);
      if (!edgeMap.has(k)) edgeMap.set(k, { id: `e${edgeMap.size}`, n1, n2, owner: null, adjacentTiles: [] });
      const edge = edgeMap.get(k);
      if (!edge.adjacentTiles.includes(tile.id)) edge.adjacentTiles.push(tile.id);
    }
  });
  const nodes = Array.from(nodeMap.values());
  const edges = Array.from(edgeMap.values());
  edges.forEach(e => {
    nodes.find(n => n.id === e.n1)?.edges.push(e.id);
    nodes.find(n => n.id === e.n2)?.edges.push(e.id);
  });
  return { nodes, edges };
}
function createSetupOrder(players) {
  const ids = players.map(p => p.id);
  return ids.concat(ids.slice().reverse());
}
function calculateLongestRoad(room, playerId) {
  const playerEdges = room.edges.filter(e => e.owner === playerId);
  if (!playerEdges.length) return 0;
  const edgeById = new Map(room.edges.map(e => [e.id, e]));
  let best = 0;
  function dfs(nodeId, usedEdges) {
    best = Math.max(best, usedEdges.size);
    const node = room.nodes.find(n => n.id === nodeId);
    if (!node) return;
    // Rival building blocks passing through this intersection, but starting/ending there is okay.
    if (usedEdges.size > 0 && node.owner && node.owner !== playerId) return;
    for (const eid of node.edges) {
      const edge = edgeById.get(eid);
      if (!edge || edge.owner !== playerId || usedEdges.has(eid)) continue;
      usedEdges.add(eid);
      dfs(edge.n1 === nodeId ? edge.n2 : edge.n1, usedEdges);
      usedEdges.delete(eid);
    }
  }
  playerEdges.forEach(e => { dfs(e.n1, new Set()); dfs(e.n2, new Set()); });
  return best;
}
function updateLongestRoad(room) {
  const results = room.players.map(p => ({ id: p.id, len: calculateLongestRoad(room, p.id) }));
  const max = Math.max(...results.map(r => r.len), 0);
  if (max < 5) {
    room.longestRoadOwnerId = null;
    room.longestRoadLength = max;
    return;
  }
  const leaders = results.filter(r => r.len === max);
  if (leaders.length === 1) {
    if (room.longestRoadOwnerId !== leaders[0].id) {
      const p = room.players.find(x => x.id === leaders[0].id);
      roomLog(room, `${p.name} が最長交易路を獲得しました！`, 'bonus');
    }
    room.longestRoadOwnerId = leaders[0].id;
    room.longestRoadLength = max;
  } else {
    room.longestRoadLength = max;
  }
}
function victoryPoints(room, playerId) {
  let points = room.nodes.reduce((sum, n) => {
    if (n.owner !== playerId) return sum;
    return sum + (n.city ? 2 : 1);
  }, 0);
  if (room.longestRoadOwnerId === playerId) points += 2;
  return points;
}
function publicRoom(room) {
  return {
    id: room.id,
    maxPlayers: room.maxPlayers,
    hostToken: room.hostToken,
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.color, light: p.light, connected: p.connected,
      victoryPoints: victoryPoints(room, p.id), resources: p.resources, resourceCount: resourceTotal(p), roadLength: calculateLongestRoad(room, p.id)
    })),
    started: room.started,
    gameOver: room.gameOver,
    currentPlayerIndex: room.currentPlayerIndex,
    phase: room.phase,
    setupOrder: room.setupOrder,
    setupIndex: room.setupIndex,
    setupSubphase: room.setupSubphase,
    currentSetupPlayerId: room.phase === 'setup' ? currentSetupPlayerId(room) : null,
    tiles: room.tiles,
    nodes: room.nodes,
    edges: room.edges,
    robberTileId: room.robberTileId,
    dice: room.dice,
    winnerIds: room.winnerIds,
    log: room.log.slice(-32),
    longestRoadOwnerId: room.longestRoadOwnerId,
    longestRoadLength: room.longestRoadLength,
    pendingTrade: room.pendingTrade,
    costs: COSTS,
    targetPoints: TARGET_POINTS
  };
}
function emitRoom(room) { io.to(room.id).emit('roomState', publicRoom(room)); }
function checkWin(room) {
  updateLongestRoad(room);
  const scores = room.players.map(p => ({ id: p.id, score: victoryPoints(room, p.id) }));
  const max = Math.max(...scores.map(s => s.score));
  if (max >= TARGET_POINTS) {
    room.gameOver = true;
    room.winnerIds = scores.filter(s => s.score === max).map(s => s.id);
    const names = room.players.filter(p => room.winnerIds.includes(p.id)).map(p => p.name).join('・');
    roomLog(room, `${names} が${TARGET_POINTS}点に到達しました！`, 'win');
  }
}
function neighborNodes(room, nodeId) {
  return room.edges.filter(e => e.n1 === nodeId || e.n2 === nodeId).map(e => e.n1 === nodeId ? e.n2 : e.n1);
}
function isValidSettlementNode(room, nodeId) {
  const node = room.nodes.find(n => n.id === nodeId);
  if (!node || node.owner) return false;
  return neighborNodes(room, nodeId).every(nid => !room.nodes.find(n => n.id === nid)?.owner);
}
function hasConnectedOwnRoad(room, playerId, nodeId) {
  const node = room.nodes.find(n => n.id === nodeId);
  return node && node.edges.some(eid => room.edges.find(e => e.id === eid && e.owner === playerId));
}
function edgeTouchesOwnedNetwork(room, playerId, edge) {
  const a = room.nodes.find(n => n.id === edge.n1);
  const b = room.nodes.find(n => n.id === edge.n2);
  const endpointHasBuilding = [a, b].some(n => n.owner === playerId);
  const endpointHasRoad = [a, b].some(n => n.edges.some(eid => eid !== edge.id && room.edges.find(e => e.id === eid && e.owner === playerId)));
  return endpointHasBuilding || endpointHasRoad;
}
function edgeTouchesNode(edge, nodeId) { return edge.n1 === nodeId || edge.n2 === nodeId; }
function grantStartingResources(room, player, nodeId) {
  const node = room.nodes.find(n => n.id === nodeId);
  const gained = [];
  node.adjacentTiles.forEach(tid => {
    const tile = room.tiles.find(t => t.id === tid);
    if (tile && tile.resource !== 'desert') {
      player.resources[tile.resource] += 1;
      gained.push(`${RESOURCE_ICONS[tile.resource]}${RESOURCE_LABELS[tile.resource]}`);
    }
  });
  if (gained.length) roomLog(room, `${player.name} が初期資源：${gained.join('・')} を受け取りました。`, 'gain');
}
function distributeResources(room, sum) {
  const gains = [];
  room.tiles.filter(t => t.number === sum && t.id !== room.robberTileId).forEach(tile => {
    const nodes = room.nodes.filter(n => n.owner && n.adjacentTiles.includes(tile.id));
    nodes.forEach(node => {
      const p = room.players.find(x => x.id === node.owner);
      if (!p || tile.resource === 'desert') return;
      const amount = node.city ? 2 : 1;
      p.resources[tile.resource] += amount;
      gains.push(`${p.name}+${RESOURCE_ICONS[tile.resource]}${RESOURCE_LABELS[tile.resource]}${amount}`);
    });
  });
  return gains;
}
function discardForSeven(room) {
  room.players.forEach(p => {
    const total = resourceTotal(p);
    if (total <= 7) return;
    let discard = Math.floor(total / 2);
    const lost = blankResources(0);
    while (discard > 0) {
      const available = RESOURCES.filter(r => p.resources[r] > 0);
      if (!available.length) break;
      const r = available[Math.floor(Math.random() * available.length)];
      p.resources[r] -= 1;
      lost[r] += 1;
      discard -= 1;
    }
    roomLog(room, `${p.name} は7枚超過のため ${resourceText(lost)} を捨てました。`, 'robber');
  });
}
function stealFromRobberTile(room, player, tileId) {
  const victimIds = new Set(room.nodes.filter(n => n.owner && n.owner !== player.id && n.adjacentTiles.includes(tileId)).map(n => n.owner));
  const victims = room.players.filter(p => victimIds.has(p.id) && resourceTotal(p) > 0);
  if (!victims.length) return null;
  const victim = victims[Math.floor(Math.random() * victims.length)];
  const resources = RESOURCES.filter(r => victim.resources[r] > 0);
  const res = resources[Math.floor(Math.random() * resources.length)];
  victim.resources[res] -= 1;
  player.resources[res] += 1;
  return { victim, res };
}
function makeRoom(name, maxPlayers) {
  const id = makeRoomId();
  const token = makeToken();
  const board = createBoard();
  const player = { id: 1, token, name: (name || 'プレイヤー1').trim().slice(0, 16), color: PLAYER_COLORS[0], light: PLAYER_LIGHT[0], connected: true, resources: blankResources(0) };
  return {
    room: { id, maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)), hostToken: token, players: [player], started: false, gameOver: false, currentPlayerIndex: 0, phase: 'waiting', setupOrder: [], setupIndex: 0, setupSubphase: 'settlement', setupSettlementNode: null, ...board, dice: null, winnerIds: [], log: [], longestRoadOwnerId: null, longestRoadLength: 0, pendingTrade: null },
    token,
    player
  };
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, maxPlayers }, cb) => {
    const { room, token, player } = makeRoom(name, maxPlayers);
    rooms.set(room.id, room); socket.join(room.id); socket.data.roomId = room.id; socket.data.token = token;
    roomLog(room, `${player.name} が部屋を作りました。`, 'join');
    cb?.({ ok: true, roomId: room.id, token, playerId: 1, room: publicRoom(room) }); emitRoom(room);
  });
  socket.on('joinRoom', ({ roomId, name }, cb) => {
    const room = rooms.get(String(roomId || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。' });
    if (room.started) return cb?.({ ok: false, message: 'この部屋はすでに開始しています。再接続してください。' });
    if (room.players.length >= room.maxPlayers) return cb?.({ ok: false, message: 'この部屋は満員です。' });
    const id = room.players.length + 1; const token = makeToken();
    const player = { id, token, name: (name || `プレイヤー${id}`).trim().slice(0, 16), color: PLAYER_COLORS[id - 1], light: PLAYER_LIGHT[id - 1], connected: true, resources: blankResources(0) };
    room.players.push(player); socket.join(room.id); socket.data.roomId = room.id; socket.data.token = token;
    roomLog(room, `${player.name} が入室しました。`, 'join');
    cb?.({ ok: true, roomId: room.id, token, playerId: id, room: publicRoom(room) }); emitRoom(room);
  });
  socket.on('reconnectPlayer', ({ roomId, token }, cb) => {
    const room = rooms.get(String(roomId || '').trim().toUpperCase());
    if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。' });
    const player = getPlayer(room, token); if (!player) return cb?.({ ok: false, message: '再接続情報が一致しません。' });
    player.connected = true; socket.join(room.id); socket.data.roomId = room.id; socket.data.token = token;
    roomLog(room, `${player.name} が再接続しました。`, 'join');
    cb?.({ ok: true, roomId: room.id, token, playerId: player.id, room: publicRoom(room) }); emitRoom(room);
  });
  socket.on('startGame', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); if (!room) return cb?.({ ok: false, message: '部屋がありません。' });
    if (room.hostToken !== token) return cb?.({ ok: false, message: '部屋主だけが開始できます。' });
    if (room.players.length < 2) return cb?.({ ok: false, message: '2人以上で開始できます。' });
    const board = createBoard(); Object.assign(room, board);
    room.players.forEach(p => p.resources = blankResources(0));
    room.started = true; room.gameOver = false; room.currentPlayerIndex = 0; room.phase = 'setup'; room.setupOrder = createSetupOrder(room.players); room.setupIndex = 0; room.setupSubphase = 'settlement'; room.setupSettlementNode = null; room.dice = null; room.winnerIds = []; room.log = []; room.longestRoadOwnerId = null; room.longestRoadLength = 0; room.pendingTrade = null;
    roomLog(room, 'ゲーム開始！初期配置を2周行います。', 'start');
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('rename', ({ roomId, token, name }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!player) return cb?.({ ok: false, message: 'プレイヤーが見つかりません。' });
    const old = player.name; player.name = (name || player.name).trim().slice(0, 16); roomLog(room, `${old} は ${player.name} に名前を変えました。`); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('placeInitialSettlement', ({ roomId, token, nodeId }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'setup') return cb?.({ ok: false, message: '初期配置中ではありません。' });
    if (currentSetupPlayerId(room) !== player.id || room.setupSubphase !== 'settlement') return cb?.({ ok: false, message: '今はあなたが開拓地を置く番ではありません。' });
    if (!isValidSettlementNode(room, nodeId)) return cb?.({ ok: false, message: 'ここには置けません。隣に開拓地がない交点を選んでください。' });
    const node = room.nodes.find(n => n.id === nodeId); node.owner = player.id; node.city = false; room.setupSettlementNode = nodeId; room.setupSubphase = 'road';
    roomLog(room, `${player.name} が初期開拓地を置きました。`, 'build'); checkWin(room);
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('placeInitialRoad', ({ roomId, token, edgeId }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'setup') return cb?.({ ok: false, message: '初期配置中ではありません。' });
    if (currentSetupPlayerId(room) !== player.id || room.setupSubphase !== 'road') return cb?.({ ok: false, message: '今はあなたが道を置く番ではありません。' });
    const edge = room.edges.find(e => e.id === edgeId); if (!edge || edge.owner) return cb?.({ ok: false, message: 'ここには道を置けません。' });
    if (!edgeTouchesNode(edge, room.setupSettlementNode)) return cb?.({ ok: false, message: '直前に置いた開拓地に接する道を選んでください。' });
    edge.owner = player.id; updateLongestRoad(room);
    const secondRoundStart = room.players.length;
    if (room.setupIndex >= secondRoundStart) grantStartingResources(room, player, room.setupSettlementNode);
    room.setupSettlementNode = null; room.setupIndex += 1; room.setupSubphase = 'settlement';
    if (room.setupIndex >= room.setupOrder.length) {
      room.phase = 'roll'; room.currentPlayerIndex = 0;
      roomLog(room, '初期配置完了！最初のプレイヤーはサイコロを振ってください。', 'start');
    } else {
      const next = room.players.find(p => p.id === currentSetupPlayerId(room));
      roomLog(room, `次は ${next.name} の初期配置です。`, 'info');
    }
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('rollDice', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (!room.started || room.gameOver) return cb?.({ ok: false, message: 'ゲーム中ではありません。' });
    if (room.phase !== 'roll') return cb?.({ ok: false, message: '今はサイコロを振るタイミングではありません。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    const d1 = Math.floor(Math.random() * 6) + 1; const d2 = Math.floor(Math.random() * 6) + 1; const sum = d1 + d2; room.dice = { d1, d2, sum };
    room.pendingTrade = null;
    if (sum === 7) { discardForSeven(room); room.phase = 'robber'; roomLog(room, `${player.name} が 7 を出しました。盗賊を移動してください。`, 'robber'); }
    else { const gains = distributeResources(room, sum); room.phase = 'action'; roomLog(room, `${player.name} が ${d1}+${d2}=${sum} を出しました。${gains.length ? gains.join('、') : '資源獲得なし。'}`, 'gain'); }
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('moveRobber', ({ roomId, token, tileId }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'robber') return cb?.({ ok: false, message: '盗賊を動かすタイミングではありません。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (!room.tiles.find(t => t.id === tileId)) return cb?.({ ok: false, message: '土地が見つかりません。' });
    if (room.robberTileId === tileId) return cb?.({ ok: false, message: '別の土地に移動してください。' });
    room.robberTileId = tileId;
    const tile = room.tiles.find(t => t.id === tileId);
    const steal = stealFromRobberTile(room, player, tileId);
    room.phase = 'action';
    roomLog(room, `${player.name} が盗賊を ${RESOURCE_ICONS[tile.resource]}${RESOURCE_LABELS[tile.resource]} の土地へ移動しました。${steal ? `${steal.victim.name} から資源を1枚奪いました。` : '奪える相手はいませんでした。'}`, 'robber');
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('buildSettlement', ({ roomId, token, nodeId }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: 'サイコロ後の行動中だけ建設できます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (!isValidSettlementNode(room, nodeId)) return cb?.({ ok: false, message: 'ここには開拓地を置けません。距離ルールを確認してください。' });
    if (!hasConnectedOwnRoad(room, player.id, nodeId)) return cb?.({ ok: false, message: '自分の道につながる交点にだけ建設できます。' });
    if (!canAfford(player, COSTS.settlement)) return cb?.({ ok: false, message: '資源不足：開拓地には 木・土・麦・羊 が必要です。' });
    pay(player, COSTS.settlement); const node = room.nodes.find(n => n.id === nodeId); node.owner = player.id; node.city = false;
    roomLog(room, `${player.name} が開拓地を建設しました。`, 'build'); checkWin(room); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('upgradeCity', ({ roomId, token, nodeId }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: 'サイコロ後の行動中だけ建設できます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    const node = room.nodes.find(n => n.id === nodeId); if (!node || node.owner !== player.id) return cb?.({ ok: false, message: '自分の開拓地を選んでください。' });
    if (node.city) return cb?.({ ok: false, message: 'すでに都市です。' });
    if (!canAfford(player, COSTS.city)) return cb?.({ ok: false, message: '資源不足：都市には 麦2・石3 が必要です。' });
    pay(player, COSTS.city); node.city = true; roomLog(room, `${player.name} が都市を建設しました。`, 'build'); checkWin(room); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('buildRoad', ({ roomId, token, edgeId }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: 'サイコロ後の行動中だけ建設できます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    const edge = room.edges.find(e => e.id === edgeId); if (!edge || edge.owner) return cb?.({ ok: false, message: 'ここには道を置けません。' });
    if (!edgeTouchesOwnedNetwork(room, player.id, edge)) return cb?.({ ok: false, message: '自分の道か開拓地につながる場所にだけ道を置けます。' });
    if (!canAfford(player, COSTS.road)) return cb?.({ ok: false, message: '資源不足：道には 木・土 が必要です。' });
    pay(player, COSTS.road); edge.owner = player.id; roomLog(room, `${player.name} が道を建設しました。`, 'build'); updateLongestRoad(room); checkWin(room); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('bankTrade', ({ roomId, token, give, receive }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: '交換は自分の行動中だけできます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (!RESOURCES.includes(give) || !RESOURCES.includes(receive) || give === receive) return cb?.({ ok: false, message: '交換内容が正しくありません。' });
    if ((player.resources[give] || 0) < 4) return cb?.({ ok: false, message: `${RESOURCE_LABELS[give]}が4つ必要です。` });
    player.resources[give] -= 4; player.resources[receive] += 1; roomLog(room, `${player.name} が銀行交換：${RESOURCE_LABELS[give]}4 → ${RESOURCE_LABELS[receive]}1`, 'trade'); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('proposeTrade', ({ roomId, token, toPlayerId, give, receive }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action' || currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: '交渉は自分の行動中だけできます。' });
    const target = room.players.find(p => p.id === Number(toPlayerId));
    if (!target || target.id === player.id) return cb?.({ ok: false, message: '交渉相手を選んでください。' });
    if (!RESOURCES.includes(give) || !RESOURCES.includes(receive) || give === receive) return cb?.({ ok: false, message: '交換内容が正しくありません。' });
    if (player.resources[give] < 1) return cb?.({ ok: false, message: `${RESOURCE_LABELS[give]}を持っていません。` });
    room.pendingTrade = { fromPlayerId: player.id, toPlayerId: target.id, give, receive, createdAt: Date.now() };
    roomLog(room, `${player.name} が ${target.name} に交渉：${RESOURCE_LABELS[give]}1 → ${RESOURCE_LABELS[receive]}1`, 'trade');
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('acceptTrade', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player || !room.pendingTrade) return cb?.({ ok: false, message: '交渉がありません。' });
    const trade = room.pendingTrade;
    if (trade.toPlayerId !== player.id) return cb?.({ ok: false, message: 'あなた宛ての交渉ではありません。' });
    const from = room.players.find(p => p.id === trade.fromPlayerId);
    if (!from || from.resources[trade.give] < 1 || player.resources[trade.receive] < 1) { room.pendingTrade = null; return cb?.({ ok: false, message: 'どちらかの資源が不足しています。' }); }
    from.resources[trade.give] -= 1; player.resources[trade.give] += 1;
    player.resources[trade.receive] -= 1; from.resources[trade.receive] += 1;
    roomLog(room, `${player.name} が交渉を承諾しました。`, 'trade');
    room.pendingTrade = null; cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('cancelTrade', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player || !room.pendingTrade) return cb?.({ ok: false, message: '交渉がありません。' });
    if (room.pendingTrade.fromPlayerId !== player.id && room.pendingTrade.toPlayerId !== player.id) return cb?.({ ok: false, message: '関係者だけが取り消せます。' });
    room.pendingTrade = null; roomLog(room, `${player.name} が交渉を取り消しました。`, 'trade'); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('endTurn', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (room.gameOver) return cb?.({ ok: false, message: 'ゲームは終了しています。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: '行動を終えてからターン終了できます。' });
    room.pendingTrade = null;
    room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length; room.dice = null; room.phase = 'roll';
    roomLog(room, `${currentPlayer(room).name} の番です。`, 'turn'); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId); if (!room) return; const player = getPlayer(room, socket.data.token);
    if (player) { player.connected = false; roomLog(room, `${player.name} が切断しました。`, 'leave'); emitRoom(room); }
  });
});
server.listen(PORT, () => console.log(`Hex Island server running on port ${PORT}`));
