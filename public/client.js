const socket = io();
const $ = (id) => document.getElementById(id);

let playerId = localStorage.getItem('ito.playerId');
if (!playerId) {
  playerId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2) + Date.now();
  localStorage.setItem('ito.playerId', playerId);
}
$('nameInput').value = localStorage.getItem('ito.name') || '';

const params = new URLSearchParams(location.search);
if (params.get('room')) $('codeInput').value = params.get('room').toUpperCase();

let state = null;
let currentRoom = sessionStorage.getItem('ito.room');
let dragging = false;
let prevRevealed = 0;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function getName() {
  const name = $('nameInput').value.trim();
  if (!name) {
    toast('名前を入力してください');
    return null;
  }
  localStorage.setItem('ito.name', name);
  return name;
}

$('createBtn').onclick = () => {
  const name = getName();
  if (name) socket.emit('create', { playerId, name });
};
$('joinBtn').onclick = () => {
  const name = getName();
  const code = $('codeInput').value.trim().toUpperCase();
  if (!code) return toast('部屋コードを入力してください');
  if (name) socket.emit('join', { code, playerId, name });
};
$('codeInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinBtn').click());

$('copyLink').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('招待リンクをコピーしました');
  } catch {
    prompt('このリンクを共有してください', url);
  }
};
$('leaveBtn').onclick = () => {
  if (!confirm('部屋から退出しますか？')) return;
  socket.emit('leave');
  goHome();
};

$('startBtn').onclick = () => socket.emit('startGame');
$('rerollBtn').onclick = () => socket.emit('rerollTheme');
$('customThemeBtn').onclick = () => {
  socket.emit('customTheme', $('customTheme').value);
  $('customTheme').value = '';
};
$('setCards').addEventListener('change', () => socket.emit('updateSettings', { cardsPerPlayer: $('setCards').value }));
$('readyBtn').onclick = () => {
  const me = state.players.find((p) => p.id === playerId);
  if (!me.ready) {
    const blank = state.cards.some((c) => c.ownerId === playerId && !c.hint.trim());
    if (blank && !confirm('まだカードに何も書いていません。このままOKにしますか？')) return;
  }
  socket.emit('setReady', !me.ready);
};
$('forceBtn').onclick = () => confirm('全員のOKを待たずに答え合わせしますか？') && socket.emit('forceReveal');
$('nextBtn').onclick = () => socket.emit('nextRound');
$('lobbyBtn').onclick = () => socket.emit('backToLobby');
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('chatInput').value.trim();
  if (v) socket.emit('chat', v);
  $('chatInput').value = '';
};

// カードの並べ替え（ドラッグ＆ドロップ、スマホのタッチにも対応）
const sortable = Sortable.create($('line'), {
  animation: 150,
  filter: 'textarea',
  preventOnFilter: false,
  delay: 120,
  delayOnTouchOnly: true,
  onStart: () => (dragging = true),
  onEnd: (evt) => {
    dragging = false;
    if (evt.oldIndex !== evt.newIndex) socket.emit('moveCard', { cardId: evt.item.dataset.id, toIndex: evt.newIndex });
    else if (state) render();
  },
});

// 書き込みは少し待ってからまとめて送る
const hintTimers = {};
function sendHint(cardId, hint) {
  clearTimeout(hintTimers[cardId]);
  hintTimers[cardId] = setTimeout(() => socket.emit('writeHint', { cardId, hint }), 350);
}

function goHome() {
  state = null;
  currentRoom = null;
  sessionStorage.removeItem('ito.room');
  history.replaceState(null, '', location.pathname);
  $('home').classList.remove('hidden');
  $('game').classList.add('hidden');
  $('roomInfo').classList.add('hidden');
}

