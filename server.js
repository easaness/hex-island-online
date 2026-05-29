const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

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
  road: { wood: 1, brick: 1, wheat: 0, sheep: 0, ore: 0 },
  development: { wood: 0, brick: 0, wheat: 1, sheep: 1, ore: 1 }
};
const DEV_CARD_LABELS = { knight: '騎士', victory: '勝利点', roadBuilding: '道路建設', yearOfPlenty: '収穫', monopoly: '独占' };
const TARGET_POINTS = 10;
const rooms = new Map();
const DATA_DIR = process.env.ROOM_DATA_DIR || process.env.RENDER_DISCOVERY_SERVICE || '/tmp';
const SAVE_FILE = process.env.ROOM_SAVE_FILE || path.join(DATA_DIR === '/tmp' ? '/tmp' : '/tmp', 'hex-island-rooms.json');


function saveRoomsToDisk() {
  try {
    const payload = Array.from(rooms.entries()).map(([id, room]) => [id, room]);
    fs.writeFileSync(SAVE_FILE, JSON.stringify(payload), 'utf8');
  } catch (error) {
    console.warn('Room save failed:', error.message);
  }
}
function loadRoomsFromDisk() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const payload = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    if (!Array.isArray(payload)) return;
    payload.forEach(([id, room]) => {
      if (id && room && Array.isArray(room.players)) rooms.set(id, room);
    });
    console.log(`Restored ${rooms.size} room(s) from ${SAVE_FILE}`);
  } catch (error) {
    console.warn('Room restore failed:', error.message);
  }
}
function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}
function restoreRoomFromSnapshot(snapshot, token, playerId) {
  if (!snapshot || !snapshot.id || !Array.isArray(snapshot.players) || !Array.isArray(snapshot.tiles) || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) return null;
  const normalizedId = String(snapshot.id).trim().toUpperCase();
  const pid = Number(playerId);
  const players = snapshot.players.map(p => ({
    id: Number(p.id),
    token: Number(p.id) === pid ? token : null,
    name: String(p.name || `プレイヤー${p.id}`).slice(0, 16),
    color: p.color || PLAYER_COLORS[(Number(p.id) || 1) - 1] || '#334155',
    light: p.light || PLAYER_LIGHT[(Number(p.id) || 1) - 1] || '#f1f5f9',
    connected: Number(p.id) === pid,
    resources: Object.assign(blankResources(0), p.resources || {}),
    devCards: Object.assign(blankDevCards(), p.devCards || {}),
    playedKnights: Number(p.playedKnights) || 0
  })).filter(p => p.id >= 1 && p.id <= 4);
  if (!players.some(p => p.id === pid)) return null;
  const room = {
    id: normalizedId,
    maxPlayers: Math.max(2, Math.min(4, Number(snapshot.maxPlayers) || players.length || 2)),
    hostToken: pid === 1 ? token : null,
    players,
    started: !!snapshot.started,
    gameOver: !!snapshot.gameOver,
    currentPlayerIndex: Number(snapshot.currentPlayerIndex) || 0,
    phase: snapshot.phase || 'waiting',
    setupOrder: Array.isArray(snapshot.setupOrder) ? snapshot.setupOrder : [],
    setupIndex: Number(snapshot.setupIndex) || 0,
    setupSubphase: snapshot.setupSubphase || 'settlement',
    setupSettlementNode: snapshot.setupSettlementNode || null,
    tiles: clonePlain(snapshot.tiles),
    nodes: clonePlain(snapshot.nodes),
    edges: clonePlain(snapshot.edges),
    ports: clonePlain(snapshot.ports || []),
    robberTileId: snapshot.robberTileId || (snapshot.tiles[0] && snapshot.tiles[0].id),
    dice: snapshot.dice || null,
    winnerIds: Array.isArray(snapshot.winnerIds) ? snapshot.winnerIds : [],
    log: Array.isArray(snapshot.log) ? snapshot.log.slice(-80) : [],
    longestRoadOwnerId: snapshot.longestRoadOwnerId || null,
    longestRoadLength: Number(snapshot.longestRoadLength) || 0,
    pendingTrade: snapshot.pendingTrade || null,
    devDeck: Array.isArray(snapshot.devDeck) ? snapshot.devDeck : createDevDeck(),
    largestArmyOwnerId: snapshot.largestArmyOwnerId || null,
    largestArmySize: Number(snapshot.largestArmySize) || 0
  };
  roomLog(room, 'サーバー側の部屋情報が消えていたため、ブラウザの保存データから部屋を復元しました。', 'info');
  rooms.set(normalizedId, room);
  saveRoomsToDisk();
  return room;
}
function normalizeRoomId(roomId) {
  return String(roomId || '').trim().toUpperCase();
}
function ensureRoomFromPayload(payload) {
  if (!payload || !payload.roomId) return null;
  const roomId = normalizeRoomId(payload.roomId);
  let room = rooms.get(roomId);
  if (!room && payload.snapshot) {
    room = restoreRoomFromSnapshot(payload.snapshot, payload.token, payload.playerId);
  }
  return room || null;
}
function touchRoom(room) {
  if (!room) return;
  room.updatedAt = Date.now();
  saveRoomsToDisk();
}
setInterval(saveRoomsToDisk, 30000).unref();
loadRoomsFromDisk();

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
function blankDevCards() { return { knight: 0, victory: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 }; }
function createDevDeck() {
  return shuffle([
    ...Array(14).fill('knight'),
    ...Array(5).fill('victory'),
    ...Array(2).fill('roadBuilding'),
    ...Array(2).fill('yearOfPlenty'),
    ...Array(2).fill('monopoly')
  ]);
}
function devCardCount(cards) { return Object.values(cards || {}).reduce((a, b) => a + (Number(b) || 0), 0); }
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
  const ports = createPorts(nodes, edges);
  return { tiles, nodes, edges, ports, robberTileId: desert ? desert.id : tiles[0].id };
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
function createPorts(nodes, edges) {
  const portTypes = ['wood', 'brick', 'wheat', 'sheep', 'ore', 'any', 'any', 'any', 'any'];
  const coastalIds = new Set(nodes.filter(n => n.adjacentTiles.length < 3).map(n => n.id));
  const coastal = nodes
    .filter(n => coastalIds.has(n.id))
    .map(n => {
      const angle = Math.atan2(n.y, n.x);
      const distance = Math.hypot(n.x, n.y);
      return { node: n, angle, distance };
    })
    .sort((a, b) => a.angle - b.angle || b.distance - a.distance);
  if (!coastal.length) return [];
  const step = coastal.length / portTypes.length;
  const used = new Set();

  function findPair(start) {
    const candidates = edges
      .filter(e => (e.n1 === start.id || e.n2 === start.id))
      .map(e => nodes.find(n => n.id === (e.n1 === start.id ? e.n2 : e.n1)))
      .filter(n => n && coastalIds.has(n.id) && !used.has(n.id));
    if (!candidates.length) return [start.id];
    candidates.sort((a, b) => {
      const da = Math.hypot(a.x - start.x, a.y - start.y);
      const db = Math.hypot(b.x - start.x, b.y - start.y);
      return da - db;
    });
    return [start.id, candidates[0].id];
  }

  return portTypes.map((type, index) => {
    let pickIndex = Math.round(index * step) % coastal.length;
    let guard = 0;
    while (used.has(coastal[pickIndex].node.id) && guard < coastal.length) {
      pickIndex = (pickIndex + 1) % coastal.length;
      guard += 1;
    }
    const chosen = coastal[pickIndex].node;
    const nodeIds = findPair(chosen);
    nodeIds.forEach(id => used.add(id));
    const pairNodes = nodeIds.map(id => nodes.find(n => n.id === id)).filter(Boolean);
    const mx = pairNodes.reduce((sum, n) => sum + n.x, 0) / pairNodes.length;
    const my = pairNodes.reduce((sum, n) => sum + n.y, 0) / pairNodes.length;
    const len = Math.hypot(mx, my) || 1;
    return {
      id: `p${index}`,
      type,
      nodeIds,
      x: mx + (mx / len) * 36,
      y: my + (my / len) * 36
    };
  });
}
function sanitizeResourceMap(map) {
  const out = {};
  RESOURCES.forEach(r => {
    const value = Number(map && map[r]);
    out[r] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  });
  return out;
}
function resourceMapTotal(map) {
  return RESOURCES.reduce((sum, r) => sum + (Number(map && map[r]) || 0), 0);
}
function hasResources(player, map) {
  return RESOURCES.every(r => (player.resources[r] || 0) >= (Number(map && map[r]) || 0));
}
function moveResources(from, to, map) {
  RESOURCES.forEach(r => {
    const n = Number(map && map[r]) || 0;
    from.resources[r] -= n;
    to.resources[r] += n;
  });
}
function resourceMapText(map) {
  const parts = RESOURCES.filter(r => (Number(map && map[r]) || 0) > 0).map(r => `${RESOURCE_ICONS[r]}${RESOURCE_LABELS[r]}${map[r]}`);
  return parts.length ? parts.join('・') : 'なし';
}
function playerPorts(room, playerId) {
  return (room.ports || []).filter(port => port.nodeIds.some(nodeId => room.nodes.find(n => n.id === nodeId && n.owner === playerId)));
}
function bestBankRate(room, playerId, give) {
  const ports = playerPorts(room, playerId);
  if (ports.some(port => port.type === give)) return 2;
  if (ports.some(port => port.type === 'any')) return 3;
  return 4;
}
function portLabel(type) {
  return type === 'any' ? '3:1港' : `${RESOURCE_ICONS[type]}${RESOURCE_LABELS[type]} 2:1港`;
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

function updateLargestArmy(room) {
  const results = room.players.map(p => ({ id: p.id, count: Number(p.playedKnights || 0) }));
  const max = Math.max(...results.map(r => r.count), 0);
  if (max < 3) {
    room.largestArmySize = max;
    return;
  }
  const leaders = results.filter(r => r.count === max);
  if (leaders.length === 1) {
    if (room.largestArmyOwnerId !== leaders[0].id) {
      const p = room.players.find(x => x.id === leaders[0].id);
      roomLog(room, `${p.name} が最大騎士力を獲得しました！`, 'bonus');
    }
    room.largestArmyOwnerId = leaders[0].id;
    room.largestArmySize = max;
  } else {
    room.largestArmySize = max;
  }
}
function victoryPoints(room, playerId) {
  let points = room.nodes.reduce((sum, n) => {
    if (n.owner !== playerId) return sum;
    return sum + (n.city ? 2 : 1);
  }, 0);
  if (room.longestRoadOwnerId === playerId) points += 2;
  if (room.largestArmyOwnerId === playerId) points += 2;
  const player = room.players.find(p => p.id === playerId);
  if (player && player.devCards) points += Number(player.devCards.victory || 0);
  return points;
}
function publicRoom(room) {
  return {
    id: room.id,
    maxPlayers: room.maxPlayers,
    hostToken: room.hostToken,
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.color, light: p.light, connected: p.connected,
      victoryPoints: victoryPoints(room, p.id), resources: p.resources, resourceCount: resourceTotal(p), roadLength: calculateLongestRoad(room, p.id),
      ports: playerPorts(room, p.id).map(port => ({ id: port.id, type: port.type, label: portLabel(port.type) })),
      devCards: p.devCards || blankDevCards(), devCardCount: devCardCount(p.devCards), playedKnights: Number(p.playedKnights || 0)
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
    ports: room.ports || [],
    robberTileId: room.robberTileId,
    pendingDiscards: room.pendingDiscards || {},
    dice: room.dice,
    winnerIds: room.winnerIds,
    log: room.log.slice(-32),
    longestRoadOwnerId: room.longestRoadOwnerId,
    longestRoadLength: room.longestRoadLength,
    largestArmyOwnerId: room.largestArmyOwnerId || null,
    largestArmySize: room.largestArmySize || 0,
    devDeckCount: room.devDeck ? room.devDeck.length : 0,
    devCardLabels: DEV_CARD_LABELS,
    pendingTrade: room.pendingTrade,
    costs: COSTS,
    targetPoints: TARGET_POINTS
  };
}
function emitRoom(room) { saveRoomsToDisk(); io.to(room.id).emit('roomState', publicRoom(room)); }
function checkWin(room) {
  updateLongestRoad(room);
  updateLargestArmy(room);
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
function setupDiscardForSeven(room) {
  room.pendingDiscards = {};
  room.players.forEach(p => {
    const total = resourceTotal(p);
    if (total > 7) room.pendingDiscards[p.id] = { need: Math.floor(total / 2), done: false };
  });
  return Object.keys(room.pendingDiscards).length;
}
function allDiscardsDone(room) {
  const pending = room.pendingDiscards || {};
  return Object.keys(pending).every(id => pending[id].done);
}
function applyDiscard(room, player, discard) {
  const pending = room.pendingDiscards && room.pendingDiscards[player.id];
  if (!pending || pending.done) return { ok: false, message: 'あなたは破棄対象ではありません。' };
  const clean = blankResources(0);
  let total = 0;
  for (const r of RESOURCES) {
    const n = Math.max(0, Math.floor(Number(discard && discard[r]) || 0));
    if (n > player.resources[r]) return { ok: false, message: `${RESOURCE_LABELS[r]}を持っている数より多く捨てようとしています。` };
    clean[r] = n; total += n;
  }
  if (total !== pending.need) return { ok: false, message: `${pending.need}枚ちょうど選んでください。現在 ${total}枚です。` };
  for (const r of RESOURCES) player.resources[r] -= clean[r];
  pending.done = true;
  roomLog(room, `${player.name} は7枚超過のため ${resourceText(clean)} を捨てました。`, 'robber');
  return { ok: true };
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
  const player = { id: 1, token, name: (name || 'プレイヤー1').trim().slice(0, 16), color: PLAYER_COLORS[0], light: PLAYER_LIGHT[0], connected: true, resources: blankResources(0), devCards: blankDevCards(), playedKnights: 0 };
  return {
    room: { id, maxPlayers: Math.max(2, Math.min(4, Number(maxPlayers) || 2)), hostToken: token, players: [player], started: false, gameOver: false, currentPlayerIndex: 0, phase: 'waiting', setupOrder: [], setupIndex: 0, setupSubphase: 'settlement', setupSettlementNode: null, ...board, dice: null, winnerIds: [], log: [], longestRoadOwnerId: null, longestRoadLength: 0, pendingTrade: null, devDeck: createDevDeck(), largestArmyOwnerId: null, largestArmySize: 0, pendingDiscards: {} },
    token,
    player
  };
}

io.on('connection', socket => {
  socket.use((packet, next) => {
    try {
      const data = packet && packet[1];
      if (data && data.roomId && !rooms.has(normalizeRoomId(data.roomId)) && data.snapshot) {
        restoreRoomFromSnapshot(data.snapshot, data.token, data.playerId);
      }
    } catch (error) {
      console.warn('Packet recovery failed:', error.message);
    }
    next();
  });
  socket.on('clientSnapshot', ({ roomId, token, playerId, snapshot }, cb) => {
    let room = rooms.get(normalizeRoomId(roomId));
    if (!room && snapshot) room = restoreRoomFromSnapshot(snapshot, token, playerId);
    if (room) {
      touchRoom(room);
      return cb?.({ ok: true });
    }
    cb?.({ ok: false });
  });
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
    const player = { id, token, name: (name || `プレイヤー${id}`).trim().slice(0, 16), color: PLAYER_COLORS[id - 1], light: PLAYER_LIGHT[id - 1], connected: true, resources: blankResources(0), devCards: blankDevCards(), playedKnights: 0 };
    room.players.push(player); socket.join(room.id); socket.data.roomId = room.id; socket.data.token = token;
    roomLog(room, `${player.name} が入室しました。`, 'join');
    cb?.({ ok: true, roomId: room.id, token, playerId: id, room: publicRoom(room) }); emitRoom(room);
  });
  socket.on('reconnectPlayer', ({ roomId, token, playerId, snapshot }, cb) => {
    const normalizedId = String(roomId || '').trim().toUpperCase();
    let room = rooms.get(normalizedId);
    if (!room && snapshot) room = restoreRoomFromSnapshot(snapshot, token, playerId);
    if (!room) return cb?.({ ok: false, message: '部屋が見つかりません。保存データからも復元できませんでした。全員がページを更新せず、誰かの画面に最新状態が残っていれば再接続できる場合があります。' });
    let player = getPlayer(room, token);
    if (!player && playerId) {
      const candidate = room.players.find(p => p.id === Number(playerId));
      if (candidate && (!candidate.token || candidate.token === token)) {
        candidate.token = token;
        player = candidate;
      }
    }
    if (!player) return cb?.({ ok: false, message: '再接続情報が一致しません。' });
    if (player.id === 1 && !room.hostToken) room.hostToken = token;
    player.connected = true; socket.join(room.id); socket.data.roomId = room.id; socket.data.token = token;
    roomLog(room, `${player.name} が再接続しました。`, 'join');
    cb?.({ ok: true, roomId: room.id, token, playerId: player.id, room: publicRoom(room) }); emitRoom(room);
  });
  socket.on('restoreRoom', ({ roomId, token, playerId, snapshot }, cb) => {
    const normalizedId = String(roomId || '').trim().toUpperCase();
    let room = rooms.get(normalizedId) || restoreRoomFromSnapshot(snapshot, token, playerId);
    if (!room) return cb?.({ ok: false, message: '復元できる保存データがありません。' });
    let player = getPlayer(room, token) || room.players.find(p => p.id === Number(playerId));
    if (!player) return cb?.({ ok: false, message: 'プレイヤー情報が見つかりません。' });
    if (!player.token) player.token = token;
    if (player.id === 1 && !room.hostToken) room.hostToken = token;
    player.connected = true; socket.join(room.id); socket.data.roomId = room.id; socket.data.token = token;
    cb?.({ ok: true, roomId: room.id, token, playerId: player.id, room: publicRoom(room) }); emitRoom(room);
  });
  socket.on('startGame', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); if (!room) return cb?.({ ok: false, message: '部屋がありません。' });
    if (room.hostToken !== token) return cb?.({ ok: false, message: '部屋主だけが開始できます。' });
    if (room.players.length < 2) return cb?.({ ok: false, message: '2人以上で開始できます。' });
    const board = createBoard(); Object.assign(room, board);
    room.players.forEach(p => { p.resources = blankResources(0); p.devCards = blankDevCards(); p.playedKnights = 0; });
    room.started = true; room.gameOver = false; room.currentPlayerIndex = 0; room.phase = 'setup'; room.setupOrder = createSetupOrder(room.players); room.setupIndex = 0; room.setupSubphase = 'settlement'; room.setupSettlementNode = null; room.dice = null; room.winnerIds = []; room.log = []; room.longestRoadOwnerId = null; room.longestRoadLength = 0; room.pendingTrade = null; room.devDeck = createDevDeck(); room.largestArmyOwnerId = null; room.largestArmySize = 0; room.pendingDiscards = {};
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
    if (sum === 7) { const count = setupDiscardForSeven(room); room.phase = count ? 'discard' : 'robber'; roomLog(room, `${player.name} が 7 を出しました。${count ? '7枚を超えるプレイヤーは捨てる資源を選んでください。' : '盗賊を移動してください。'}`, 'robber'); }
    else { const gains = distributeResources(room, sum); room.phase = 'action'; roomLog(room, `${player.name} が ${d1}+${d2}=${sum} を出しました。${gains.length ? gains.join('、') : '資源獲得なし。'}`, 'gain'); }
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('submitDiscard', ({ roomId, token, discard }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'discard') return cb?.({ ok: false, message: '今は資源を捨てるタイミングではありません。' });
    const result = applyDiscard(room, player, discard);
    if (!result.ok) return cb?.(result);
    if (allDiscardsDone(room)) { room.phase = 'robber'; roomLog(room, '破棄が完了しました。現在のプレイヤーは盗賊を移動してください。', 'robber'); }
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

  socket.on('buyDevelopmentCard', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: '発展カードは自分の行動中だけ購入できます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (!room.devDeck || room.devDeck.length === 0) return cb?.({ ok: false, message: '発展カードの山札がありません。' });
    if (!canAfford(player, COSTS.development)) return cb?.({ ok: false, message: '資源不足：発展カードには 麦・羊・石 が必要です。' });
    pay(player, COSTS.development);
    const card = room.devDeck.pop();
    player.devCards = Object.assign(blankDevCards(), player.devCards || {});
    player.devCards[card] += 1;
    roomLog(room, `${player.name} が発展カードを購入しました。`, 'dev');
    checkWin(room); cb?.({ ok: true, card, label: DEV_CARD_LABELS[card] }); emitRoom(room);
  });
  socket.on('playDevelopmentCard', ({ roomId, token, card, resource, resource2, edgeIds }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: '発展カードは自分の行動中だけ使えます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    player.devCards = Object.assign(blankDevCards(), player.devCards || {});
    if (!DEV_CARD_LABELS[card] || (player.devCards[card] || 0) <= 0) return cb?.({ ok: false, message: 'その発展カードを持っていません。' });
    if (card === 'victory') return cb?.({ ok: false, message: '勝利点カードは持っているだけで点になります。' });
    if (card === 'knight') {
      player.devCards.knight -= 1; player.playedKnights = Number(player.playedKnights || 0) + 1; updateLargestArmy(room);
      room.phase = 'robber'; roomLog(room, `${player.name} が騎士カードを使いました。盗賊を移動してください。`, 'dev'); checkWin(room); cb?.({ ok: true }); emitRoom(room); return;
    }
    if (card === 'monopoly') {
      if (!RESOURCES.includes(resource)) return cb?.({ ok: false, message: '独占する資源を選んでください。' });
      let total = 0; room.players.forEach(p => { if (p.id !== player.id) { const n = p.resources[resource] || 0; p.resources[resource] = 0; total += n; } });
      player.resources[resource] += total; player.devCards.monopoly -= 1;
      roomLog(room, `${player.name} が独占カードで${RESOURCE_LABELS[resource]}を${total}枚集めました。`, 'dev'); cb?.({ ok: true }); emitRoom(room); return;
    }
    if (card === 'yearOfPlenty') {
      if (!RESOURCES.includes(resource) || !RESOURCES.includes(resource2)) return cb?.({ ok: false, message: '受け取る資源を2つ選んでください。' });
      player.resources[resource] += 1; player.resources[resource2] += 1; player.devCards.yearOfPlenty -= 1;
      roomLog(room, `${player.name} が収穫カードで${RESOURCE_LABELS[resource]}と${RESOURCE_LABELS[resource2]}を得ました。`, 'dev'); cb?.({ ok: true }); emitRoom(room); return;
    }
    if (card === 'roadBuilding') {
      const ids = Array.isArray(edgeIds) ? edgeIds.slice(0, 2) : [];
      if (!ids.length) return cb?.({ ok: false, message: '道を置く辺を1〜2本選んでください。' });
      let built = 0;
      for (const edgeId of ids) {
        const edge = room.edges.find(e => e.id === edgeId);
        if (!edge || edge.owner) continue;
        if (!edgeTouchesOwnedNetwork(room, player.id, edge)) continue;
        edge.owner = player.id; built += 1;
      }
      if (built === 0) return cb?.({ ok: false, message: '置ける道がありません。' });
      player.devCards.roadBuilding -= 1; updateLongestRoad(room);
      roomLog(room, `${player.name} が道路建設カードで道を${built}本置きました。`, 'dev'); checkWin(room); cb?.({ ok: true }); emitRoom(room); return;
    }
  });
  socket.on('bankTrade', ({ roomId, token, give, receive }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action') return cb?.({ ok: false, message: '交換は自分の行動中だけできます。' });
    if (currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: 'あなたの番ではありません。' });
    if (!RESOURCES.includes(give) || !RESOURCES.includes(receive) || give === receive) return cb?.({ ok: false, message: '交換内容が正しくありません。' });
    const rate = bestBankRate(room, player.id, give);
    if ((player.resources[give] || 0) < rate) return cb?.({ ok: false, message: `${RESOURCE_LABELS[give]}が${rate}つ必要です。` });
    player.resources[give] -= rate; player.resources[receive] += 1;
    const portText = rate === 2 ? '専用港' : rate === 3 ? '3:1港' : '銀行';
    roomLog(room, `${player.name} が${portText}交換：${RESOURCE_LABELS[give]}${rate} → ${RESOURCE_LABELS[receive]}1`, 'trade'); cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('proposeTrade', ({ roomId, token, toPlayerId, give, receive, offer, request }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player) return cb?.({ ok: false, message: '部屋またはプレイヤーが見つかりません。' });
    if (room.phase !== 'action' || currentPlayer(room)?.token !== token) return cb?.({ ok: false, message: '交渉は自分の行動中だけできます。' });
    const target = room.players.find(p => p.id === Number(toPlayerId));
    if (!target || target.id === player.id) return cb?.({ ok: false, message: '交渉相手を選んでください。' });

    let offerMap = sanitizeResourceMap(offer);
    let requestMap = sanitizeResourceMap(request);
    // 古いUI/通信との互換性。未指定なら従来の1:1扱い。
    if (resourceMapTotal(offerMap) === 0 && RESOURCES.includes(give)) offerMap[give] = 1;
    if (resourceMapTotal(requestMap) === 0 && RESOURCES.includes(receive)) requestMap[receive] = 1;

    if (resourceMapTotal(offerMap) === 0 || resourceMapTotal(requestMap) === 0) return cb?.({ ok: false, message: '渡す資源と欲しい資源を1枚以上指定してください。' });
    if (!hasResources(player, offerMap)) return cb?.({ ok: false, message: '提示する資源が不足しています。' });

    room.pendingTrade = { fromPlayerId: player.id, toPlayerId: target.id, offer: offerMap, request: requestMap, createdAt: Date.now() };
    roomLog(room, `${player.name} が ${target.name} に交渉：渡す ${resourceMapText(offerMap)} / ほしい ${resourceMapText(requestMap)}`, 'trade');
    cb?.({ ok: true }); emitRoom(room);
  });
  socket.on('acceptTrade', ({ roomId, token }, cb) => {
    const room = rooms.get(roomId); const player = room && getPlayer(room, token); if (!room || !player || !room.pendingTrade) return cb?.({ ok: false, message: '交渉がありません。' });
    const trade = room.pendingTrade;
    if (trade.toPlayerId !== player.id) return cb?.({ ok: false, message: 'あなた宛ての交渉ではありません。' });
    const from = room.players.find(p => p.id === trade.fromPlayerId);
    const offerMap = trade.offer || sanitizeResourceMap({ [trade.give]: 1 });
    const requestMap = trade.request || sanitizeResourceMap({ [trade.receive]: 1 });
    if (!from || !hasResources(from, offerMap) || !hasResources(player, requestMap)) { room.pendingTrade = null; return cb?.({ ok: false, message: 'どちらかの資源が不足しています。交渉を取り消しました。' }); }
    moveResources(from, player, offerMap);
    moveResources(player, from, requestMap);
    roomLog(room, `${player.name} が交渉を承諾：${from.name} → ${resourceMapText(offerMap)} / ${player.name} → ${resourceMapText(requestMap)}`, 'trade');
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
