const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const THEMES = require('./themes');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

/** @type {Map<string, object>} */
const rooms = new Map();

const MAX_PLAYERS = 10;
const ROOM_TTL_MS = 1000 * 60 * 30; // 全員切断後30分で部屋を削除
const REVEAL_INTERVAL_MS = 1200; // 答え合わせで1枚めくる間隔

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickTheme(room) {
  if (room.themeDeck.length === 0) room.themeDeck = shuffle(THEMES.slice());
  return room.themeDeck.pop();
}

function createRoom(hostId) {
  const room = {
    code: makeRoomCode(),
    hostId,
    players: [], // { id, name, connected, ready }
    phase: 'lobby', // lobby | arrange | reveal | result
    settings: { cardsPerPlayer: 1 },
    round: 0,
    wins: 0,
    theme: null,
    themeDeck: shuffle(THEMES.slice()),
    cards: [], // 並び順そのもの。{ id, value, ownerId, hint }
    revealed: 0, // 左から何枚めくったか
    revealTimer: null,
    result: null, // 'success' | 'fail'
    log: [],
    chat: [],
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function addLog(room, text) {
  room.log.push({ t: Date.now(), text });
  if (room.log.length > 50) room.log.shift();
}

function playerName(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '(退出)';
}

function publicState(room, viewerId) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    round: room.round,
    wins: room.wins,
    theme: room.theme,
    revealed: room.revealed,
    result: room.result,
    log: room.log.slice(-15),
    chat: room.chat.slice(-50),
    // 数字は持ち主本人と、めくられたカードだけに見せる
    cards: room.cards.map((c, i) => ({
      id: c.id,
      ownerId: c.ownerId,
      ownerName: playerName(room, c.ownerId),
      hint: c.hint,
      value: c.ownerId === viewerId || i < room.revealed ? c.value : null,
      ok: i < room.revealed ? isInOrder(room, i) : null,
    })),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      ready: p.ready,
    })),
  };
}

// 左隣（めくられた中で一番大きい数）より小さければ順番ミス
function isInOrder(room, i) {
  for (let j = 0; j < i; j++) if (room.cards[j].value > room.cards[i].value) return false;
  return true;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
  }
}

function stopReveal(room) {
  if (room.revealTimer) clearInterval(room.revealTimer);
  room.revealTimer = null;
}

function startRound(room) {
  stopReveal(room);
  const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  let n = 0;
  room.cards = [];
  room.players.forEach((p) => {
    p.ready = false;
    for (let k = 0; k < room.settings.cardsPerPlayer; k++) {
      room.cards.push({ id: `${Date.now().toString(36)}-${++n}`, value: deck.pop(), ownerId: p.id, hint: '' });
    }
  });
  shuffle(room.cards);
  room.round += 1;
  room.theme = pickTheme(room);
  room.revealed = 0;
  room.result = null;
  room.phase = 'arrange';
  addLog(room, `第${room.round}ラウンド！ お題「${room.theme}」`);
}

function startReveal(room) {
  room.phase = 'reveal';
  room.revealed = 0;
  addLog(room, '答え合わせ！');
  broadcast(room);
  room.revealTimer = setInterval(() => {
    room.revealed += 1;
    if (room.revealed >= room.cards.length) {
      stopReveal(room);
      const ok = room.cards.every((_, i) => isInOrder(room, i));
      room.result = ok ? 'success' : 'fail';
      if (ok) room.wins += 1;
      room.phase = 'result';
      addLog(room, ok ? '大成功！ 全部小さい順に並んでいた！' : '残念… 順番が崩れているところがあった');
    }
    broadcast(room);
  }, REVEAL_INTERVAL_MS);
}

