// W.ARENA: ядро судьи-бота. Не зависит от Firebase, работает через небольшой интерфейс dbi.
const K_FACTOR = 32;          // чувствительность ELO
const CAL_GAMES = 10;         // столько игр длится калибровка
const K_CAL = 60;             // во время калибровки ELO меняется сильнее
const GRACE = 2 * 60 * 1000;  // ждём 2 минуты после первого отчёта (вдруг придут другие); 0 = подтверждать сразу
const ELO_FLOOR = 100;        // ниже этого ELO не падает
const NEED_SHARE = 0.6;       // решаем матч, когда сообщили минимум 60% игроков
const LIVE_TIMEOUT = 90 * 60 * 1000;   // через 90 минут решаем по тем отчётам, что есть
const LOBBY_TIMEOUT = 5 * 60 * 1000;   // лобби без подтверждения закрывается

// ---- ники: те же правила, что и на сайте ----
const NICK_MAX = 30, NICK_BAD = ['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof'];
const cleanNick = s => String(s || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const b64 = s => typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s)));
function nickKey(n) { const l = String(n).toLowerCase(); if (/^[\wА-Яа-я-]+$/.test(l) && !/^__.*__$/.test(l)) return l; return '~' + b64(l).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function nickProblem(n) { if (!n) return 'Введите никнейм'; if (n.length > NICK_MAX) return 'Ник: не больше ' + NICK_MAX + ' символов'; if (NICK_BAD.includes(n.toLowerCase())) return 'Этот ник недоступен'; return ''; }

const clampInt = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const avg = t => t.length ? t.reduce((s, p) => s + (p.elo || 1000), 0) / t.length : 1000;
const eloDelta = (win, mine, opp, K = K_FACTOR) => Math.round(K * ((win ? 1 : 0) - 1 / (1 + Math.pow(10, (opp - mine) / 400))));

// Кто победил по отчётам игроков. Каждый игрок сообщает «я выиграл / проиграл».
function judge(match, reports, now, grace = GRACE) {
  const side = uid => match.A.some(p => p.uid === uid) ? 'A' : match.B.some(p => p.uid === uid) ? 'B' : null;
  const seen = {}, valid = [];
  for (const r of reports) { if (!r || seen[r.uid] || !side(r.uid)) continue; seen[r.uid] = 1; valid.push(r); }
  let a = 0, b = 0;
  for (const r of valid) { const s = side(r.uid), w = r.win ? s : (s === 'A' ? 'B' : 'A'); w === 'A' ? a++ : b++; }
  const N = match.uids.length, n = valid.length, need = Math.ceil(N * NEED_SHARE);
  const start = match.start || match.ts || now, overdue = now - start > LIVE_TIMEOUT;
  const major = a > n / 2 ? 'A' : b > n / 2 ? 'B' : null;
  if ((n >= need || n === N) && major) return { type: 'done', winner: major, a, b, n };
  // Достаточно одного отчёта со скриншотом, если ему никто не противоречит
  const shots = valid.filter(r => r.shot && String(r.shot).length > 1000).length;
  const first = valid.length ? Math.min(...valid.map(r => r.ts || 0)) : now;
  if (n >= 1 && shots >= 1 && major && (a === 0 || b === 0) && now - first >= grace) return { type: 'done', winner: major, a, b, n, single: n === 1 };
  if (n === N && !major) return { type: 'void', reason: 'tie', a, b, n };
  if (overdue) return n >= 2 && major ? { type: 'done', winner: major, a, b, n } : { type: 'void', reason: 'no-consensus', a, b, n };
  return null;
}

// Что записать каждому игроку
function settle(match, reports, winner, users, now) {
  const rep = {}; for (const r of reports) if (r && !rep[r.uid]) rep[r.uid] = r;
  const aAvg = avg(match.A), bAvg = avg(match.B), out = [];
  for (const [team, mine, opp, mineSide] of [[match.A, aAvg, bAvg, 'A'], [match.B, bAvg, aAvg, 'B']]) {
    const win = winner === mineSide;
    for (const p of team) {
      const u = users[p.uid] || {}, r = rep[p.uid], elo0 = Number.isFinite(u.elo) ? u.elo : (p.elo || 1000);
      const games = (u.w || 0) + (u.l || 0), cal = games < CAL_GAMES, delta = eloDelta(win, mine, opp, cal ? K_CAL : K_FACTOR);
      const elo = Math.max(ELO_FLOOR, elo0 + delta), real = elo - elo0;
      const k = r ? clampInt(r.k, 60) : 0, d = r ? clampInt(r.d, 60) : 0, a = r ? clampInt(r.a, 99) : 0;
      const mt = { no: match.no, srv: match.srv, mine: mineSide,
        A: match.A.map(q => ({ nick: q.nick, elo: q.elo, role: q.role, me: q.uid === p.uid })),
        B: match.B.map(q => ({ nick: q.nick, elo: q.elo, role: q.role, me: q.uid === p.uid })) };
      const entry = { mid: match.id, win, delta: real, k, d, a, role: p.role, srv: match.srv, ts: now, elo, mt, rep: !!r, pro: !!match.pro, cal, g: games + 1 };
      out.push({ uid: p.uid, patch: {
        elo, w: (u.w || 0) + (win ? 1 : 0), l: (u.l || 0) + (win ? 0 : 1),
        k: (u.k || 0) + k, d: (u.d || 0) + d, a: (u.a || 0) + a,
        mh: [entry].concat(Array.isArray(u.mh) ? u.mh : []).slice(0, 50) } });
    }
  }
  return { users: out, summary: { winner, aAvg: Math.round(aAvg), bAvg: Math.round(bAvg), reports: Object.keys(rep).length } };
}

// Заявки на смену никнейма. dbi: nickReqs() -> [{uid,newNick,status}], usersWithFriend(nick) -> [{uid,fr}], setFriends(uid, fr)
//   tx: getNickReq(uid), getUser(uid), getNick(key), setNickReq(uid, patch), setNick(key, data), deleteNick(key), updateUser(uid, patch), updateGid(gid, patch)
async function processNickChanges(dbi, now, log) {
  const renamed = [];
  for (const r of await dbi.nickReqs()) {
    if (r.status !== 'pending') continue;
    await dbi.transact(async tx => {
      const cur = await tx.getNickReq(r.uid); if (!cur || cur.status !== 'pending') return;
      const user = await tx.getUser(r.uid), nn = cleanNick(cur.newNick), bad = nickProblem(nn);
      const fail = msg => { tx.setNickReq(r.uid, { status: 'error', error: msg, doneAt: now }); log.nickErrors++; };
      if (!user) return fail('Аккаунт не найден');
      if (bad) return fail(bad);
      if (nn === user.nick) return fail('Это уже ваш ник');
      const key = nickKey(nn), taken = await tx.getNick(key);
      if (taken && taken.uid !== r.uid) return fail('Ник уже занят');
      tx.deleteNick(nickKey(user.nick)); tx.setNick(key, { uid: r.uid });
      tx.updateUser(r.uid, { nick: nn }); if (user.gid) tx.updateGid(String(user.gid), { nick: nn });
      tx.setNickReq(r.uid, { status: 'done', nick: nn, doneAt: now }); renamed.push({ old: user.nick, nick: nn }); log.renamed++;
    });
  }
  // у друзей меняем старый ник на новый в списках друзей
  for (const x of renamed) for (const f of await dbi.usersWithFriend(x.old)) await dbi.setFriends(f.uid, f.fr.map(n => n === x.old ? x.nick : n));
}

// Один проход судьи. dbi:
//   matches(status) -> [{id,...}]   reports(matchId) -> [...]
//   transact(async tx => ...) где tx: getMatch(id), getUsers(uids) -> {uid: data}, setMatch(id, patch), updateUser(uid, patch)
async function runPass(dbi, now = Date.now(), opts = {}) {
  const log = { done: 0, voided: 0, cancelled: 0, renamed: 0, nickErrors: 0 };
  for (const m of await dbi.matches('live')) {
    const consent = m.cv && m.uids.every(u => m.cv[u] === true);
    if (consent) { await dbi.transact(async tx => { const c = await tx.getMatch(m.id); if (c && c.status === 'live') { tx.setMatch(m.id, { status: 'cancelled', cancelReason: 'consent', settledAt: now }); log.cancelled++; } }); continue; }
    const rs = await dbi.reports(m.id), j = judge(m, rs, now, opts.grace != null ? opts.grace : GRACE);
    if (!j) continue;
    await dbi.transact(async tx => {
      const cur = await tx.getMatch(m.id); if (!cur || cur.status !== 'live') return;
      if (j.type === 'void') { tx.setMatch(m.id, { status: 'void', voidReason: j.reason, settledAt: now }); log.voided++; return; }
      const us = await tx.getUsers(cur.uids), res = settle(cur, rs, j.winner, us, now);
      for (const r of res.users) tx.updateUser(r.uid, r.patch);
      tx.setMatch(m.id, { status: 'done', winner: j.winner, settledAt: now, result: res.summary }); log.done++;
    });
  }
  for (const m of await dbi.matches('lobby')) {
    if (now - (m.ts || 0) <= LOBBY_TIMEOUT) continue;
    await dbi.transact(async tx => { const c = await tx.getMatch(m.id); if (c && c.status === 'lobby') { tx.setMatch(m.id, { status: 'cancelled', cancelReason: 'timeout', settledAt: now }); log.cancelled++; } });
  }
  if (dbi.nickReqs) await processNickChanges(dbi, now, log);
  return log;
}
if (typeof module !== 'undefined') module.exports = { judge, settle, runPass, eloDelta, avg, nickKey, cleanNick, nickProblem };
