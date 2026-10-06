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

/** @type {Map<string, Room>} */
const rooms = new Map();

const MAX_PLAYERS = 10;
const ROOM_TTL_MS = 1000 * 60 * 30; // 全員切断後30分で部屋を削除

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
    players: [], // { id, name, connected, cards: number[], hint }
    phase: 'lobby', // lobby | hint | play | result
    settings: { lives: 3, cardsPerPlayer: 1 },
    lives: 3,
    level: 1,
    theme: null,
    themeDeck: shuffle(THEMES.slice()),
    played: [], // { value, playerId, name, ok }
    discarded: [], // 失敗で捨てられたカード
    result: null, // 'clear' | 'fail' | 'gameover'
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

function publicState(room, viewerId) {
  const revealAll = room.phase === 'result' || room.phase === 'lobby';
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    lives: room.lives,
    level: room.level,
    theme: room.theme,
    played: room.played,
    discarded: room.discarded,
    result: room.result,
    log: room.log.slice(-15),
    chat: room.chat.slice(-50),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      hint: p.hint,
      cardCount: p.cards.length,
      cards: p.id === viewerId || revealAll ? p.cards : null,
    })),
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', publicState(room, p.id));
  }
}

function startRound(room) {
  const need = room.players.length * room.settings.cardsPerPlayer;
  const deck = shuffle(Array.from({ length: 100 }, (_, i) => i + 1));
  room.players.forEach((p) => {
    p.cards = deck.splice(0, room.settings.cardsPerPlayer).sort((a, b) => a - b);
    p.hint = '';
  });
  room.theme = pickTheme(room);
  room.played = [];
  room.discarded = [];
  room.result = null;
  room.phase = 'hint';
  addLog(room, `レベル${room.level} 開始！ お題「${room.theme}」 (カード${need}枚)`);
}

function remainingCards(room) {
  return room.players.flatMap((p) => p.cards.map((v) => ({ value: v, player: p })));
}

function playCard(room, player, value) {
  const idx = player.cards.indexOf(value);
  if (idx === -1) return;
  player.cards.splice(idx, 1);

  // 場に出したカードより小さいカードが手札に残っていたら失敗
  const lower = remainingCards(room).filter((c) => c.value < value);
  const ok = lower.length === 0;
  room.played.push({ value, playerId: player.id, name: player.name, hint: player.hint, ok });

  if (ok) {
    addLog(room, `${player.name} が ${value} を出した ✔`);
  } else {
    room.lives -= 1;
    lower.forEach((c) => {
      c.player.cards.splice(c.player.cards.indexOf(c.value), 1);
      room.discarded.push({ value: c.value, playerId: c.player.id, name: c.player.name, hint: c.player.hint });
    });
    addLog(
      room,
      `${player.name} が ${value} を出した ✘ もっと小さい ${lower
        .map((c) => `${c.value}(${c.player.name})`)
        .join(', ')} があった！ ライフ -1`
    );
  }

  if (room.lives <= 0) {
    room.phase = 'result';
    room.result = 'gameover';
    addLog(room, 'ライフが尽きた… ゲームオーバー');
  } else if (remainingCards(room).length === 0) {
    room.phase = 'result';
    room.result = room.played.every((c) => c.ok) && room.discarded.length === 0 ? 'clear' : 'partial';
    addLog(room, room.result === 'clear' ? 'パーフェクト！ レベルクリア！' : 'ミスはあったけどレベルクリア！');
  }
}

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  const err = (msg) => socket.emit('errorMsg', msg);

  function attach(r, playerId, name) {
    let p = r.players.find((x) => x.id === playerId);
    if (!p) {
      if (r.players.length >= MAX_PLAYERS) return err('部屋が満員です');
      if (r.phase !== 'lobby') return err('ゲーム進行中のため参加できません。次のゲームまでお待ちください');
      p = { id: playerId, name, connected: true, cards: [], hint: '' };
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
    const lives = Math.min(10, Math.max(1, parseInt(s.lives, 10) || 3));
    const cards = Math.min(5, Math.max(1, parseInt(s.cardsPerPlayer, 10) || 1));
    room.settings = { lives, cardsPerPlayer: cards };
    broadcast(room);
  });

  socket.on('startGame', () => {
    if (!isHost() || room.phase !== 'lobby') return;
    if (room.players.length < 2) return err('2人以上で開始できます');
    room.lives = room.settings.lives;
    room.level = 1;
    startRound(room);
    broadcast(room);
  });

  socket.on('rerollTheme', () => {
    if (!isHost() || room.phase !== 'hint') return;
    room.theme = pickTheme(room);
    addLog(room, `お題を変更: 「${room.theme}」`);
    broadcast(room);
  });

  socket.on('customTheme', (text) => {
    if (!isHost() || room.phase !== 'hint') return;
    const t = String(text || '').trim().slice(0, 60);
    if (!t) return;
    room.theme = t;
    addLog(room, `お題を変更: 「${room.theme}」`);
    broadcast(room);
  });

  socket.on('setHint', (hint) => {
    if (!room || !player || (room.phase !== 'hint' && room.phase !== 'play')) return;
    player.hint = String(hint || '').slice(0, 40);
    broadcast(room);
  });

  socket.on('beginPlay', () => {
    if (!isHost() || room.phase !== 'hint') return;
    room.phase = 'play';
    addLog(room, '並べ始めよう！ 一番小さいと思う人からカードを出してね');
    broadcast(room);
  });

  socket.on('playCard', (value) => {
    if (!room || !player || room.phase !== 'play') return;
    playCard(room, player, Number(value));
    broadcast(room);
  });

  socket.on('nextRound', () => {
    if (!isHost() || room.phase !== 'result') return;
    if (room.result === 'gameover') return;
    room.level += 1;
    startRound(room);
    broadcast(room);
  });

  socket.on('backToLobby', () => {
    if (!isHost()) return;
    room.phase = 'lobby';
    room.result = null;
    room.theme = null;
    room.played = [];
    room.discarded = [];
    room.players.forEach((p) => {
      p.cards = [];
      p.hint = '';
    });
    // 切断中のプレイヤーはロビーに戻る時点で外す
    room.players = room.players.filter((p) => p.connected);
    addLog(room, 'ロビーに戻りました');
    broadcast(room);
  });

  socket.on('kick', (targetId) => {
    if (!isHost() || targetId === player.id) return;
    const t = room.players.find((p) => p.id === targetId);
    if (!t) return;
    if (room.phase !== 'lobby' && t.cards.length > 0) {
      // 進行中に外す場合はカードを捨て札にする
      t.cards.forEach((v) => room.discarded.push({ value: v, playerId: t.id, name: t.name }));
      t.cards = [];
    }
    room.players = room.players.filter((p) => p.id !== targetId);
    if (t.socketId) io.to(t.socketId).emit('kicked');
    addLog(room, `${t.name} が退出しました`);
    if (room.phase === 'play' && remainingCards(room).length === 0) {
      room.phase = 'result';
      room.result = 'partial';
    }
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
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`ito server listening on http://localhost:${PORT}`);
});