function resetReady(room) {
  room.players.forEach((p) => (p.ready = false));
}

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  const err = (msg) => socket.emit('errorMsg', msg);

  function attach(r, playerId, name) {
    let p = r.players.find((x) => x.id === playerId);
    if (!p) {
      if (r.players.length >= MAX_PLAYERS) return err('部屋が満員です');
      if (r.phase !== 'lobby') return err('ゲーム進行中のため参加できません。次のラウンドまでお待ちください');
      p = { id: playerId, name, connected: true, ready: false };
      r.players.push(p);
      addLog(r, `${name} が参加しました`);
    } else {
      if (name) p.name = name;
      addLog(r, `${p.name} が再接続しました`);
    }
    p.connected = true;
    p.socketId = socket.id;
    r.emptySince = null;
    room = r;
    player = p;
    socket.join(r.code);
    socket.emit('joined', { code: r.code, playerId });
    broadcast(r);
  }

  socket.on('create', ({ playerId, name }) => {
    if (!playerId || !name) return err('名前を入力してください');
    const r = createRoom(playerId);
    attach(r, playerId, String(name).slice(0, 16));
  });

  socket.on('join', ({ code, playerId, name }) => {
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return err('部屋が見つかりません');
    if (!playerId) return err('不正なリクエストです');
    attach(r, playerId, name ? String(name).slice(0, 16) : '');
  });

  const isHost = () => room && player && room.hostId === player.id;

  socket.on('updateSettings', (s) => {
    if (!isHost() || room.phase !== 'lobby') return;
    const cards = Math.min(5, Math.max(1, parseInt(s.cardsPerPlayer, 10) || 1));
    room.settings = { cardsPerPlayer: cards };
    broadcast(room);
  });

  socket.on('startGame', () => {
    if (!isHost() || room.phase !== 'lobby') return;
    if (room.players.length < 2) return err('2人以上で開始できます');
    room.round = 0;
    room.wins = 0;
    startRound(room);
    broadcast(room);
  });

  socket.on('rerollTheme', () => {
    if (!isHost() || room.phase !== 'arrange') return;
    room.theme = pickTheme(room);
    addLog(room, `お題を変更: 「${room.theme}」`);
    broadcast(room);
  });

  socket.on('customTheme', (text) => {
    if (!isHost() || room.phase !== 'arrange') return;
    const t = String(text || '').trim().slice(0, 60);
    if (!t) return;
    room.theme = t;
    addLog(room, `お題を変更: 「${room.theme}」`);
    broadcast(room);
  });

  // 自分のカードに文字を書き込む
  socket.on('writeHint', ({ cardId, hint }) => {
    if (!room || !player || room.phase !== 'arrange') return;
    const c = room.cards.find((x) => x.id === cardId);
    if (!c || c.ownerId !== player.id) return;
    const next = String(hint || '').slice(0, 30);
    if (next === c.hint) return;
    c.hint = next;
    resetReady(room);
    broadcast(room);
  });

  // 誰でもカードを好きな位置に動かせる
  socket.on('moveCard', ({ cardId, toIndex }) => {
    if (!room || !player || room.phase !== 'arrange') return;
    const from = room.cards.findIndex((x) => x.id === cardId);
    if (from === -1) return;
    const to = Math.min(room.cards.length - 1, Math.max(0, parseInt(toIndex, 10) || 0));
    if (from === to) return;
    const [c] = room.cards.splice(from, 1);
    room.cards.splice(to, 0, c);
    resetReady(room);
    broadcast(room);
  });

  // 全員が「この順番でOK」を押したら答え合わせ
  socket.on('setReady', (ready) => {
    if (!room || !player || room.phase !== 'arrange') return;
    player.ready = !!ready;
    const active = room.players.filter((p) => p.connected);
    if (active.length > 0 && active.every((p) => p.ready)) startReveal(room);
    else broadcast(room);
  });

  socket.on('forceReveal', () => {
    if (!isHost() || room.phase !== 'arrange') return;
    startReveal(room);
  });

  socket.on('nextRound', () => {
    if (!isHost() || room.phase !== 'result') return;
    startRound(room);
    broadcast(room);
  });

  socket.on('backToLobby', () => {
    if (!isHost()) return;
    stopReveal(room);
    room.phase = 'lobby';
    room.result = null;
    room.theme = null;
    room.cards = [];
    room.revealed = 0;
    // 切断中のプレイヤーはロビーに戻る時点で外す
    room.players = room.players.filter((p) => p.connected);
    room.players.forEach((p) => (p.ready = false));
    addLog(room, 'ロビーに戻りました');
    broadcast(room);
  });

  socket.on('kick', (targetId) => {
    if (!isHost() || targetId === player.id) return;
    const t = room.players.find((p) => p.id === targetId);
    if (!t) return;
    room.players = room.players.filter((p) => p.id !== targetId);
    if (room.phase === 'arrange') room.cards = room.cards.filter((c) => c.ownerId !== targetId);
    if (t.socketId) io.to(t.socketId).emit('kicked');
    addLog(room, `${t.name} が退出しました`);
    broadcast(room);
  });

  socket.on('chat', (text) => {
    if (!room || !player) return;
    const t = String(text || '').trim().slice(0, 200);
    if (!t) return;
    room.chat.push({ t: Date.now(), name: player.name, text: t });
    if (room.chat.length > 100) room.chat.shift();
    broadcast(room);
  });

  socket.on('leave', () => {
    if (!room || !player) return;
    const r = room;
    if (r.phase === 'lobby') {
      r.players = r.players.filter((p) => p.id !== player.id);
      addLog(r, `${player.name} が退出しました`);
    } else {
      player.connected = false;
      player.socketId = null;
    }
    socket.leave(r.code);
    handleHostChange(r);
    room = null;
    player = null;
    broadcast(r);
  });

  socket.on('disconnect', () => {
    if (!room || !player) return;
    if (player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    addLog(room, `${player.name} の接続が切れました`);
    handleHostChange(room);
    broadcast(room);
  });
});

function handleHostChange(room) {
  const host = room.players.find((p) => p.id === room.hostId);
  if (!host || !host.connected) {
    const next = room.players.find((p) => p.connected);
    if (next) {
      room.hostId = next.id;
      addLog(room, `${next.name} がホストになりました`);
    }
  }
  if (!room.players.some((p) => p.connected)) room.emptySince = room.emptySince || Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.length === 0 || (room.emptySince && now - room.emptySince > ROOM_TTL_MS)) {
      stopReveal(room);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`ito server listening on http://localhost:${PORT}`);
});
