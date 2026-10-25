// W.ARENA: судья-бот. Забирает отчёты игроков, определяет победителя, начисляет ELO и завершает матчи.
// Запуск: node referee.js            один проход
//         node referee.js --loop 270  работать 270 секунд, проверяя матчи каждые 15 секунд
// Ключ сервис-аккаунта Firebase берётся из переменной FIREBASE_SERVICE_ACCOUNT (содержимое JSON-файла)
// или из файла, путь к которому указан в GOOGLE_APPLICATION_CREDENTIALS.
// GRACE_SECONDS (необязательно): сколько секунд ждать после первого отчёта (по умолчанию 120; 0 = подтверждать сразу).
const admin = require('firebase-admin');
const { runPass } = require('./referee_core.js');

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
else admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

const dbi = {
  async matches(status) {
    const s = await db.collection('matches').where('status', '==', status).get();
    return s.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async reports(matchId) {
    const s = await db.collection('results').where('matchId', '==', matchId).get();
    return s.docs.map(d => d.data());
  },
  async nickReqs() {
    const s = await db.collection('nickreq').where('status', '==', 'pending').get();
    return s.docs.map(d => ({ uid: d.id, ...d.data() }));
  },
  async usersWithFriend(nick) {
    const s = await db.collection('users').where('fr', 'array-contains', nick).get();
    return s.docs.map(d => ({ uid: d.id, fr: d.data().fr || [] }));
  },
  setFriends(uid, fr) { return db.collection('users').doc(uid).update({ fr }); },
  transact(fn) {
    return db.runTransaction(async t => {
      const ops = [];  // записи выполняются после всех чтений (требование Firestore)
      const tx = {
        async getMatch(id) { const s = await t.get(db.collection('matches').doc(id)); return s.exists ? { id, ...s.data() } : null; },
        async getUsers(uids) {
          const snaps = await Promise.all(uids.map(u => t.get(db.collection('users').doc(u))));
          const o = {}; snaps.forEach((s, i) => { o[uids[i]] = s.exists ? s.data() : {}; }); return o;
        },
        setMatch(id, p) { ops.push(() => t.update(db.collection('matches').doc(id), p)); },
        updateUser(uid, p) { ops.push(() => t.update(db.collection('users').doc(uid), p)); },
        // смена ника
        async getNickReq(uid) { const s = await t.get(db.collection('nickreq').doc(uid)); return s.exists ? s.data() : null; },
        async getUser(uid) { const s = await t.get(db.collection('users').doc(uid)); return s.exists ? s.data() : null; },
        async getNick(key) { const s = await t.get(db.collection('nicks').doc(key)); return s.exists ? s.data() : null; },
        setNickReq(uid, p) { ops.push(() => t.set(db.collection('nickreq').doc(uid), p, { merge: true })); },
        setNick(key, d) { ops.push(() => t.set(db.collection('nicks').doc(key), d)); },
        deleteNick(key) { ops.push(() => t.delete(db.collection('nicks').doc(key))); },
        updateGid(gid, p) { ops.push(() => t.set(db.collection('gids').doc(gid), p, { merge: true })); },
      };
      await fn(tx);
      ops.forEach(f => f());
    });
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const i = process.argv.indexOf('--loop');
  const until = i > -1 ? Date.now() + 1000 * (Number(process.argv[i + 1]) || 270) : 0;
  do {
    try {
      const log = await runPass(dbi, Date.now(), process.env.GRACE_SECONDS != null ? { grace: 1000 * Number(process.env.GRACE_SECONDS) } : {});
      if (log.done || log.voided || log.cancelled) console.log(new Date().toISOString(), JSON.stringify(log));
    } catch (e) { console.error('pass failed:', e.message); }
    if (until) await sleep(15000);
  } while (until && Date.now() < until);
  process.exit(0);
})();