socket.on('connect', () => {
  // リロード・再接続時に自動で部屋へ戻る
  if (currentRoom) socket.emit('join', { code: currentRoom, playerId, name: localStorage.getItem('ito.name') || '' });
});
socket.on('joined', ({ code }) => {
  currentRoom = code;
  sessionStorage.setItem('ito.room', code);
  history.replaceState(null, '', `?room=${code}`);
});
socket.on('errorMsg', (msg) => {
  toast(msg);
  if (msg === '部屋が見つかりません' && currentRoom) goHome();
});
socket.on('kicked', () => {
  toast('部屋から外されました');
  goHome();
});
socket.on('state', (s) => {
  state = s;
  if (!dragging) render();
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function cardEl(c, i, s) {
  const el = document.createElement('div');
  el.dataset.id = c.id;
  const mine = c.ownerId === playerId;
  const open = i < s.revealed;
  const arrange = s.phase === 'arrange';
  el.className = 'icard ' + (open ? `open ${c.ok ? 'ok' : 'ng'}` : mine ? 'front' : 'back');
  if (arrange) el.classList.add('draggable');
  if (open && i >= prevRevealed) el.classList.add('flip');

  const owner = `<div class="owner">${mine ? 'あなた' : esc(c.ownerName)}</div>`;
  const num = `<div class="num">${c.value ?? '?'}</div>`;
  let words;
  if (mine && arrange) {
    words = `<textarea data-card="${c.id}" maxlength="30" placeholder="ここに書き込む&#10;(お題に沿った言葉)">${esc(c.hint)}</textarea>`;
  } else {
    words = c.hint ? `<div class="words">${esc(c.hint)}</div>` : `<div class="words empty">（まだ書いていません）</div>`;
  }
  const mark = open ? `<div class="mark">${c.ok ? '✔' : '✘'}</div>` : '';
  el.innerHTML = owner + num + words + mark;
  return el;
}

function render() {
  const s = state;
  const me = s.players.find((p) => p.id === playerId);
  const host = s.hostId === playerId;

  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomInfo').classList.remove('hidden');
  $('roomCode').textContent = s.code;

  document.querySelectorAll('.hostOnly').forEach((el) => el.classList.toggle('hidden', !host));
  document.querySelectorAll('.guestOnly').forEach((el) => el.classList.toggle('hidden', host));
  if (host) document.querySelectorAll('.arrangeOnly').forEach((el) => el.classList.toggle('hidden', s.phase !== 'arrange'));

  show('lobbyPanel', s.phase === 'lobby');
  show('themePanel', s.phase !== 'lobby');
  show('tablePanel', s.phase !== 'lobby');
  show('arrangeBar', s.phase === 'arrange');
  show('resultBar', s.phase === 'result');

  // ロビー
  $('setCards').value = s.settings.cardsPerPlayer;
  $('setCards').disabled = !host;
  $('startBtn').disabled = s.players.length < 2;

  // お題
  $('theme').textContent = s.theme || '';
  $('roundInfo').textContent = s.round ? `（第${s.round}ラウンド・成功 ${s.wins}回）` : '';

  // 説明
  const instr = {
    arrange:
      '① 自分のカード（オレンジ）に、お題に沿って自分の数字の大きさを表す言葉を書き込もう。<br>' +
      '② みんなの言葉を見ながら、カードをドラッグして<b>左から小さい順</b>に並べ替えよう（誰のカードでも動かせます）。<br>' +
      '③ 並びに納得したら「この順番でOK！」。全員OKで答え合わせ！',
    reveal: '答え合わせ中… 左から1枚ずつめくります',
    result: '',
  };
  $('instruction').innerHTML = instr[s.phase] || '';
  show('instruction', !!instr[s.phase]);

  // 書き込み中のカードはフォーカスと入力内容を保つ
  const active = document.activeElement;
  let keep = null;
  if (active && active.dataset && active.dataset.card) {
    keep = { id: active.dataset.card, value: active.value, start: active.selectionStart, end: active.selectionEnd };
  }

  const line = $('line');
  line.innerHTML = '';
  s.cards.forEach((c, i) => line.appendChild(cardEl(c, i, s)));
  sortable.option('disabled', s.phase !== 'arrange');

  line.querySelectorAll('textarea[data-card]').forEach((ta) => {
    ta.addEventListener('input', () => sendHint(ta.dataset.card, ta.value));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        ta.blur();
      }
    });
    if (keep && keep.id === ta.dataset.card) {
      ta.value = keep.value;
      ta.focus();
      ta.setSelectionRange(keep.start, keep.end);
    }
  });
  prevRevealed = s.revealed;

  // OKボタン
  if (s.phase === 'arrange' && me) {
    const btn = $('readyBtn');
    btn.textContent = me.ready ? 'OK済み（押すと取り消し）' : 'この順番でOK！';
    btn.classList.toggle('done', me.ready);
    const active = s.players.filter((p) => p.connected);
    const waiting = active.filter((p) => !p.ready).map((p) => p.name);
    $('readyInfo').textContent = `OK ${active.length - waiting.length} / ${active.length}人` + (waiting.length ? `（待ち: ${waiting.join('、')}）` : '');
  }

  // 結果
  if (s.phase === 'result') {
    const t = $('resultTitle');
    const miss = s.cards.filter((c) => !c.ok).length;
    t.textContent = s.result === 'success' ? '大成功！ 全部小さい順に並んでいました 🎉' : `残念… 順番ミスが ${miss} 枚ありました`;
    t.className = s.result;
  }

  // プレイヤー
  const ul = $('players');
  ul.innerHTML = '';
  s.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="${p.connected ? '' : 'offline'}">${esc(p.name)}</span>
        ${p.id === s.hostId ? '<span class="badge">ホスト</span>' : ''}
        ${p.id === playerId ? '<span class="badge me">あなた</span>' : ''}
        ${s.phase === 'arrange' && p.ready ? '<span class="badge ready">OK</span>' : ''}
        ${p.connected ? '' : '<span class="muted">(切断)</span>'}`;
    if (host && p.id !== playerId) {
      const b = document.createElement('button');
      b.className = 'kick small ghost';
      b.textContent = '外す';
      b.onclick = () => confirm(`${p.name} を外しますか？`) && socket.emit('kick', p.id);
      li.appendChild(b);
    }
    ul.appendChild(li);
  });

  // チャット
  const chat = $('chat');
  const atBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 10;
  chat.innerHTML = s.chat.map((m) => `<div><b>${esc(m.name)}</b>: ${esc(m.text)}</div>`).join('');
  if (atBottom) chat.scrollTop = chat.scrollHeight;

  // ログ
  $('log').innerHTML = s.log
    .slice()
    .reverse()
    .map((l) => `<li>${esc(l.text)}</li>`)
    .join('');
}
