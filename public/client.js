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
$('hintBtn').onclick = () => socket.emit('setHint', $('hintInput').value);
$('hintInput').addEventListener('keydown', (e) => e.key === 'Enter' && $('hintBtn').click());
$('beginPlayBtn').onclick = () => socket.emit('beginPlay');
$('nextBtn').onclick = () => socket.emit('nextRound');
$('lobbyBtn').onclick = () => socket.emit('backToLobby');
['setLives', 'setCards'].forEach((id) =>
  $(id).addEventListener('change', () =>
    socket.emit('updateSettings', { lives: $('setLives').value, cardsPerPlayer: $('setCards').value })
  )
);
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('chatInput').value.trim();
  if (v) socket.emit('chat', v);
  $('chatInput').value = '';
};

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
  const prevPhase = state && state.phase;
  state = s;
  if (prevPhase !== s.phase && s.phase === 'hint') $('hintInput').value = '';
  render();
});

const PHASE_LABEL = { lobby: 'ロビー', hint: 'ヒントを考える', play: 'カードを出す', result: '結果' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (id, on) => $(id).classList.toggle('hidden', !on);

function cardEl(value, opts = {}) {
  const el = document.createElement(opts.button ? 'button' : 'div');
  el.className = 'num-card ' + (opts.cls || '');
  el.innerHTML = `${opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : ''}${value}${
    opts.who ? `<span class="who">${esc(opts.who)}</span>` : ''
  }`;
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

  $('level').textContent = s.level;
  $('lives').textContent = s.phase === 'lobby' ? '♥'.repeat(s.settings.lives) : '♥'.repeat(Math.max(0, s.lives)) + '♡'.repeat(Math.max(0, s.settings.lives - s.lives));
  $('phase').textContent = PHASE_LABEL[s.phase];

  document.querySelectorAll('.hostOnly').forEach((el) => el.classList.toggle('hidden', !host));
  document.querySelectorAll('.guestOnly').forEach((el) => el.classList.toggle('hidden', host));
  if (host) document.querySelectorAll('.hintOnly').forEach((el) => el.classList.toggle('hidden', s.phase !== 'hint'));

  show('lobbyPanel', s.phase === 'lobby');
  show('themePanel', s.phase !== 'lobby');
  show('handPanel', s.phase === 'hint' || s.phase === 'play');
  show('tablePanel', s.phase === 'play' || s.phase === 'result');
  show('resultPanel', s.phase === 'result');

  // ロビー設定
  $('setLives').value = s.settings.lives;
  $('setCards').value = s.settings.cardsPerPlayer;
  $('setLives').disabled = $('setCards').disabled = !host;
  $('startBtn').disabled = s.players.length < 2;

  $('theme').textContent = s.theme || '';

  // 手札
  const hand = $('hand');
  hand.innerHTML = '';
  if (me && me.cards) {
    me.cards.forEach((v) => {
      const playable = s.phase === 'play';
      const el = cardEl(v, { button: playable, cls: playable ? 'playable' : '' });
      if (playable) {
        el.onclick = () => {
          if (confirm(`${v} を場に出しますか？`)) socket.emit('playCard', v);
        };
      }
      hand.appendChild(el);
    });
    if (me.cards.length === 0) hand.innerHTML = '<span class="muted">手札はありません</span>';
  }
  $('handHelp').textContent =
    s.phase === 'hint'
      ? '— 数字は言わずに、お題に沿ったたとえを考えよう'
      : s.phase === 'play'
      ? '— 自分が一番小さいと思ったらクリックして出そう'
      : '';
  if (me && document.activeElement !== $('hintInput') && !$('hintInput').value) $('hintInput').value = me.hint || '';

  // 場
  const played = $('played');
  played.innerHTML = '';
  s.played.forEach((c) => played.appendChild(cardEl(c.value, { cls: c.ok ? 'ok' : 'ng', who: c.name, hint: c.hint })));
  if (s.played.length === 0) played.innerHTML = '<span class="muted">まだカードは出ていません</span>';
  show('discardWrap', s.discarded.length > 0);
  const disc = $('discarded');
  disc.innerHTML = '';
  s.discarded.forEach((c) => disc.appendChild(cardEl(c.value, { cls: 'discard', who: c.name, hint: c.hint })));

  // 結果
  if (s.phase === 'result') {
    const t = $('resultTitle');
    const map = {
      clear: ['パーフェクト！ レベルクリア 🎉', 'clear'],
      partial: ['レベルクリア！（ミスあり）', 'clear'],
      gameover: ['ゲームオーバー…', 'fail'],
    };
    const [text, cls] = map[s.result] || ['', ''];
    t.textContent = text;
    t.className = cls;
    const all = [
      ...s.played.map((c) => ({ ...c, kind: c.ok ? '✔' : '✘' })),
      ...s.discarded.map((c) => ({ ...c, kind: '捨' })),
      ...s.players.flatMap((p) => (p.cards || []).map((v) => ({ value: v, name: p.name, hint: p.hint, kind: '残' }))),
    ].sort((a, b) => a.value - b.value);
    $('resultList').innerHTML =
      '<div class="label">正しい順番</div>' +
      all
        .map(
          (c) =>
            `<div class="result-row"><span class="n">${c.value}</span><span>${esc(c.name)}</span><span class="muted">${esc(
              c.hint || ''
            )}</span><span>${c.kind}</span></div>`
        )
        .join('');
    $('nextBtn').classList.toggle('hidden', s.result === 'gameover');
  }

  // プレイヤー
  const ul = $('players');
  ul.innerHTML = '';
  s.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="pname ${p.connected ? '' : 'offline'}">
        ${esc(p.name)}
        ${p.id === s.hostId ? '<span class="badge">ホスト</span>' : ''}
        ${p.id === playerId ? '<span class="badge me">あなた</span>' : ''}
        ${p.connected ? '' : '<span class="muted">(切断)</span>'}
        ${s.phase !== 'lobby' ? `<span class="muted">残り${p.cardCount}枚</span>` : ''}
      </div>
      ${p.hint ? `<div class="phint">「${esc(p.hint)}」</div>` : ''}`;
    if (host && p.id !== playerId) {
      const b = document.createElement('button');
      b.className = 'kick small ghost';
      b.textContent = '外す';
      b.onclick = () => confirm(`${p.name} を外しますか？`) && socket.emit('kick', p.id);
      li.querySelector('.pname').appendChild(b);
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
