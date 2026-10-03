/*!
 * なかログ v0.1 — ふたりのお金を、かんたん記録。
 *
 * このファイルの構成
 *   1. 定数・ユーティリティ
 *   2. StorageAdapter … 保存処理（IndexedDB / localStorage）。UIからは直接さわらない
 *   3. Repository     … 記録の読み書き窓口。UIはここだけを使う
 *   4. 設定           … 端末ごとの設定 / 夫婦で共有する設定
 *   5. 画面（今日・カレンダー・集計・設定）
 *   6. 金額入力・修正・削除
 *   7. バックアップ / 復元 / CSV
 *   8. 起動・PWA
 *
 * 保存と同期の考え方
 *   記録の本体はいつも端末内（StorageAdapter）。画面は Repository だけを使う。
 *   同期（Sync）は Repository の外側で、未送信の変更（outbox）を送り、届いた変更を取り込む。
 *   ネットや Firebase が使えなくても、記録はこれまでどおり端末内で続けられる。
 */
(function () {
  'use strict';

  /* =====================================================
   * 1. 定数・ユーティリティ
   * ===================================================== */
  const APP_VERSION = '0.2.3';
  const MAX_DIGITS = 8; // ¥99,999,999 まで

  // 人：payer（使った人）は self / wife、for（誰のため）は self / wife / family
  const PERSON_DEFS = {
    self: { emoji: '👨', name: '夫' },
    wife: { emoji: '👩', name: '妻' },
    family: { emoji: '👪', name: '家族' },
  };
  const PAYER_IDS = ['self', 'wife'];
  const FOR_IDS = ['self', 'wife', 'family'];

  // 並び順 ＝ よく使いそうな順（上ほど押しやすい位置に出る）
  // defaultFor: 'family' = 家族のため / 'payer' = 使った人のため（あとでワンタップで変更可）
  // id は記録に保存されるので変えないこと（名前・絵文字は設定で変えられる）
  const CATEGORY_DEFS = [
    { id: 'food', emoji: '🍚', name: '食費', tone: 'orange', defaultFor: 'family' },
    { id: 'drink', emoji: '🥤', name: '飲み物', tone: 'teal', defaultFor: 'payer' },
    { id: 'daily', emoji: '🛒', name: '日用品', tone: 'yellow', defaultFor: 'family' },
    { id: 'transport', emoji: '🚃', name: '交通', tone: 'blue', defaultFor: 'payer' },
    { id: 'kids', emoji: '👶', name: '子ども', tone: 'pink', defaultFor: 'family' },
    { id: 'expense', emoji: '💼', name: '経費', tone: 'indigo', defaultFor: 'payer' },
    { id: 'meeting', emoji: '🤝', name: '打合わせ', tone: 'brown', defaultFor: 'payer' },
    { id: 'fun', emoji: '🎮', name: '娯楽', tone: 'purple', defaultFor: 'payer' },
    { id: 'clothes', emoji: '👕', name: '衣服', tone: 'sky', defaultFor: 'payer' },
    { id: 'beauty', emoji: '💇', name: '美容', tone: 'coral', defaultFor: 'payer' },
    { id: 'telecom', emoji: '📱', name: '通信費', tone: 'lime', defaultFor: 'family' },
    { id: 'utilities', emoji: '💡', name: '光熱費', tone: 'yellow', defaultFor: 'family' },
    { id: 'fixed', emoji: '🏠', name: '固定費', tone: 'green', defaultFor: 'family' },
    { id: 'tax', emoji: '🧾', name: '税金', tone: 'indigo', defaultFor: 'family' },
    { id: 'waste', emoji: '🗑️', name: 'ゴミ！', tone: 'red', defaultFor: 'payer' }, // 要らなかったと分かっている出費
    { id: 'other', emoji: '✨', name: 'その他', tone: 'gray', defaultFor: 'family' },
  ];
  const CATEGORY_IDS = CATEGORY_DEFS.map((c) => c.id);
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  const LOGO_SVG =
    '<svg class="logo" viewBox="0 0 512 512" aria-hidden="true">' +
    '<rect width="512" height="512" rx="120" fill="#F0677B"/>' +
    '<path d="M256 136 392 248h-28v128a16 16 0 0 1-16 16H164a16 16 0 0 1-16-16V248h-28z" fill="#fff" stroke="#fff" stroke-width="20" stroke-linejoin="round"/>' +
    '<path d="M256 352c-42-28-50-56-34-70 14-12 30-4 34 8 4-12 20-20 34-8 16 14 8 42-34 70z" fill="#F0677B"/>' +
    '</svg>';
  const ICON = {
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const pad2 = (n) => String(n).padStart(2, '0');
  const yen = (n) => '¥' + Math.round(n || 0).toLocaleString('ja-JP');

  function yenShort(n) {
    if (n < 100000) return yen(n);
    const man = n / 10000;
    return (man >= 100 ? Math.round(man) : Math.round(man * 10) / 10) + '万';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function dayKeyOf(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function parseDayKey(k) {
    const p = String(k).split('-').map(Number);
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
  }
  const todayKey = () => dayKeyOf(new Date());
  function addDays(k, n) {
    const d = parseDayKey(k);
    d.setDate(d.getDate() + n);
    return dayKeyOf(d);
  }
  function addMonths(m, n) {
    const d = parseDayKey(m + '-01');
    d.setMonth(d.getMonth() + n);
    return dayKeyOf(d).slice(0, 7);
  }
  function fmtMD(k) {
    const d = parseDayKey(k);
    return d.getMonth() + 1 + '月' + d.getDate() + '日（' + WEEKDAYS[d.getDay()] + '）';
  }
  const fmtYMD = (k) => parseDayKey(k).getFullYear() + '年' + fmtMD(k);
  function fmtYM(m) {
    const p = m.split('-');
    return p[0] + '年' + Number(p[1]) + '月';
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDateTimeLocal(iso) {
    const d = new Date(iso);
    return dayKeyOf(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  const nowIso = () => new Date().toISOString();
  function isoOrNull(v) {
    if (typeof v !== 'string' || !v) return null;
    const t = Date.parse(v);
    return isNaN(t) ? null : new Date(t).toISOString();
  }
  function uuid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  const toHalfDigits = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  function firstGrapheme(s) {
    s = String(s || '').trim();
    if (!s) return '';
    if (window.Intl && Intl.Segmenter) {
      const it = new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
      return it.done ? '' : it.value.segment;
    }
    return Array.from(s)[0];
  }
  function debounce(fn, ms) {
    let t = null;
    const d = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
    d.flush = (...args) => {
      clearTimeout(t);
      fn(...args);
    };
    d.cancel = () => clearTimeout(t);
    return d;
  }
  const sumAmount = (list) => list.reduce((s, t) => s + t.amount, 0);
  const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);
  const pctLabel = (part, total) => (part > 0 && pct(part, total) === 0 ? '<1%' : pct(part, total) + '%');

  /** 記録1件を安全な形にそろえる（復元ファイルなど外から来たデータにも使う） */
  function sanitizeTx(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const amount = Math.round(Number(raw.amount));
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
    const datetime = isoOrNull(raw.datetime);
    if (!datetime) return null;
    const now = nowIso();
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : uuid(),
      amount: amount,
      // 知らないカテゴリ（新しい版で増えたもの等）も消さずに残す。表示は「その他」扱い
      category: typeof raw.category === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.category) ? raw.category : 'other',
      payer: PAYER_IDS.includes(raw.payer) ? raw.payer : 'self',
      for: FOR_IDS.includes(raw.for) ? raw.for : 'family',
      datetime: datetime,
      memo: typeof raw.memo === 'string' ? raw.memo.slice(0, 200) : '',
      createdAt: isoOrNull(raw.createdAt) || now,
      updatedAt: isoOrNull(raw.updatedAt) || now,
      deletedAt: isoOrNull(raw.deletedAt), // 同期用の「削除済み」印（論理削除）
    };
  }

  /* =====================================================
   * 2. StorageAdapter（保存処理）
   *
   * どのAdapterも次のメソッドを持ちます（すべて Promise を返す）
   *   init()
   *   getTransactions()              … 全記録（削除済み印つきも含む）
   *   saveTransaction(tx)            … 追加 / 上書き
   *   updateTransaction(id, patch)   … 一部更新して、更新後の記録を返す
   *   deleteTransaction(id)          … 論理削除（deletedAt を付ける。同期で削除を伝えるため）
   *   bulkPut(list, { track })       … まとめて保存（復元・クラウドからの受信）
   *   clearAll()                     … 全記録を消す
   *   getSetting(key) / setSetting(key, value)
   *   subscribe(callback)            … 別タブで変わったら呼ばれる
   *
   *   同期用（trackChanges = true の間、変更を outbox に記録する）
   *   getOutbox() / ackOutbox(id, rev) / markAllDirty() / clearOutbox()
   * ===================================================== */
  const IDB_NAME = 'nakalog';
  const IDB_VERSION = 2; // v2: 同期用の outbox（まだクラウドへ送っていない変更の一覧）を追加
  const LS_TX_KEY = 'nakalog.v1.transactions';
  const LS_SETTINGS_KEY = 'nakalog.v1.settings';
  const LS_OUTBOX_KEY = 'nakalog.v1.outbox';

  class IndexedDBAdapter {
    constructor() {
      this.kind = 'indexeddb';
      this.label = 'この端末（IndexedDB）';
      this.db = null;
      this.listeners = new Set();
      this.channel = null;
      this.trackChanges = false; // true の間は、変更を outbox にも書く（同期中）
    }

    init() {
      return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error('IndexedDBが使えません'));
          return;
        }
        let req;
        try {
          req = indexedDB.open(IDB_NAME, IDB_VERSION);
        } catch (e) {
          reject(e);
          return;
        }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('transactions')) {
            const store = db.createObjectStore('transactions', { keyPath: 'id' });
            store.createIndex('datetime', 'datetime');
            store.createIndex('updatedAt', 'updatedAt');
          }
          if (!db.objectStoreNames.contains('settings')) {
            db.createObjectStore('settings', { keyPath: 'key' });
          }
          if (!db.objectStoreNames.contains('outbox')) {
            db.createObjectStore('outbox', { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          this.db = req.result;
          this.db.onversionchange = () => this.db.close();
          if ('BroadcastChannel' in window) {
            this.channel = new BroadcastChannel('nakalog');
            this.channel.onmessage = () => this.listeners.forEach((cb) => cb());
          }
          resolve();
        };
        req.onerror = () => reject(req.error || new Error('IndexedDBを開けませんでした'));
        // 古い版を別タブで開いていると、そのタブが閉じるまで待つ（ここで諦めると保存先が分かれてしまうため）
        req.onblocked = () => console.warn('[なかログ] 他のタブが閉じるのを待っています');
      });
    }

    /** トランザクションを実行し、完了（=ディスクへ書き込み済み）してから結果を返す */
    _run(stores, mode, work) {
      return new Promise((resolve, reject) => {
        let t;
        try {
          t = this.db.transaction(stores, mode);
        } catch (e) {
          reject(e);
          return;
        }
        const box = { result: undefined };
        try {
          work(t, box);
        } catch (e) {
          try { t.abort(); } catch (_) { /* noop */ }
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(box.result);
        t.onerror = () => reject(t.error || new Error('保存に失敗しました'));
        t.onabort = () => reject(t.error || new Error('保存が中断されました'));
      });
    }

    _changed() {
      if (this.channel) this.channel.postMessage({ type: 'changed' });
    }

    getTransactions() {
      return this._run(['transactions'], 'readonly', (t, box) => {
        const r = t.objectStore('transactions').getAll();
        r.onsuccess = () => { box.result = r.result || []; };
      });
    }

    async saveTransaction(tx) {
      const track = this.trackChanges;
      await this._run(track ? ['transactions', 'outbox'] : ['transactions'], 'readwrite', (t) => {
        t.objectStore('transactions').put(tx);
        if (track) t.objectStore('outbox').put({ id: tx.id, rev: tx.updatedAt });
      });
      this._changed();
      return tx;
    }

    async updateTransaction(id, patch) {
      const track = this.trackChanges;
      const updated = await this._run(track ? ['transactions', 'outbox'] : ['transactions'], 'readwrite', (t, box) => {
        const store = t.objectStore('transactions');
        const g = store.get(id);
        g.onsuccess = () => {
          if (!g.result) return;
          box.result = Object.assign({}, g.result, patch);
          store.put(box.result);
          if (track) t.objectStore('outbox').put({ id: id, rev: box.result.updatedAt });
        };
      });
      if (!updated) throw new Error('記録が見つかりません');
      this._changed();
      return updated;
    }

    deleteTransaction(id) {
      const now = nowIso();
      return this.updateTransaction(id, { deletedAt: now, updatedAt: now });
    }

    /** opts.track === false：クラウドから届いた変更なので outbox に入れない */
    async bulkPut(list, opts) {
      const track = this.trackChanges && !(opts && opts.track === false);
      await this._run(track ? ['transactions', 'outbox'] : ['transactions'], 'readwrite', (t) => {
        const store = t.objectStore('transactions');
        const out = track ? t.objectStore('outbox') : null;
        list.forEach((tx) => {
          store.put(tx);
          if (out) out.put({ id: tx.id, rev: tx.updatedAt });
        });
      });
      this._changed();
    }

    async clearAll() {
      await this._run(['transactions', 'outbox'], 'readwrite', (t) => {
        t.objectStore('transactions').clear();
        t.objectStore('outbox').clear();
      });
      this._changed();
    }

    /* ---- outbox（未送信の変更） ---- */
    getOutbox() {
      return this._run(['outbox'], 'readonly', (t, box) => {
        const r = t.objectStore('outbox').getAll();
        r.onsuccess = () => { box.result = r.result || []; };
      });
    }

    /** 送信済みにする。送信中にまた変更されていたら（rev が違えば）残して次回また送る */
    ackOutbox(id, rev) {
      return this._run(['outbox'], 'readwrite', (t) => {
        const store = t.objectStore('outbox');
        const g = store.get(id);
        g.onsuccess = () => {
          if (g.result && g.result.rev === rev) store.delete(id);
        };
      });
    }

    /** 同期を始めるとき：この端末の記録を全部「未送信」にする */
    markAllDirty() {
      return this._run(['transactions', 'outbox'], 'readwrite', (t) => {
        const out = t.objectStore('outbox');
        const r = t.objectStore('transactions').getAll();
        r.onsuccess = () => {
          (r.result || []).forEach((tx) => {
            if (!tx.deletedAt) out.put({ id: tx.id, rev: tx.updatedAt });
          });
        };
      });
    }

    clearOutbox() {
      return this._run(['outbox'], 'readwrite', (t) => t.objectStore('outbox').clear());
    }

    getSetting(key) {
      return this._run(['settings'], 'readonly', (t, box) => {
        const r = t.objectStore('settings').get(key);
        r.onsuccess = () => { box.result = r.result ? r.result.value : undefined; };
      });
    }

    async setSetting(key, value) {
      await this._run(['settings'], 'readwrite', (t) => t.objectStore('settings').put({ key: key, value: value }));
      if (key === 'shared') this._changed();
    }

    subscribe(cb) {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }
  }

  /** IndexedDBが使えない環境用の予備 */
  class LocalStorageAdapter {
    constructor() {
      this.kind = 'localstorage';
      this.label = 'この端末（localStorage）';
      this.listeners = new Set();
      this.trackChanges = false;
    }
    async init() {
      const k = 'nakalog.v1.__test';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      window.addEventListener('storage', (e) => {
        if (e.key === LS_TX_KEY || e.key === LS_SETTINGS_KEY) this.listeners.forEach((cb) => cb());
      });
    }
    _read() {
      try {
        return JSON.parse(localStorage.getItem(LS_TX_KEY) || '[]');
      } catch (_) {
        return [];
      }
    }
    _write(list) {
      localStorage.setItem(LS_TX_KEY, JSON.stringify(list)); // 容量不足なら例外 → 画面に保存失敗を表示
    }
    _readOutbox() {
      try {
        return JSON.parse(localStorage.getItem(LS_OUTBOX_KEY) || '{}');
      } catch (_) {
        return {};
      }
    }
    _writeOutbox(o) {
      localStorage.setItem(LS_OUTBOX_KEY, JSON.stringify(o));
    }
    _track(list) {
      if (!this.trackChanges) return;
      const o = this._readOutbox();
      list.forEach((t) => { o[t.id] = t.updatedAt; });
      this._writeOutbox(o);
    }
    async getTransactions() {
      return this._read();
    }
    async saveTransaction(tx) {
      const list = this._read().filter((t) => t.id !== tx.id);
      list.push(tx);
      this._write(list);
      this._track([tx]);
      return tx;
    }
    async updateTransaction(id, patch) {
      const list = this._read();
      const i = list.findIndex((t) => t.id === id);
      if (i < 0) throw new Error('記録が見つかりません');
      list[i] = Object.assign({}, list[i], patch);
      this._write(list);
      this._track([list[i]]);
      return list[i];
    }
    deleteTransaction(id) {
      const now = nowIso();
      return this.updateTransaction(id, { deletedAt: now, updatedAt: now });
    }
    async bulkPut(items, opts) {
      const map = new Map(this._read().map((t) => [t.id, t]));
      items.forEach((t) => map.set(t.id, t));
      this._write(Array.from(map.values()));
      if (!(opts && opts.track === false)) this._track(items);
    }
    async clearAll() {
      this._write([]);
      this._writeOutbox({});
    }
    async getOutbox() {
      const o = this._readOutbox();
      return Object.keys(o).map((id) => ({ id: id, rev: o[id] }));
    }
    async ackOutbox(id, rev) {
      const o = this._readOutbox();
      if (o[id] === rev) {
        delete o[id];
        this._writeOutbox(o);
      }
    }
    async markAllDirty() {
      const o = this._readOutbox();
      this._read().forEach((t) => { if (!t.deletedAt) o[t.id] = t.updatedAt; });
      this._writeOutbox(o);
    }
    async clearOutbox() {
      this._writeOutbox({});
    }
    _settings() {
      try {
        return JSON.parse(localStorage.getItem(LS_SETTINGS_KEY) || '{}');
      } catch (_) {
        return {};
      }
    }
    async getSetting(key) {
      return this._settings()[key];
    }
    async setSetting(key, value) {
      const s = this._settings();
      s[key] = value;
      localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(s));
    }
    subscribe(cb) {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }
  }

  /** どこにも保存できない環境（最終手段）。画面に警告を出し続ける */
  class MemoryAdapter extends LocalStorageAdapter {
    constructor() {
      super();
      this.kind = 'memory';
      this.label = '保存できません（一時的なメモリのみ）';
      this.list = [];
      this.settings = {};
      this.outbox = {};
    }
    async init() {}
    _read() {
      return this.list.slice();
    }
    _write(list) {
      this.list = list.slice();
    }
    _readOutbox() {
      return Object.assign({}, this.outbox);
    }
    _writeOutbox(o) {
      this.outbox = Object.assign({}, o);
    }
    _settings() {
      return this.settings;
    }
    async setSetting(key, value) {
      this.settings[key] = value;
    }
  }

  /** ここを差し替えればクラウド保存に切り替えられる */
  async function createAdapter() {
    const makers = [() => new IndexedDBAdapter(), () => new LocalStorageAdapter(), () => new MemoryAdapter()];
    for (const make of makers) {
      const adapter = make();
      try {
        await adapter.init();
        return adapter;
      } catch (err) {
        console.warn('[なかログ] 保存先を初期化できませんでした:', adapter.kind, err);
      }
    }
    return new MemoryAdapter();
  }

  /* =====================================================
   * 3. Repository（UIはこれだけを使う）
   * ===================================================== */
  class Repository {
    constructor(adapter) {
      this.adapter = adapter;
      this.items = new Map(); // id → 記録（削除済みも含む）
      this.list = []; // 有効な記録（新しい順）
      this.byDay = new Map(); // 'YYYY-MM-DD' → 記録[]
      this.dayOf = new Map(); // id → 'YYYY-MM-DD'
      this.listeners = new Set();
    }

    async load() {
      const all = await this.adapter.getTransactions();
      this.items = new Map();
      all.forEach((raw) => {
        const t = sanitizeTx(raw);
        if (t) this.items.set(t.id, t);
      });
      this._reindex();
    }

    _reindex() {
      const list = [];
      const ts = new Map();
      this.items.forEach((t) => {
        if (t.deletedAt) return;
        list.push(t);
        ts.set(t.id, Date.parse(t.datetime));
      });
      list.sort((a, b) => ts.get(b.id) - ts.get(a.id) || (b.createdAt > a.createdAt ? 1 : -1));
      this.list = list;
      this.byDay = new Map();
      this.dayOf = new Map();
      list.forEach((t) => {
        const k = dayKeyOf(new Date(ts.get(t.id)));
        this.dayOf.set(t.id, k);
        if (!this.byDay.has(k)) this.byDay.set(k, []);
        this.byDay.get(k).push(t);
      });
    }

    onChange(cb) {
      this.listeners.add(cb);
    }
    _emit(info) {
      this.listeners.forEach((cb) => cb(info));
    }
    _set(t) {
      this.items.set(t.id, t);
      this._reindex();
    }

    get(id) {
      const t = this.items.get(id);
      return t && !t.deletedAt ? t : null;
    }
    dayList(dayKey) {
      return this.byDay.get(dayKey) || [];
    }
    monthList(monthKey) {
      return this.list.filter((t) => this.dayOf.get(t.id).slice(0, 7) === monthKey);
    }

    async add(fields) {
      const now = nowIso();
      const tx = sanitizeTx(Object.assign({}, fields, { id: uuid(), createdAt: now, updatedAt: now, deletedAt: null }));
      if (!tx) throw new Error('記録の形が正しくありません');
      await this.adapter.saveTransaction(tx);
      this._set(tx);
      this._emit({ type: 'add', id: tx.id });
      return tx;
    }

    async update(id, patch) {
      const t = await this.adapter.updateTransaction(id, Object.assign({}, patch, { updatedAt: nowIso() }));
      this._set(sanitizeTx(t));
      this._emit({ type: 'update', id: id });
      return t;
    }

    async remove(id) {
      const t = await this.adapter.deleteTransaction(id);
      this._set(sanitizeTx(t));
      this._emit({ type: 'remove', id: id });
    }

    restore(id) {
      return this.update(id, { deletedAt: null });
    }

    /** 復元：IDごとに新しい方を残す（今ある記録は消さない） */
    async merge(rawList) {
      const toPut = [];
      let skipped = 0;
      rawList.forEach((raw) => {
        const t = sanitizeTx(raw);
        if (!t) {
          skipped++;
          return;
        }
        const cur = this.items.get(t.id);
        if (!cur || Date.parse(t.updatedAt) > Date.parse(cur.updatedAt)) toPut.push(t);
      });
      if (toPut.length) await this.adapter.bulkPut(toPut);
      toPut.forEach((t) => this.items.set(t.id, t));
      this._reindex();
      this._emit({ type: 'import' });
      return { added: toPut.length, skipped: skipped };
    }

    /**
     * クラウド（もう一方のスマホ）から届いた変更を取り込む。updatedAt が新しい方を残す。
     * 届いたものより この端末の方が新しければ、送り直す（同時に送ったときの行き違いを直す）
     */
    async applyRemote(rawList) {
      const toPut = [];
      const stale = [];
      rawList.forEach((raw) => {
        const t = sanitizeTx(raw);
        if (!t) return;
        const cur = this.items.get(t.id);
        const diff = cur ? Date.parse(t.updatedAt) - Date.parse(cur.updatedAt) : 1;
        if (diff > 0) toPut.push(t);
        else if (diff < 0) stale.push(cur);
        // 同じ変更なのにこちらだけ「その他」＝古い版がカテゴリを読めずに書き換えたもの → クラウドの方に直す
        else if (cur.category === 'other' && t.category !== 'other') toPut.push(t);
      });
      if (stale.length) await this.adapter.bulkPut(stale); // 自分の新しい方を「未送信」に戻す
      if (!toPut.length) return { applied: 0, stale: stale.length };
      await this.adapter.bulkPut(toPut, { track: false });
      toPut.forEach((t) => this.items.set(t.id, t));
      this._reindex();
      this._emit({ type: 'remote', count: toPut.length });
      return { applied: toPut.length, stale: stale.length };
    }

    async clearAll() {
      if (this.adapter.trackChanges) {
        // 同期中は「削除済みの印」を付けて送る → もう一方のスマホからも消える
        const now = nowIso();
        const list = this.list.map((t) => Object.assign({}, t, { deletedAt: now, updatedAt: now }));
        if (list.length) await this.adapter.bulkPut(list);
        list.forEach((t) => this.items.set(t.id, t));
      } else {
        await this.adapter.clearAll();
        this.items = new Map();
      }
      this._reindex();
      this._emit({ type: 'clear' });
    }
  }

  /* =====================================================
   * 4. 設定
   * ===================================================== */

  /** 端末ごとの設定（この端末を使う人・テーマなど）→ localStorage */
  const Device = {
    key: 'nakalog.device',
    data: { user: null, theme: 'auto', lastBackupAt: null, hideInstallTip: false, backupNudgeAfter: null, deviceId: null },
    load() {
      try {
        Object.assign(this.data, JSON.parse(localStorage.getItem(this.key) || '{}'));
      } catch (_) { /* 読めなくても動かす */ }
      if (!this.data.deviceId) this.set('deviceId', uuid());
    },
    set(k, v) {
      this.data[k] = v;
      try {
        localStorage.setItem(this.key, JSON.stringify(this.data));
      } catch (_) { /* 端末設定は保存できなくても記録には影響しない */ }
    },
  };

  /** 夫婦で共有する設定（予算・呼び名・カテゴリ名）→ StorageAdapter（将来はクラウドで共有） */
  const Shared = {
    data: { budget: 0, people: {}, categories: {}, updatedAt: null },
    sanitize(v) {
      if (!v || typeof v !== 'object') return null;
      return {
        budget: Math.min(999999999, Math.max(0, Math.round(Number(v.budget) || 0))),
        people: v.people && typeof v.people === 'object' ? v.people : {},
        categories: v.categories && typeof v.categories === 'object' ? v.categories : {},
        updatedAt: isoOrNull(v.updatedAt),
      };
    },
    async load(adapter) {
      const s = this.sanitize(await adapter.getSetting('shared'));
      if (s) this.data = s;
    },
    async save() {
      this.data.updatedAt = nowIso();
      await repo.adapter.setSetting('shared', this.data);
      Sync.onLocalSettings();
    },
    /** もう一方のスマホで変わった設定を取り込む（送り返さない） */
    async applyRemote(v) {
      const s = this.sanitize(v);
      if (!s) return false;
      this.data = s;
      await repo.adapter.setSetting('shared', s);
      return true;
    },
  };

  function person(id) {
    const base = PERSON_DEFS[id] || PERSON_DEFS.family;
    const custom = (Shared.data.people && Shared.data.people[id]) || {};
    return { id: id, emoji: base.emoji, name: custom.name || base.name };
  }
  function cat(id) {
    const base = CATEGORY_DEFS.find((c) => c.id === id) || CATEGORY_DEFS[CATEGORY_DEFS.length - 1];
    const custom = (Shared.data.categories && Shared.data.categories[base.id]) || {};
    return Object.assign({}, base, { name: custom.name || base.name, emoji: custom.emoji || base.emoji });
  }
  function defaultFor(catId, payer) {
    const def = CATEGORY_DEFS.find((c) => c.id === catId);
    return def && def.defaultFor === 'payer' ? payer : 'family';
  }

  function applyTheme() {
    const t = Device.data.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const dark = t === 'dark' || (t !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#111317' : '#F5F6F8');
  }

  /* =====================================================
   * 5. 画面
   * ===================================================== */
  let repo = null;

  const state = {
    tab: 'home',
    homeDay: todayKey(),
    followToday: true, // 今日を表示中なら、日付が変わったら自動で翌日に切り替える
    calMonth: todayKey().slice(0, 7),
    calDay: todayKey(),
    sumMonth: todayKey().slice(0, 7),
    sumMode: 'category',
    flashId: null,
  };

  const env = {
    ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    standalone: (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true,
  };

  function render() {
    renderDock();
    if (state.tab === 'home') renderHome();
    else if (state.tab === 'calendar') renderCalendar();
    else if (state.tab === 'summary') renderSummary();
    else if (state.tab === 'settings') renderSettings();
  }

  function switchTab(tab) {
    state.tab = tab;
    ['home', 'calendar', 'summary', 'settings'].forEach((t) => {
      document.getElementById('view-' + t).hidden = t !== tab;
    });
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- 下部：カテゴリボタン＋タブ ---------- */
  function renderDock() {
    const grid = $('#quickGrid');
    const scrollTop = grid.scrollTop; // 描き直してもスクロール位置はそのまま
    grid.innerHTML = CATEGORY_DEFS.map((d) => {
      const c = cat(d.id);
      return (
        '<button type="button" class="cat-btn tone-' + c.tone + '" data-action="open-entry" data-cat="' + c.id + '">' +
        '<span class="cat-emoji" aria-hidden="true">' + escapeHtml(c.emoji) + '</span>' +
        '<span class="cat-name">' + escapeHtml(c.name) + '</span></button>'
      );
    }).join('');
    $('#quickPanel').hidden = state.tab !== 'home';
    grid.scrollTop = scrollTop;
    updateQuickFade();
    document.querySelectorAll('.tab').forEach((b) => {
      if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  /** カテゴリ欄の下に「まだ続きがある」ぼかしを出す（いちばん下まで見たら消す） */
  function updateQuickFade() {
    const g = $('#quickGrid');
    g.classList.toggle('at-end', g.scrollTop + g.clientHeight >= g.scrollHeight - 4);
  }

  /* ---------- 共通：タイムライン ---------- */
  function timelineHtml(list) {
    const rows = list.map((t) => {
      const c = cat(t.category);
      const p = person(t.payer);
      const title = t.memo || c.name;
      const forOther = t.for !== t.payer ? person(t.for) : null;
      const label = fmtTime(t.datetime) + ' ' + p.name + ' ' + c.name + (t.memo ? ' ' + t.memo : '') + (forOther ? ' ' + forOther.name + 'のため' : '') + ' ' + yen(t.amount);
      return (
        '<li><button type="button" class="tl-item' + (t.id === state.flashId ? ' flash' : '') + '" data-action="open-edit" data-id="' + escapeHtml(t.id) + '" aria-label="' + escapeHtml(label) + '">' +
        '<span class="tl-time num">' + fmtTime(t.datetime) + '</span>' +
        '<span class="tl-who who-' + t.payer + '" aria-hidden="true">' + p.emoji + '</span>' +
        '<span class="tl-title"><span class="tl-emoji" aria-hidden="true">' + escapeHtml(c.emoji) + '</span>' +
        '<span class="tl-title-text">' + escapeHtml(title) + '</span>' +
        (forOther ? '<span class="tl-for who-' + t.for + '" aria-hidden="true">→' + escapeHtml(forOther.name) + '</span>' : '') +
        '</span>' +
        '<span class="tl-amount num">' + yen(t.amount) + '</span>' +
        '</button></li>'
      );
    });
    return '<div class="card timeline-card"><ol class="timeline">' + rows.join('') + '</ol></div>';
  }

  function budgetHtml(total) {
    const budget = Shared.data.budget || 0;
    if (!budget) return '';
    const over = total > budget;
    const ratio = Math.min(1, total / budget);
    return (
      '<div class="budget' + (over ? ' over' : '') + '">' +
      '<div class="budget-bar" role="img" aria-label="予算の' + pct(total, budget) + '%"><div class="budget-fill" style="width:' + (ratio * 100).toFixed(1) + '%"></div></div>' +
      '<div class="budget-text"><span>予算 ' + yen(budget) + '</span>' +
      (over ? '<b>予算オーバー ' + yen(total - budget) + '</b>' : '<span>残り ' + yen(budget - total) + '</span>') +
      '</div></div>'
    );
  }

  function forCardsHtml(list, total, withPct, compact) {
    const sums = { self: 0, wife: 0, family: 0 };
    list.forEach((t) => { sums[t.for] += t.amount; });
    return (
      '<div class="for-cards' + (compact ? ' compact' : '') + '">' +
      FOR_IDS.map((id) => {
        const p = person(id);
        return (
          '<div class="for-card who-' + id + '">' +
          '<span class="for-name"><span aria-hidden="true">' + p.emoji + '</span>' + escapeHtml(p.name) + '</span>' +
          '<span class="for-amount num">' + yen(sums[id]) + '</span>' +
          (withPct ? '<span class="for-pct">' + pctLabel(sums[id], total) + '</span>' : '') +
          '</div>'
        );
      }).join('') +
      '</div>'
    );
  }

  /* ---------- 今日（ホーム） ---------- */
  function bannersHtml() {
    const out = [];
    if (repo.adapter.kind === 'memory') {
      out.push(
        '<div class="banner banner-warn" role="alert"><span class="banner-text">⚠️ この環境では記録を保存できません（プライベートブラウズなど）。閉じると記録が消えます。</span></div>'
      );
    }
    if (env.ios && !env.standalone && !Device.data.hideInstallTip) {
      out.push(
        '<div class="banner"><span class="banner-text">📲 共有ボタン →「ホーム画面に追加」で、アプリのように使えます。<br><small>※Safariとホーム画面のアプリは記録が別々です</small></span>' +
        '<button type="button" class="banner-close" data-action="dismiss-install" aria-label="閉じる">×</button></div>'
      );
    }
    if (needsBackupNudge()) {
      out.push(
        '<div class="banner"><span class="banner-text">💾 しばらくバックアップしていません</span>' +
        '<button type="button" class="banner-btn" data-action="backup">バックアップ</button>' +
        '<button type="button" class="banner-close" data-action="dismiss-backup" aria-label="閉じる">×</button></div>'
      );
    }
    return out.join('');
  }

  function needsBackupNudge() {
    if (repo.list.length < 10) return false;
    const now = Date.now();
    if (Device.data.backupNudgeAfter && now < Date.parse(Device.data.backupNudgeAfter)) return false;
    const last = Device.data.lastBackupAt ? Date.parse(Device.data.lastBackupAt) : 0;
    if (last) return now - last > 30 * 864e5;
    const oldest = repo.list[repo.list.length - 1];
    return now - Date.parse(oldest.createdAt) > 14 * 864e5;
  }

  function renderHome() {
    const day = state.homeDay;
    const today = todayKey();
    const isToday = day === today;
    const month = day.slice(0, 7);
    const monthTx = repo.monthList(month);
    const total = sumAmount(monthTx);
    const dayTx = repo.dayList(day);
    const monthLabel = month === today.slice(0, 7) ? '今月' : Number(month.slice(5)) + '月';

    $('#view-home').innerHTML =
      bannersHtml() +
      '<header class="home-header">' + LOGO_SVG +
      '<div class="brand-text"><h1 class="brand-name">なかログ</h1><p class="brand-copy">ふたりのお金を、かんたん記録。</p></div>' +
      '<button type="button" id="syncChip" class="sync-chip" data-action="go-sync" hidden></button></header>' +
      '<div class="date-nav">' +
      '<button type="button" class="icon-btn" data-action="day-prev" aria-label="前の日">' + ICON.left + '</button>' +
      '<div class="date-nav-label"><span>' + fmtYMD(day) + '</span>' + (isToday ? '<span class="today-badge">今日</span>' : '') + '</div>' +
      '<button type="button" class="icon-btn" data-action="day-next" aria-label="次の日"' + (day >= today ? ' disabled' : '') + '>' + ICON.right + '</button>' +
      '</div>' +
      (isToday ? '' : '<div class="back-today"><button type="button" class="pill-btn" data-action="day-today">今日に戻る</button></div>') +
      '<section class="card month-card">' +
      '<div class="month-row"><span class="month-label">' + monthLabel + 'の家計</span><span class="month-total num">' + yen(total) + '</span></div>' +
      budgetHtml(total) +
      '<p class="mini-caption in-card">誰のための支出</p>' +
      forCardsHtml(monthTx, total, false, true) +
      '</section>' +
      '<div class="list-head"><h2>' + (isToday ? '今日の記録' : fmtMD(day) + 'の記録') + '</h2>' +
      '<span class="list-total">合計 <b class="num">' + yen(sumAmount(dayTx)) + '</b></span></div>' +
      (dayTx.length
        ? timelineHtml(dayTx)
        : '<div class="card empty"><span class="empty-big" aria-hidden="true">👇</span>' +
          (isToday ? 'まだ記録がありません。<br>下のボタンを押すと、すぐ記録できます' : 'この日の記録はありません。<br>下のボタンで、この日に記録できます') +
          '</div>');
    Sync.refresh();
    afterListRender();
  }

  function afterListRender() {
    if (!state.flashId) return;
    const el = document.querySelector('.tl-item.flash');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    state.flashId = null;
  }

  function setHomeDay(day) {
    state.homeDay = day;
    state.followToday = day === todayKey();
    renderHome();
  }

  /** 日付が変わったら（アプリを開きっぱなしでも）今日に追従 */
  function tickToday() {
    if (state.followToday && state.homeDay !== todayKey()) {
      state.homeDay = todayKey();
      if (state.tab === 'home') renderHome();
    }
  }

  /* ---------- カレンダー ---------- */
  function renderCalendar() {
    const month = state.calMonth;
    const today = todayKey();
    const first = parseDayKey(month + '-01');
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const monthTx = repo.monthList(month);
    const totals = new Map();
    monthTx.forEach((t) => {
      const k = repo.dayOf.get(t.id);
      totals.set(k, (totals.get(k) || 0) + t.amount);
    });

    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<div class="cal-blank" aria-hidden="true"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const key = month + '-' + pad2(d);
      const dow = (first.getDay() + d - 1) % 7;
      const amt = totals.get(key) || 0;
      const cls = ['cal-cell'];
      if (dow === 0) cls.push('sun');
      if (dow === 6) cls.push('sat');
      if (key === today) cls.push('today');
      if (key === state.calDay) cls.push('selected');
      cells +=
        '<button type="button" class="' + cls.join(' ') + '" data-action="cal-day" data-day="' + key + '" aria-label="' + fmtMD(key) + (amt ? ' ' + yen(amt) : ' 記録なし') + '"' + (key === state.calDay ? ' aria-pressed="true"' : '') + '>' +
        '<span class="cal-d">' + d + '</span>' + (amt ? '<span class="cal-amt">' + yenShort(amt) + '</span>' : '') +
        '</button>';
    }

    const sel = state.calDay;
    const selInMonth = sel.slice(0, 7) === month;
    const dayTx = selInMonth ? repo.dayList(sel) : [];
    $('#view-calendar').innerHTML =
      '<h1 class="page-title">カレンダー</h1>' +
      '<div class="month-nav">' +
      '<button type="button" class="icon-btn" data-action="cal-prev" aria-label="前の月">' + ICON.left + '</button>' +
      '<div class="month-nav-label">' + fmtYM(month) + '<small>合計 ' + yen(sumAmount(monthTx)) + '</small></div>' +
      '<button type="button" class="icon-btn" data-action="cal-next" aria-label="次の月">' + ICON.right + '</button>' +
      '</div>' +
      (month !== today.slice(0, 7) ? '<div class="back-today"><button type="button" class="pill-btn" data-action="cal-today">今月に戻る</button></div>' : '') +
      '<div class="card cal-card">' +
      '<div class="cal-week" aria-hidden="true">' + WEEKDAYS.map((w, i) => '<span class="' + (i === 0 ? 'sun' : i === 6 ? 'sat' : '') + '">' + w + '</span>').join('') + '</div>' +
      '<div class="cal-grid">' + cells + '</div>' +
      '</div>' +
      (selInMonth
        ? '<div class="list-head"><h2>' + fmtMD(sel) + 'の記録</h2><span class="list-total">合計 <b class="num">' + yen(sumAmount(dayTx)) + '</b></span></div>' +
          (dayTx.length ? payerSubtotalsHtml(dayTx) + timelineHtml(dayTx) : '<div class="card empty">この日の記録はありません</div>') +
          '<button type="button" class="btn btn-outline record-day-btn" data-action="record-on-day">＋ この日に記録する</button>'
        : '<div class="card empty">日付をタップすると、その日の記録が見られます</div>');
    afterListRender();
  }

  /** その日に夫・妻それぞれが使った金額（使った人ごとの小計） */
  function payerSubtotalsHtml(list) {
    return (
      '<div class="payer-subtotals" aria-label="それぞれが使った金額">' +
      PAYER_IDS.map((id) => {
        const p = person(id);
        const mine = list.filter((t) => t.payer === id);
        return (
          '<div class="payer-subtotal who-' + id + (mine.length ? '' : ' zero') + '">' +
          '<span class="payer-subtotal-name"><span aria-hidden="true">' + p.emoji + '</span>' + escapeHtml(p.name) + '</span>' +
          '<span class="payer-subtotal-amt num">' + yen(sumAmount(mine)) + '</span>' +
          '<span class="payer-subtotal-count">' + mine.length + '件</span>' +
          '</div>'
        );
      }).join('') +
      '</div>'
    );
  }

  function setCalMonth(month) {
    state.calMonth = month;
    const today = todayKey();
    state.calDay = month === today.slice(0, 7) ? today : month + '-01';
    renderCalendar();
  }

  /* ---------- 集計 ---------- */
  function renderSummary() {
    const month = state.sumMonth;
    const list = repo.monthList(month);
    const total = sumAmount(list);
    const isNow = month === todayKey().slice(0, 7);
    let rows = '';

    let foot = '';
    if (state.sumMode === 'category') {
      const sums = {};
      list.forEach((t) => {
        const k = CATEGORY_IDS.includes(t.category) ? t.category : 'other';
        sums[k] = (sums[k] || 0) + t.amount;
      });
      // 使ったカテゴリを金額の大きい順に。使っていないものは下に1行でまとめる
      const used = CATEGORY_DEFS.filter((d) => sums[d.id]).sort((a, b) => sums[b.id] - sums[a.id]);
      const unused = CATEGORY_DEFS.filter((d) => !sums[d.id]);
      if (used.length && unused.length) {
        foot = '<p class="sum-foot">記録なし：' + unused.map((d) => escapeHtml(cat(d.id).emoji + cat(d.id).name)).join('・') + '</p>';
      }
      rows = used.map((d) => {
        const c = cat(d.id);
        const v = sums[d.id] || 0;
        const w = total ? (v / total) * 100 : 0;
        return (
          '<div class="sum-row tone-' + c.tone + (v ? '' : ' zero') + '">' +
          '<span class="cat-icon" aria-hidden="true">' + escapeHtml(c.emoji) + '</span>' +
          '<div class="sum-row-main"><div class="sum-row-top"><span class="sum-row-name">' + escapeHtml(c.name) + '</span><span class="sum-row-amt num">' + yen(v) + '</span></div>' +
          '<div class="sum-row-bar"><span style="width:' + w.toFixed(1) + '%"></span></div></div>' +
          '<span class="sum-row-pct num">' + pctLabel(v, total) + '</span></div>'
        );
      }).join('') || '<div class="empty">この月の記録はありません</div>';
    } else {
      rows = PAYER_IDS.map((id) => {
        const p = person(id);
        const mine = list.filter((t) => t.payer === id);
        const v = sumAmount(mine);
        const w = total ? (v / total) * 100 : 0;
        const breakdown = FOR_IDS.map((f) => {
          const s = sumAmount(mine.filter((t) => t.for === f));
          return s ? person(f).name + 'のため ' + yen(s) : '';
        }).filter(Boolean).join(' · ');
        return (
          '<div class="sum-row who-' + id + (v ? '' : ' zero') + '">' +
          '<span class="who-icon" aria-hidden="true">' + p.emoji + '</span>' +
          '<div class="sum-row-main"><div class="sum-row-top"><span class="sum-row-name">' + escapeHtml(p.name) + '（' + mine.length + '件）</span><span class="sum-row-amt num">' + yen(v) + '</span></div>' +
          '<div class="sum-row-bar"><span style="width:' + w.toFixed(1) + '%"></span></div>' +
          (breakdown ? '<div class="sum-row-note">' + escapeHtml(breakdown) + '</div>' : '') +
          '</div>' +
          '<span class="sum-row-pct num">' + pctLabel(v, total) + '</span></div>'
        );
      }).join('');
    }

    $('#view-summary').innerHTML =
      '<h1 class="page-title">集計</h1>' +
      '<div class="month-nav">' +
      '<button type="button" class="icon-btn" data-action="sum-prev" aria-label="前の月">' + ICON.left + '</button>' +
      '<div class="month-nav-label">' + fmtYM(month) + '<small>' + list.length + '件の記録</small></div>' +
      '<button type="button" class="icon-btn" data-action="sum-next" aria-label="次の月">' + ICON.right + '</button>' +
      '</div>' +
      (isNow ? '' : '<div class="back-today"><button type="button" class="pill-btn" data-action="sum-today">今月に戻る</button></div>') +
      '<section class="card sum-total-card"><div class="month-row"><span class="month-label">' + (isNow ? '今月' : Number(month.slice(5)) + '月') + 'の家計</span>' +
      '<span class="month-total num">' + yen(total) + '</span></div>' + budgetHtml(total) + '</section>' +
      '<p class="mini-caption">誰のための支出</p>' +
      forCardsHtml(list, total, true) +
      '<div class="seg-tabs" role="group" aria-label="集計の切り替え">' +
      '<button type="button" class="seg-tab" data-action="sum-mode" data-mode="category" aria-pressed="' + (state.sumMode === 'category') + '">カテゴリ別</button>' +
      '<button type="button" class="seg-tab" data-action="sum-mode" data-mode="payer" aria-pressed="' + (state.sumMode === 'payer') + '">使った人別</button>' +
      '</div>' +
      '<div class="card sum-list">' + rows + '</div>' + foot +
      (state.sumMode === 'payer' ? '<p class="sum-foot">「使った人」＝お金を払った人。「〜のため」は誰のための支出かの内訳です。</p>' : '');
  }

  /* ---------- 設定 ---------- */
  function renderSettings() {
    const pending = $('#syncInput') ? $('#syncInput').value : '';
    renderSettingsView();
    if (pending && $('#syncInput')) {
      $('#syncInput').value = pending;
      onSyncInput();
    }
  }

  function renderSettingsView() {
    const user = Device.data.user || 'self';
    const theme = Device.data.theme || 'auto';
    const last = Device.data.lastBackupAt;
    const segUser = PAYER_IDS.map((id) => {
      const p = person(id);
      return '<button type="button" class="seg-btn who-' + id + '" data-action="set-user" data-v="' + id + '" aria-pressed="' + (id === user) + '"><span class="seg-emoji" aria-hidden="true">' + p.emoji + '</span>' + escapeHtml(p.name) + '</button>';
    }).join('');
    const themeSeg = [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']].map((t) =>
      '<button type="button" class="seg-btn" data-action="set-theme" data-v="' + t[0] + '" aria-pressed="' + (theme === t[0]) + '">' + t[1] + '</button>'
    ).join('');
    const peopleInputs = FOR_IDS.map((id) =>
      '<span class="emoji-cell" aria-hidden="true">' + PERSON_DEFS[id].emoji + '</span>' +
      '<input class="text-input" data-setting="people.' + id + '" value="' + escapeHtml(person(id).name) + '" maxlength="8" aria-label="' + PERSON_DEFS[id].name + 'の呼び名" placeholder="' + PERSON_DEFS[id].name + '">'
    ).join('');
    const catInputs = CATEGORY_DEFS.map((d) => {
      const c = cat(d.id);
      return (
        '<div class="cat-edit-row">' +
        '<input class="text-input emoji-input" data-setting="cat.' + d.id + '.emoji" value="' + escapeHtml(c.emoji) + '" aria-label="' + d.name + 'の絵文字">' +
        '<input class="text-input" data-setting="cat.' + d.id + '.name" value="' + escapeHtml(c.name) + '" maxlength="8" aria-label="' + d.name + 'の名前" placeholder="' + d.name + '">' +
        '</div>'
      );
    }).join('');

    $('#view-settings').innerHTML =
      '<h1 class="page-title">設定</h1>' +

      '<section class="set-section"><h2 class="set-title">この端末を使う人</h2>' +
      '<div class="card set-card pad"><div class="seg">' + segUser + '</div>' +
      '<p class="set-note">この端末で記録すると「使った人」が自動でこの人になります（記録のときにワンタップで変更もできます）。</p></div></section>' +

      '<section class="set-section" id="syncSection"><h2 class="set-title">夫婦で同期</h2>' + syncSectionHtml() + '</section>' +

      '<section class="set-section"><h2 class="set-title">データ管理</h2><div class="card set-card">' +
      '<dl class="storage-info">' +
      '<dt>保存先</dt><dd>' + escapeHtml(repo.adapter.label) + (Sync.cfg ? '<br>＋ クラウドで夫婦と共有' : '') + '</dd>' +
      '<dt>記録</dt><dd>' + repo.list.length.toLocaleString('ja-JP') + '件（自動保存）</dd>' +
      '<dt>最終バックアップ</dt><dd>' + (last ? fmtYMD(dayKeyOf(new Date(last))) : 'まだありません') + '</dd>' +
      '</dl>' +
      '<button type="button" class="set-row" data-action="backup"><span class="set-row-icon" aria-hidden="true">💾</span><span class="set-row-text">JSONでバックアップ<small>すべての記録を1つのファイルに保存</small></span><span class="set-row-chev" aria-hidden="true">›</span></button>' +
      '<button type="button" class="set-row" data-action="restore"><span class="set-row-icon" aria-hidden="true">📥</span><span class="set-row-text">JSONから復元<small>今ある記録は消えません</small></span><span class="set-row-chev" aria-hidden="true">›</span></button>' +
      '<button type="button" class="set-row" data-action="csv"><span class="set-row-icon" aria-hidden="true">📄</span><span class="set-row-text">CSVで書き出す<small>Excel・Numbersで開けます</small></span><span class="set-row-chev" aria-hidden="true">›</span></button>' +
      '</div><p class="set-note">' + (Sync.cfg ? '同期していても、念のため月に1回くらいバックアップしておくと安心です。' : '記録はこの端末の中だけに保存されています。機種変更や故障に備えて、月に1回くらいバックアップしておくと安心です。') + '</p></section>' +

      '<section class="set-section"><h2 class="set-title">アプリ設定</h2><div class="card set-card">' +
      '<div class="set-sub"><div class="set-sub-label">月の予算（0 なら表示しません）</div>' +
      '<div class="budget-field"><span aria-hidden="true">¥</span><input class="text-input" data-setting="budget" inputmode="numeric" pattern="[0-9]*" value="' + (Shared.data.budget || '') + '" placeholder="0" aria-label="月の予算"></div></div>' +
      '<div class="set-sub"><div class="set-sub-label">テーマ</div><div class="seg">' + themeSeg + '</div></div>' +
      '<details class="set-details set-sub"><summary><span class="set-row-icon" aria-hidden="true">✏️</span><span class="set-row-text">呼び名とカテゴリ名の変更</span><span class="set-row-chev" aria-hidden="true">›</span></summary>' +
      '<div class="set-sub-label">呼び名</div><div class="names-grid">' + peopleInputs + '</div>' +
      '<div class="set-sub-label mt-16">カテゴリ（絵文字・名前）</div>' + catInputs +
      '<p class="set-note">入力欄から離れると自動で保存されます。</p></details>' +
      '</div></section>' +

      (env.ios && !env.standalone
        ? '<section class="set-section"><h2 class="set-title">iPhoneのホーム画面に追加</h2><div class="card set-card pad">' +
          '<ol class="install-steps"><li>Safariの下にある <b>共有ボタン</b>（□に↑）をタップ</li><li><b>「ホーム画面に追加」</b>をタップ</li><li>ホーム画面の「なかログ」から開く</li></ol>' +
          '<p class="set-note">⚠️ Safariとホーム画面のアプリは記録が別々に保存されます。Safariで記録したものがあれば、先にバックアップ → アプリ側で復元してください。</p></div></section>'
        : '') +

      '<section class="set-section"><h2 class="set-title">危険な操作</h2><div class="card set-card">' +
      '<button type="button" class="set-row danger" data-action="delete-all"><span class="set-row-icon" aria-hidden="true">🗑️</span><span class="set-row-text">データをすべて削除<small>元に戻せません。先にバックアップを</small></span><span class="set-row-chev" aria-hidden="true">›</span></button>' +
      '</div></section>' +

      '<section class="set-section"><h2 class="set-title">アプリについて</h2><div class="card set-card pad"><div class="about">' + LOGO_SVG +
      '<div><b>なかログ v' + APP_VERSION.replace(/\.0$/, '') + '</b><small>ふたりのお金を、かんたん記録。</small></div></div></div></section>';
  }

  async function onSettingChange(input) {
    const key = input.dataset.setting;
    try {
      if (key === 'budget') {
        const v = Math.min(999999999, Math.max(0, parseInt(toHalfDigits(input.value).replace(/[^0-9]/g, ''), 10) || 0));
        Shared.data.budget = v;
        input.value = v || '';
      } else if (key.indexOf('people.') === 0) {
        const id = key.split('.')[1];
        const name = input.value.trim().slice(0, 8);
        Shared.data.people = Object.assign({}, Shared.data.people, { [id]: name ? { name: name } : {} });
        input.value = person(id).name;
      } else if (key.indexOf('cat.') === 0) {
        const parts = key.split('.');
        const id = parts[1];
        const field = parts[2];
        const cur = Object.assign({}, Shared.data.categories[id]);
        const v = field === 'emoji' ? firstGrapheme(input.value) : input.value.trim().slice(0, 8);
        if (v) cur[field] = v;
        else delete cur[field];
        Shared.data.categories = Object.assign({}, Shared.data.categories, { [id]: cur });
        input.value = cat(id)[field];
      }
      await Shared.save();
      renderDock();
      toast('保存しました');
    } catch (err) {
      showSaveError(err);
    }
  }

  /* ---------- トースト・エラー表示 ---------- */
  let toastTimer = null;
  let toastAction = null;
  function toast(msg, opts) {
    opts = opts || {};
    const el = $('#toast');
    el.innerHTML = '<span class="toast-msg">' + escapeHtml(msg) + '</span>' + (opts.action ? '<button type="button" class="toast-btn" data-action="toast-action">' + escapeHtml(opts.action) + '</button>' : '');
    toastAction = opts.onAction || null;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.duration || (opts.action ? 6000 : 2200));
  }
  function hideToast() {
    $('#toast').classList.remove('show');
    toastAction = null;
  }

  function showSaveError(err) {
    console.error('[なかログ]', err);
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(String(err.message)));
    $('#saveError .save-error-msg').textContent =
      '⚠️ 保存できませんでした。' + (quota ? '端末の空き容量が足りません。' : 'もう一度お試しください。') + '続く場合は設定からバックアップしてください。';
    $('#saveError').hidden = false;
  }

  /* =====================================================
   * 6. 金額入力・修正・削除
   * ===================================================== */

  /* ---------- シートの開け閉め（Androidの戻るボタンでも閉じる） ---------- */
  let openSheetId = null;
  let sheetHistoryPushed = false; // 戻るボタン用に履歴を1つ積んだか（積んだ分だけ戻す）
  function openSheet(id) {
    if (openSheetId && openSheetId !== id) closeSheet(openSheetId, 'keep');
    hideToast(); // 前のお知らせがシートの上に重ならないように
    const el = document.getElementById(id);
    openSheetId = id;
    el.hidden = false;
    void el.offsetWidth; // アニメーションのため
    el.classList.add('open');
    document.body.classList.add('sheet-open');
    $('#app').inert = true;
    $('#dock').inert = true;
    if (!sheetHistoryPushed) {
      try {
        history.pushState({ nakalogSheet: true }, '');
        sheetHistoryPushed = true;
      } catch (_) { /* noop */ }
    }
    el.querySelector('.sheet-panel').focus({ preventScroll: true });
  }
  // mode: 'pop' = 戻るボタンで閉じた / 'keep' = 別のシートに切り替える（履歴はそのまま）
  function closeSheet(id, mode) {
    const el = document.getElementById(id);
    if (!el || !el.classList.contains('open')) return; // 2回呼ばれても1回分だけ動く
    if (openSheetId === id) openSheetId = null;
    if (el.contains(document.activeElement)) document.activeElement.blur();
    el.classList.remove('open');
    document.body.classList.remove('sheet-open');
    $('#app').inert = false;
    $('#dock').inert = false;
    setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 300);
    if (sheetHistoryPushed && mode !== 'keep') {
      sheetHistoryPushed = false;
      if (mode !== 'pop') history.back();
    }
  }
  window.addEventListener('popstate', () => {
    if (openSheetId) closeSheet(openSheetId, 'pop');
  });

  /* ---------- 金額入力 ---------- */
  const entry = { cat: 'food', amount: '', payer: 'self', for: 'family', forTouched: false, memo: '', day: todayKey(), useNow: true, freq: [], busy: false };

  function openEntry(catId) {
    entry.cat = catId;
    entry.amount = '';
    entry.payer = Device.data.user || 'self';
    entry.for = defaultFor(catId, entry.payer);
    entry.forTouched = false;
    entry.memo = '';
    entry.day = state.homeDay;
    entry.useNow = entry.day === todayKey();
    entry.freq = frequentFor(catId);
    renderEntry();
    openSheet('entrySheet');
  }

  /** 最近よく使う「金額＋メモ」の組み合わせ（いつもの電車 ¥220 など） */
  function frequentFor(catId) {
    const since = Date.now() - 180 * 864e5;
    const groups = new Map();
    for (const t of repo.list) {
      if (Date.parse(t.datetime) < since) break; // 新しい順なのでここで打ち切り
      if (t.category !== catId) continue;
      const key = t.amount + '\u0000' + (t.memo || '');
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { amount: t.amount, memo: t.memo || '', for: t.for, count: 1, order: groups.size });
    }
    return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.order - b.order).slice(0, 4);
  }

  function renderEntry() {
    const c = cat(entry.cat);
    $('#entryCat').innerHTML = '<span class="cat-icon tone-' + c.tone + '" aria-hidden="true">' + escapeHtml(c.emoji) + '</span><span>' + escapeHtml(c.name) + '</span>';
    const dayEl = $('#entryDay');
    const isToday = entry.day === todayKey();
    dayEl.textContent = isToday ? '今日 ' + fmtMD(entry.day) : '📅 ' + fmtMD(entry.day) + ' に記録';
    dayEl.classList.toggle('warn', !isToday);
    $('#entryFreq').innerHTML = entry.freq.length
      ? '<span class="freq-label">いつもの</span>' +
        entry.freq.map((f, i) => '<button type="button" class="chip" data-action="freq" data-i="' + i + '">' + escapeHtml((f.memo ? f.memo + ' ' : '') + yen(f.amount)) + '</button>').join('')
      : '';
    $('#entryFreq').hidden = !entry.freq.length;
    renderEntryWho();
    $('#entryMemo').value = entry.memo;
    setEntryHint('');
    updateEntryAmount();
  }

  function segHtml(ids, selected, action) {
    return ids.map((id) => {
      const p = person(id);
      return '<button type="button" class="seg-btn who-' + id + '" data-action="' + action + '" data-v="' + id + '" aria-pressed="' + (id === selected) + '"><span class="seg-emoji" aria-hidden="true">' + p.emoji + '</span>' + escapeHtml(p.name) + '</button>';
    }).join('');
  }
  function renderEntryWho() {
    $('#entryPayer').innerHTML = segHtml(PAYER_IDS, entry.payer, 'entry-payer');
    $('#entryFor').innerHTML = segHtml(FOR_IDS, entry.for, 'entry-for');
  }

  function updateEntryAmount() {
    const v = parseInt(entry.amount || '0', 10);
    const num = $('#entryAmountNum');
    num.textContent = v.toLocaleString('ja-JP');
    num.classList.toggle('zero', !v);
    $('#entryDone').setAttribute('aria-disabled', v ? 'false' : 'true');
    $('#entryDone').setAttribute('aria-label', v ? yen(v) + 'で記録する' : '完了（金額を入力してください）');
    document.querySelectorAll('#entryFreq .chip').forEach((chip) => {
      const f = entry.freq[Number(chip.dataset.i)];
      chip.classList.toggle('on', !!f && f.amount === v && f.memo === entry.memo);
    });
    if (v) setEntryHint('');
  }

  function setEntryHint(msg) {
    $('#entryHint').textContent = msg;
  }
  function shakeAmount() {
    const el = $('.entry-amount');
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  function pressKey(k) {
    if (k === 'back') entry.amount = entry.amount.slice(0, -1);
    else if (k === 'clear') entry.amount = '';
    else if (/^\d$/.test(k)) {
      if (entry.amount === '' && k === '0') return;
      if (entry.amount.length >= MAX_DIGITS) {
        shakeAmount();
        return;
      }
      entry.amount += k;
    }
    updateEntryAmount();
  }

  function quickAdd(n) {
    const v = Math.min(parseInt(entry.amount || '0', 10) + n, Math.pow(10, MAX_DIGITS) - 1);
    entry.amount = String(v);
    updateEntryAmount();
  }

  function useFrequent(i) {
    const f = entry.freq[i];
    if (!f) return;
    entry.amount = String(f.amount);
    entry.memo = f.memo;
    entry.for = f.for;
    entry.forTouched = true;
    $('#entryMemo').value = f.memo;
    renderEntryWho();
    updateEntryAmount();
  }

  function entryDatetime() {
    if (entry.useNow) return nowIso();
    const now = new Date();
    const d = parseDayKey(entry.day);
    d.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
    return d.toISOString();
  }

  async function entryDone() {
    const amount = parseInt(entry.amount || '0', 10);
    if (!amount) {
      shakeAmount();
      setEntryHint('金額を入力してください');
      return;
    }
    if (entry.busy) return;
    entry.busy = true;
    try {
      const tx = await repo.add({
        amount: amount,
        category: entry.cat,
        payer: entry.payer,
        for: entry.for,
        datetime: entryDatetime(),
        memo: $('#entryMemo').value.trim(),
      });
      state.flashId = tx.id;
      closeSheet('entrySheet');
      render();
      const c = cat(tx.category);
      toast(c.emoji + ' ' + c.name + ' ' + yen(amount) + ' を記録しました', { action: '取り消す', onAction: () => undoAdd(tx.id) });
      if (navigator.vibrate) navigator.vibrate(12);
      requestPersist();
    } catch (err) {
      setEntryHint('保存できませんでした。もう一度「完了」を押してください');
      showSaveError(err);
    } finally {
      entry.busy = false;
    }
  }

  async function undoAdd(id) {
    await repo.remove(id);
    toast('取り消しました');
  }

  /* ---------- 修正（履歴をタップしたときだけ開く） ---------- */
  const edit = { id: null };
  let statusTimer = null;

  function openEdit(id) {
    if (!repo.get(id)) return;
    edit.id = id;
    renderEdit();
    $('#editStatus').textContent = '変更はすぐ保存されます';
    $('#editStatus').classList.remove('saved');
    openSheet('editSheet');
  }

  function renderEdit() {
    const t = repo.get(edit.id);
    if (!t) return;
    const d = new Date(t.datetime);
    $('#editDate').value = dayKeyOf(d);
    $('#editTime').value = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    renderEditCat(t);
    if (document.activeElement !== $('#editAmount')) $('#editAmount').value = String(t.amount);
    if (document.activeElement !== $('#editMemo')) $('#editMemo').value = t.memo || '';
    $('#editPayer').innerHTML = segHtml(PAYER_IDS, t.payer, 'edit-payer');
    $('#editFor').innerHTML = segHtml(FOR_IDS, t.for, 'edit-for');
  }

  function renderEditCat(t) {
    const c = cat(t.category);
    const btn = $('#editCatBtn');
    btn.className = 'edit-cat tone-' + c.tone;
    btn.innerHTML = '<span class="cat-icon" aria-hidden="true">' + escapeHtml(c.emoji) + '</span><span>' + escapeHtml(c.name) + '</span><span class="edit-cat-change">カテゴリを変える ›</span>';
    $('#editCatPicker').innerHTML = CATEGORY_DEFS.map((d) => {
      const x = cat(d.id);
      return '<button type="button" class="cat-pick tone-' + x.tone + '" data-action="edit-cat" data-cat="' + x.id + '" aria-pressed="' + (x.id === t.category) + '"><span class="cat-pick-emoji" aria-hidden="true">' + escapeHtml(x.emoji) + '</span>' + escapeHtml(x.name) + '</button>';
    }).join('');
  }

  function toggleEditCats(force) {
    const picker = $('#editCatPicker');
    const open = typeof force === 'boolean' ? force : picker.hidden;
    picker.hidden = !open;
    $('#editCatBtn').setAttribute('aria-expanded', String(open));
  }

  async function saveEdit(patch) {
    const id = edit.id;
    if (!id || !repo.get(id)) return;
    try {
      await repo.update(id, patch);
      if (edit.id === id) {
        renderEdit();
        const s = $('#editStatus');
        s.textContent = '✓ 保存しました';
        s.classList.add('saved');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
          s.textContent = '変更はすぐ保存されます';
          s.classList.remove('saved');
        }, 1800);
      }
    } catch (err) {
      showSaveError(err);
      renderEdit();
    }
  }

  function commitEditAmount(revertIfEmpty) {
    const t = repo.get(edit.id);
    if (!t) return;
    const input = $('#editAmount');
    const v = parseInt(input.value, 10);
    if (!v || v < 1) {
      if (revertIfEmpty) input.value = String(t.amount); // 空や0で確定したら元に戻す（記録は消さない）
      return;
    }
    if (v !== t.amount) saveEdit({ amount: v });
  }
  const saveAmountSoon = debounce(commitEditAmount, 700);

  function commitEditMemo() {
    const t = repo.get(edit.id);
    if (!t) return;
    const v = $('#editMemo').value.trim().slice(0, 60);
    if (v !== (t.memo || '')) saveEdit({ memo: v });
  }
  const saveMemoSoon = debounce(commitEditMemo, 700);

  function commitEditWhen() {
    const t = repo.get(edit.id);
    if (!t) return;
    const date = $('#editDate').value;
    const time = $('#editTime').value || '12:00';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      renderEdit();
      return;
    }
    const d = parseDayKey(date);
    const hm = time.split(':').map(Number);
    d.setHours(hm[0] || 0, hm[1] || 0, new Date(t.datetime).getSeconds(), 0);
    if (isNaN(d.getTime())) return;
    if (d.toISOString() !== t.datetime) saveEdit({ datetime: d.toISOString() });
  }

  function flushEditInputs() {
    saveAmountSoon.cancel();
    saveMemoSoon.cancel();
    commitEditAmount(true);
    commitEditMemo();
  }

  function closeEdit() {
    flushEditInputs();
    toggleEditCats(false);
    closeSheet('editSheet');
  }

  async function deleteCurrent() {
    const id = edit.id;
    saveAmountSoon.cancel();
    saveMemoSoon.cancel();
    if (!id) return;
    try {
      await repo.remove(id);
      toggleEditCats(false);
      closeSheet('editSheet');
      edit.id = null;
      toast('削除しました', {
        action: '元に戻す',
        duration: 7000,
        onAction: async () => {
          await repo.restore(id);
          state.flashId = id;
          render();
          toast('元に戻しました');
        },
      });
    } catch (err) {
      showSaveError(err);
    }
  }

  async function duplicateCurrent() {
    flushEditInputs();
    const t = repo.get(edit.id);
    if (!t) return;
    try {
      const tx = await repo.add({ amount: t.amount, category: t.category, payer: t.payer, for: t.for, memo: t.memo, datetime: nowIso() });
      toggleEditCats(false);
      closeSheet('editSheet');
      state.flashId = tx.id;
      if (state.tab === 'home' && !state.followToday) setHomeDay(todayKey());
      render();
      toast('今日 ' + fmtTime(tx.datetime) + ' にもう一度記録しました', { action: '取り消す', onAction: () => undoAdd(tx.id) });
    } catch (err) {
      showSaveError(err);
    }
  }

  /* =====================================================
   * 7. バックアップ / 復元 / CSV
   * ===================================================== */
  function fileStamp() {
    const d = new Date();
    return dayKeyOf(d) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /** スマホは共有シート（「ファイルに保存」など）、PCは通常のダウンロード */
  async function deliverFile(name, content, mime) {
    const blob = new Blob([content], { type: mime });
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.canShare && typeof File === 'function') {
      try {
        const file = new File([blob], name, { type: mime });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          return true;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return false; // 共有をキャンセル
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }

  async function doBackup() {
    const data = {
      app: 'nakalog',
      format: 1,
      version: APP_VERSION,
      exportedAt: nowIso(),
      count: repo.list.length,
      settings: Shared.data,
      transactions: repo.list.slice().reverse(), // 古い順
    };
    const ok = await deliverFile('nakalog-backup-' + fileStamp() + '.json', JSON.stringify(data, null, 2), 'application/json');
    if (ok) {
      Device.set('lastBackupAt', nowIso());
      Device.set('backupNudgeAfter', null);
      render();
      toast('バックアップを作成しました（' + repo.list.length + '件）');
    }
  }

  async function handleRestoreFile(file) {
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      alert('このファイルは読み込めませんでした。\nなかログのバックアップ（.json）を選んでください。');
      return;
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.transactions) ? data.transactions : null;
    if (!list) {
      alert('なかログのバックアップファイルではないようです。');
      return;
    }
    const when = data.exportedAt ? '\n（' + fmtYMD(dayKeyOf(new Date(data.exportedAt))) + ' のバックアップ）' : '';
    if (!confirm(list.length + '件の記録を読み込みます。' + when + '\n\n今ある記録は消えません。同じ記録は新しい方を残します。')) return;
    try {
      const res = await repo.merge(list);
      if (data.settings && typeof data.settings === 'object') {
        await Shared.load({ getSetting: async () => data.settings });
        await Shared.save();
      }
      render();
      toast(res.added + '件を復元しました' + (res.skipped ? '（読めない' + res.skipped + '件はスキップ）' : ''));
    } catch (err) {
      showSaveError(err);
    }
  }

  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 表計算ソフトで式として実行されないように
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function doCsv() {
    const rows = [['日付', '時刻', '曜日', 'カテゴリ', '金額', '使った人', '誰のため', 'メモ', 'ID', '作成日時', '更新日時']];
    repo.list.slice().reverse().forEach((t) => {
      const d = new Date(t.datetime);
      rows.push([
        dayKeyOf(d), fmtTime(t.datetime), WEEKDAYS[d.getDay()], cat(t.category).name, t.amount,
        person(t.payer).name, person(t.for).name, t.memo || '', t.id, fmtDateTimeLocal(t.createdAt), fmtDateTimeLocal(t.updatedAt),
      ]);
    });
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    deliverFile('nakalog-' + fileStamp() + '.csv', csv, 'text/csv').then((ok) => {
      if (ok) toast('CSVを書き出しました（' + repo.list.length + '件）');
    });
  }

  async function deleteAll() {
    const n = repo.list.length;
    const where = Sync.cfg ? '\n同期中なので、もう一方のスマホからも消えます。' : '';
    if (!confirm('すべての記録（' + n + '件）を削除します。' + where + '\n元に戻せません。先に「JSONでバックアップ」することをおすすめします。\n\n本当に削除しますか？')) return;
    if (!confirm('最終確認：本当にすべて削除しますか？')) return;
    try {
      await repo.clearAll();
      render();
      toast('すべての記録を削除しました');
    } catch (err) {
      showSaveError(err);
    }
  }

  /* ストレージを「消されにくく」する（対応ブラウザのみ） */
  let persistAsked = false;
  async function requestPersist() {
    if (persistAsked) return;
    persistAsked = true;
    try {
      if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (_) { /* 非対応でも問題なし */ }
  }

  /* =====================================================
   * 8. 夫婦で同期（Firebase / Cloud Firestore）
   *
   *   - 記録はこれまでどおり端末内（IndexedDB）が本体。クラウドにはその写しを置いて共有する
   *   - ネットがなくても記録でき、つながったときに未送信分（outbox）を送る
   *   - 同じ記録が両方のスマホで変更されたら、updatedAt が新しい方を残す
   *   - 受信は「前回受け取ったところ（cursor）以降」だけを読むので、記録が増えても通信量が増えにくい
   *   - Firebase のプログラムは同期を使うときだけ読み込む（使わない人には影響なし）
   * ===================================================== */
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  const INVITE_PREFIX = 'nakalog-invite:';
  const TX_FIELDS = ['id', 'amount', 'category', 'payer', 'for', 'datetime', 'memo', 'createdAt', 'updatedAt', 'deletedAt'];

  function b64urlEncode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
  }
  function randomId(bytes) {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return b64urlEncode(String.fromCharCode.apply(null, b));
  }

  /** Firebaseコンソールからコピーした設定（前後に余計な文字があってもOK）を読み取る */
  function parseFirebaseConfig(text) {
    const out = {};
    const re = /(apiKey|authDomain|projectId|appId|emulatorHost)["']?\s*:\s*["']([^"'\s]+)["']/g;
    let m;
    while ((m = re.exec(String(text)))) out[m[1]] = m[2];
    if (!out.apiKey || !out.projectId || !out.appId) return null;
    if (!out.authDomain) out.authDomain = out.projectId + '.firebaseapp.com';
    return out;
  }
  /** 招待コード ＝ Firebaseの接続先 ＋ 夫婦の共有ID */
  function makeInvite(cfg) {
    const f = cfg.firebase;
    const o = { v: 1, k: f.apiKey, d: f.authDomain, p: f.projectId, a: f.appId, h: cfg.householdId };
    if (f.emulatorHost) o.e = f.emulatorHost;
    return INVITE_PREFIX + b64urlEncode(JSON.stringify(o));
  }
  function parseInvite(text) {
    const m = String(text).replace(/\s+/g, '').match(/nakalog-invite:([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      const o = JSON.parse(b64urlDecode(m[1]));
      if (o.v !== 1 || !o.k || !o.p || !o.a || !o.h) return null;
      const firebase = { apiKey: o.k, authDomain: o.d || o.p + '.firebaseapp.com', projectId: o.p, appId: o.a };
      if (o.e) firebase.emulatorHost = o.e;
      return { firebase: firebase, householdId: o.h };
    } catch (_) {
      return null;
    }
  }
  /** 貼り付けられた内容が「招待コード」か「Firebaseの設定」かを見分ける */
  function readSyncInput(text) {
    const inv = parseInvite(text);
    if (inv) return { mode: 'join', cfg: inv };
    const fb = parseFirebaseConfig(text);
    if (fb) return { mode: 'create', cfg: { firebase: fb, householdId: randomId(16) } };
    return null;
  }

  function toRemote(t, m) {
    const o = {};
    TX_FIELDS.forEach((k) => { o[k] = t[k] === undefined ? null : t[k]; });
    o.serverUpdatedAt = m.serverTimestamp();
    return o;
  }
  function fromRemote(d) {
    const o = {};
    TX_FIELDS.forEach((k) => { o[k] = d[k]; });
    return o;
  }

  function isNetworkError(err) {
    const code = String((err && err.code) || '');
    const msg = String((err && err.message) || err || '');
    return /unavailable|deadline-exceeded|network-request-failed/.test(code) ||
      /offline|network|Failed to fetch|dynamically imported module|Importing a module script failed|Load failed/i.test(msg);
  }
  function syncErrorMessage(err) {
    const code = String((err && err.code) || '') + ' ' + String((err && err.message) || '');
    if (/operation-not-allowed|admin-restricted/.test(code)) return 'Firebaseの「Authentication」で「匿名」ログインを有効にしてください。';
    if (/api-key|invalid-api-key|API key/i.test(code)) return '貼り付けたFirebaseの設定が正しくないようです。もう一度コピーしてください。';
    if (/permission-denied|insufficient permissions/i.test(code)) return 'Firestoreの「ルール」が設定されていないか、招待コードが違います。';
    if (/nakalog\/not-found/.test(code)) return '共有が見つかりません。招待コードをもう一度コピーしてください。';
    if (/not-found|NOT_FOUND/.test(code)) return 'Firestore Database がまだ作られていないようです。';
    if (isNetworkError(err)) return 'ネットにつながっていません。つながってからもう一度お試しください。';
    return '同期できませんでした（' + String((err && (err.code || err.message)) || err) + '）';
  }

  const Sync = {
    cfg: null, // { firebase: {...}, householdId }
    sdk: null,
    fb: null, // { app, auth, db, m }
    phase: 'off', // off | connecting | live | waiting（ネット待ち） | error
    error: '',
    serverConnected: null,
    pendingCount: 0,
    cursor: 0,
    settingsDirty: false,
    devices: {},
    unsub: [],
    pushing: false,
    pushAgain: false,
    pushTimer: null,
    retryTimer: null,
    cursorTimer: null,

    /** 起動時：同期の設定があれば、変更の記録（outbox）を有効にする。接続は start() で */
    async init() {
      const a = repo.adapter;
      const cfg = await a.getSetting('sync');
      if (!cfg || !cfg.firebase || !cfg.householdId) return;
      this.cfg = cfg;
      this.cursor = Number(await a.getSetting('sync.cursor')) || 0;
      this.settingsDirty = !!(await a.getSetting('sync.settingsDirty'));
      if (!(await a.getSetting('sync.repairCategories'))) {
        // v0.2.0 は知らないカテゴリを「その他」に書き換えて保存していたので、
        // 一度だけクラウドから全部読み直して直す（夫婦2人分なら読み込みはすぐ終わる）
        this.cursor = 0;
        await a.setSetting('sync.cursor', 0);
        await a.setSetting('sync.repairCategories', 1);
      }
      a.trackChanges = true;
    },

    async loadSdk() {
      if (!this.sdk) {
        const mods = await Promise.all(['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map((f) => import(FIREBASE_SDK + f)));
        this.sdk = { app: mods[0], auth: mods[1], fs: mods[2] };
      }
      return this.sdk;
    },

    async connect() {
      const sdk = await this.loadSdk();
      if (!this.fb) {
        const c = this.cfg.firebase;
        const app = sdk.app.initializeApp({ apiKey: c.apiKey, authDomain: c.authDomain, projectId: c.projectId, appId: c.appId }, 'nakalog');
        const auth = sdk.auth.initializeAuth(app, { persistence: [sdk.auth.indexedDBLocalPersistence, sdk.auth.browserLocalPersistence] });
        const db = sdk.fs.initializeFirestore(app, {});
        if (c.emulatorHost === '127.0.0.1' || c.emulatorHost === 'localhost') {
          // 開発用：この端末のエミュレーターにだけつなげる（他のホストは無視）
          sdk.auth.connectAuthEmulator(auth, 'http://' + c.emulatorHost + ':9099', { disableWarnings: true });
          sdk.fs.connectFirestoreEmulator(db, c.emulatorHost, 8080);
        }
        this.fb = { app: app, auth: auth, db: db, m: sdk.fs };
      }
      await this.fb.auth.authStateReady();
      if (!this.fb.auth.currentUser) await sdk.auth.signInAnonymously(this.fb.auth);
      return this.fb;
    },

    hRef() {
      return this.fb.m.doc(this.fb.db, 'households', this.cfg.householdId);
    },
    col() {
      return this.fb.m.collection(this.fb.db, 'households', this.cfg.householdId, 'transactions');
    },

    /** mode: 'create'（新しく始める） / 'join'（招待コードで参加） / 省略（いつもの起動） */
    async start(mode) {
      if (!this.cfg) return;
      this.stopListening();
      clearTimeout(this.retryTimer);
      this.phase = 'connecting';
      this.error = '';
      this.refresh();
      try {
        await this.connect();
        const m = this.fb.m;
        if (mode === 'create') {
          if (!Shared.data.updatedAt) Shared.data.updatedAt = nowIso();
          await m.setDoc(this.hRef(), { app: 'nakalog', createdAt: m.serverTimestamp(), settings: Shared.data, settingsUpdatedAt: Shared.data.updatedAt });
        } else if (mode === 'join') {
          const snap = await m.getDoc(this.hRef());
          if (!snap.exists()) throw Object.assign(new Error('共有が見つかりません'), { code: 'nakalog/not-found' });
          const d = snap.data();
          if (d.settings) await Shared.applyRemote(Object.assign({}, d.settings, { updatedAt: d.settingsUpdatedAt || nowIso() }));
        }
        if (mode) await repo.adapter.markAllDirty(); // この端末にあった記録も共有する
        this.listen();
        this.phase = 'live';
        this.updatePresence();
        this.schedulePush(0);
      } catch (err) {
        this.handleError(err);
        if (mode) throw err;
      } finally {
        this.refresh();
      }
    },

    listen() {
      const m = this.fb.m;
      this.serverConnected = null;
      const q = m.query(this.col(), m.where('serverUpdatedAt', '>=', m.Timestamp.fromMillis(this.cursor)), m.orderBy('serverUpdatedAt'));
      this.unsub.push(m.onSnapshot(q, { includeMetadataChanges: true }, (snap) => this.onTxSnap(snap), (err) => this.onListenError(err)));
      this.unsub.push(m.onSnapshot(this.hRef(), (snap) => this.onHouseSnap(snap), (err) => this.onListenError(err)));
    },
    stopListening() {
      this.unsub.forEach((u) => { try { u(); } catch (_) { /* noop */ } });
      this.unsub = [];
    },
    onListenError(err) {
      this.stopListening();
      this.phase = 'waiting';
      this.handleError(err);
      if (this.phase !== 'error') this.retryLater();
      this.refresh();
    },

    onTxSnap(snap) {
      this.serverConnected = !snap.metadata.fromCache;
      const list = [];
      let max = this.cursor;
      snap.docChanges().forEach((ch) => {
        if (ch.type === 'removed') return;
        const d = ch.doc.data();
        if (!d.serverUpdatedAt || typeof d.serverUpdatedAt.toMillis !== 'function') return; // 自分の送信中のもの
        max = Math.max(max, d.serverUpdatedAt.toMillis());
        list.push(fromRemote(d));
      });
      const done = (res) => {
        this.setCursor(max);
        if (res && res.stale) this.schedulePush(0);
      };
      if (list.length) repo.applyRemote(list).then(done).catch(showSaveError);
      else done();
      this.refresh();
    },

    onHouseSnap(snap) {
      if (!snap.exists()) return;
      const d = snap.data();
      this.devices = d.devices || {};
      const remoteAt = Date.parse(d.settingsUpdatedAt || '') || 0;
      const localAt = Date.parse(Shared.data.updatedAt || '') || 0;
      if (d.settings && remoteAt > localAt && !this.settingsDirty) {
        Shared.applyRemote(Object.assign({}, d.settings, { updatedAt: d.settingsUpdatedAt }))
          .then((ok) => { if (ok) render(); })
          .catch(() => {});
      }
      this.refresh();
    },

    setCursor(ms) {
      if (ms <= this.cursor) return;
      this.cursor = ms;
      clearTimeout(this.cursorTimer);
      this.cursorTimer = setTimeout(() => repo.adapter.setSetting('sync.cursor', this.cursor).catch(() => {}), 800);
    },

    updatePresence() {
      if (!this.fb || this.phase !== 'live') return;
      const m = this.fb.m;
      const me = {};
      me[Device.data.deviceId] = { user: Device.data.user || 'self', lastSeen: m.serverTimestamp() };
      m.setDoc(this.hRef(), { devices: me }, { merge: true }).catch(() => {});
    },

    onLocalSettings() {
      if (!this.cfg) return;
      this.settingsDirty = true;
      repo.adapter.setSetting('sync.settingsDirty', true).catch(() => {});
      this.schedulePush(0);
    },

    schedulePush(delay) {
      if (!this.cfg) return;
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.push(), delay == null ? 400 : delay);
      this.countPending();
    },
    async countPending() {
      try {
        this.pendingCount = (await repo.adapter.getOutbox()).length;
      } catch (_) { /* noop */ }
      this.refresh();
    },
    retryLater() {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this.phase === 'live') this.schedulePush(0);
        else if (this.phase === 'waiting') this.start().catch(() => {});
      }, 20000);
    },

    /** 未送信の変更を送る。クラウドの方が新しい記録は上書きしない */
    async push() {
      if (!this.cfg || this.phase !== 'live' || !navigator.onLine) {
        this.countPending();
        return;
      }
      if (this.pushing) {
        this.pushAgain = true;
        return;
      }
      this.pushing = true;
      this.refresh();
      try {
        const m = this.fb.m;
        const outbox = await repo.adapter.getOutbox();
        this.pendingCount = outbox.length;
        for (let i = 0; i < outbox.length; i += 30) {
          const chunk = outbox.slice(i, i + 30);
          const remote = await m.getDocsFromServer(m.query(this.col(), m.where(m.documentId(), 'in', chunk.map((e) => e.id))));
          const remoteAt = new Map();
          remote.forEach((s) => remoteAt.set(s.id, Date.parse(s.get('updatedAt')) || 0));
          const batch = m.writeBatch(this.fb.db);
          let writes = 0;
          chunk.forEach((e) => {
            const t = this.localTx(e.id);
            if (!t) return;
            if (remoteAt.has(t.id) && remoteAt.get(t.id) > Date.parse(t.updatedAt)) return; // クラウドの方が新しい
            batch.set(m.doc(this.col(), t.id), toRemote(t, m));
            writes++;
          });
          if (writes) await batch.commit();
          for (const e of chunk) await repo.adapter.ackOutbox(e.id, e.rev);
          this.pendingCount = Math.max(0, this.pendingCount - chunk.length);
          this.refresh();
        }
        if (this.settingsDirty) {
          await m.updateDoc(this.hRef(), { settings: Shared.data, settingsUpdatedAt: Shared.data.updatedAt || nowIso() });
          this.settingsDirty = false;
          await repo.adapter.setSetting('sync.settingsDirty', false);
        }
      } catch (err) {
        this.handleError(err);
        if (this.phase !== 'error') this.retryLater();
      } finally {
        this.pushing = false;
        if (this.pushAgain) {
          this.pushAgain = false;
          this.schedulePush(0);
        } else {
          this.countPending();
        }
      }
    },

    localTx(id) {
      return repo.items.get(id) || null; // 削除済みの印が付いたものも送る
    },

    handleError(err) {
      console.warn('[なかログ] 同期:', err);
      if (isNetworkError(err)) {
        if (this.phase !== 'live') this.phase = 'waiting';
        return;
      }
      this.phase = 'error';
      this.error = syncErrorMessage(err);
    },

    /** 設定画面から：Firebaseの設定（はじめる） or 招待コード（参加する） */
    async begin(parsed) {
      const a = repo.adapter;
      this.cfg = parsed.cfg;
      this.cursor = 0;
      this.settingsDirty = false;
      a.trackChanges = true;
      await a.setSetting('sync.repairCategories', 1); // 最初から全部読むので直しは不要
      try {
        await this.start(parsed.mode);
        await a.setSetting('sync', this.cfg); // つながったときだけ保存する
      } catch (err) {
        const msg = syncErrorMessage(err);
        await this.leave();
        throw new Error(msg);
      }
    },

    async leave() {
      this.stopListening();
      clearTimeout(this.pushTimer);
      clearTimeout(this.retryTimer);
      clearTimeout(this.cursorTimer);
      if (this.fb && this.sdk) {
        try { await this.sdk.app.deleteApp(this.fb.app); } catch (_) { /* noop */ }
      }
      this.fb = null;
      this.cfg = null;
      this.phase = 'off';
      this.error = '';
      this.cursor = 0;
      this.settingsDirty = false;
      this.devices = {};
      this.pendingCount = 0;
      const a = repo.adapter;
      a.trackChanges = false;
      await a.setSetting('sync', null);
      await a.setSetting('sync.cursor', 0);
      await a.setSetting('sync.settingsDirty', false);
      await a.clearOutbox();
      this.refresh();
    },

    status() {
      if (!this.cfg) return { key: 'off', label: '' };
      if (this.phase === 'error') return { key: 'error', label: '⚠️ 同期エラー' };
      if (this.phase === 'connecting' || (this.phase === 'live' && this.serverConnected === null && navigator.onLine)) {
        return { key: 'busy', label: '☁️ つないでいます' };
      }
      const offline = !navigator.onLine || this.phase === 'waiting' || !this.serverConnected;
      if (offline) {
        return this.pendingCount
          ? { key: 'pending', label: '⏳ 未送信 ' + this.pendingCount + '件' }
          : { key: 'offline', label: '📴 オフライン' };
      }
      if (this.pendingCount || this.pushing) return { key: 'busy', label: '🔄 同期中' };
      return { key: 'ok', label: '☁️ 同期済み' };
    },

    /** 画面の同期表示だけを書き換える（全体を描き直さない） */
    refresh() {
      const s = this.status();
      const chip = document.getElementById('syncChip');
      if (chip) {
        chip.hidden = s.key === 'off';
        chip.textContent = s.label;
        chip.className = 'sync-chip sync-' + s.key;
      }
      const box = document.getElementById('syncStatus');
      if (box) box.innerHTML = syncStatusHtml();
    },
  };

  function syncStatusHtml() {
    const s = Sync.status();
    const users = [];
    Object.keys(Sync.devices || {}).forEach((k) => {
      const u = Sync.devices[k] && Sync.devices[k].user;
      if (PAYER_IDS.includes(u) && !users.includes(u)) users.push(u);
    });
    users.sort((a, b) => PAYER_IDS.indexOf(a) - PAYER_IDS.indexOf(b));
    let note = '';
    if (s.key === 'error') note = Sync.error;
    else if (s.key === 'pending' || s.key === 'offline') note = 'ネットにつながったら自動で送ります。記録はこのまま続けられます。';
    return (
      '<div class="sync-state sync-' + s.key + '">' + escapeHtml(s.label) + '</div>' +
      (note ? '<p class="set-note">' + escapeHtml(note) + '</p>' : '') +
      (s.key === 'error' ? '<button type="button" class="btn btn-outline mt-8" data-action="sync-retry">もう一度つなぐ</button>' : '') +
      '<p class="set-note">つながっている人：' +
      (users.length ? users.map((u) => person(u).emoji + ' ' + escapeHtml(person(u).name)).join('・') : 'まだ確認中です') +
      (users.length === 1 ? '<br>もう一方のスマホで、下の招待コードを貼り付けてください。' : '') +
      '</p>'
    );
  }

  function syncSectionHtml() {
    if (!Sync.cfg) {
      return (
        '<div class="card set-card pad">' +
        '<p class="set-text">ふたりのスマホで、同じ記録が見られるようになります。</p>' +
        '<ol class="install-steps">' +
        '<li>はじめる人：Firebaseの設定を貼り付けて「はじめる」<br><small>（準備のしかたは README の「夫婦で同期する」）</small></li>' +
        '<li>もう一人：届いた<b>招待コード</b>を貼り付けて「参加する」</li>' +
        '</ol>' +
        '<textarea id="syncInput" class="text-input sync-input" rows="4" placeholder="ここに「Firebaseの設定」か「招待コード」を貼り付け" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>' +
        '<p id="syncDetect" class="set-note" aria-live="polite"></p>' +
        '<button type="button" id="syncGo" class="btn btn-primary mt-8" data-action="sync-go" disabled>つなぐ</button>' +
        '<p class="set-note">この端末の記録も、ふたりの記録に加わります。</p>' +
        '</div>'
      );
    }
    const invite = makeInvite(Sync.cfg);
    return (
      '<div class="card set-card pad">' +
      '<div id="syncStatus">' + syncStatusHtml() + '</div>' +
      '<div class="set-sub-label mt-16">招待コード（もう一方のスマホに貼り付け）</div>' +
      '<div class="invite-code" id="inviteCode">' + escapeHtml(invite) + '</div>' +
      '<div class="invite-actions">' +
      '<button type="button" class="btn btn-soft" data-action="invite-copy">コピー</button>' +
      '<button type="button" class="btn btn-soft" data-action="invite-share">LINEなどで送る</button>' +
      '</div>' +
      '<p class="set-note">⚠️ 招待コードを知っている人は、ふたりの記録を見られます。夫婦以外には送らないでください。</p>' +
      '<button type="button" class="set-row danger" data-action="sync-leave"><span class="set-row-icon" aria-hidden="true">⛔</span><span class="set-row-text">この端末の同期をやめる<small>この端末の記録はそのまま残ります</small></span></button>' +
      '</div>'
    );
  }

  function onSyncInput() {
    const input = $('#syncInput');
    const btn = $('#syncGo');
    if (!input || !btn) return;
    const r = input.value.trim() ? readSyncInput(input.value) : null;
    const detect = $('#syncDetect');
    if (!input.value.trim()) {
      detect.textContent = '';
      btn.textContent = 'つなぐ';
    } else if (!r) {
      detect.textContent = '読み取れませんでした。コピーした内容を、そのまま全部貼り付けてください。';
      btn.textContent = 'つなぐ';
    } else if (r.mode === 'join') {
      detect.textContent = '✓ 招待コードを読み取りました';
      btn.textContent = '参加する';
    } else {
      detect.textContent = '✓ Firebaseの設定を読み取りました（プロジェクト：' + r.cfg.firebase.projectId + '）';
      btn.textContent = 'はじめる';
    }
    btn.disabled = !r;
  }

  async function syncGo() {
    const input = $('#syncInput');
    const parsed = input ? readSyncInput(input.value) : null;
    if (!parsed) return;
    const btn = $('#syncGo');
    btn.disabled = true;
    btn.textContent = 'つないでいます…';
    try {
      await Sync.begin(parsed);
      renderSettings();
      toast(parsed.mode === 'join' ? '参加しました。ふたりの記録が届きます' : '同期を始めました。招待コードを送ってください');
    } catch (err) {
      btn.disabled = false;
      onSyncInput();
      $('#syncDetect').textContent = '⚠️ ' + err.message;
    }
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* noop */ }
      ta.remove();
      return ok;
    }
  }

  async function shareInvite() {
    const invite = makeInvite(Sync.cfg);
    const text = 'なかログの招待コードです。\nなかログの「設定 → 夫婦で同期」に、このメッセージをそのまま貼り付けてください。\n\n' + invite;
    if (navigator.share) {
      try {
        await navigator.share({ text: text });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    if (await copyText(text)) toast('コピーしました。LINEなどに貼り付けて送ってください');
  }

  /* =====================================================
   * 9. イベント・起動
   * ===================================================== */
  function showOnboarding() {
    $('#obChoices').innerHTML = PAYER_IDS.map((id) => {
      const p = person(id);
      return '<button type="button" class="ob-choice who-' + id + '" data-action="onboard" data-v="' + id + '"><span class="ob-emoji" aria-hidden="true">' + p.emoji + '</span>' + escapeHtml(p.name) + '</button>';
    }).join('');
    $('#obInstall').hidden = !(env.ios && !env.standalone);
    $('#onboarding').hidden = false;
    $('#app').inert = true;
    $('#dock').inert = true;
  }

  const actions = {
    tab: (el) => switchTab(el.dataset.tab),
    'day-prev': () => setHomeDay(addDays(state.homeDay, -1)),
    'day-next': () => setHomeDay(addDays(state.homeDay, 1) > todayKey() ? todayKey() : addDays(state.homeDay, 1)),
    'day-today': () => setHomeDay(todayKey()),

    'open-entry': (el) => openEntry(el.dataset.cat),
    'close-entry': () => closeSheet('entrySheet'),
    key: (el) => {
      if (el.dataset.key === 'back' && longPressFired) {
        longPressFired = false; // 長押しで全消し済み
        return;
      }
      pressKey(el.dataset.key);
    },
    'quick-add': (el) => quickAdd(Number(el.dataset.add)),
    freq: (el) => useFrequent(Number(el.dataset.i)),
    'entry-payer': (el) => {
      entry.payer = el.dataset.v;
      if (!entry.forTouched) entry.for = defaultFor(entry.cat, entry.payer);
      renderEntryWho();
    },
    'entry-for': (el) => {
      entry.for = el.dataset.v;
      entry.forTouched = true;
      renderEntryWho();
    },
    'entry-done': () => entryDone(),

    'open-edit': (el) => openEdit(el.dataset.id),
    'close-edit': () => closeEdit(),
    'delete-edit': () => deleteCurrent(),
    'duplicate-edit': () => duplicateCurrent(),
    'toggle-edit-cats': () => toggleEditCats(),
    'edit-cat': (el) => {
      toggleEditCats(false);
      saveEdit({ category: el.dataset.cat });
    },
    'edit-payer': (el) => saveEdit({ payer: el.dataset.v }),
    'edit-for': (el) => saveEdit({ for: el.dataset.v }),

    'cal-prev': () => setCalMonth(addMonths(state.calMonth, -1)),
    'cal-next': () => setCalMonth(addMonths(state.calMonth, 1)),
    'cal-today': () => setCalMonth(todayKey().slice(0, 7)),
    'cal-day': (el) => {
      state.calDay = el.dataset.day;
      renderCalendar();
    },
    'record-on-day': () => {
      state.homeDay = state.calDay;
      state.followToday = state.calDay === todayKey();
      switchTab('home');
    },

    'sum-prev': () => { state.sumMonth = addMonths(state.sumMonth, -1); renderSummary(); },
    'sum-next': () => { state.sumMonth = addMonths(state.sumMonth, 1); renderSummary(); },
    'sum-today': () => { state.sumMonth = todayKey().slice(0, 7); renderSummary(); },
    'sum-mode': (el) => { state.sumMode = el.dataset.mode; renderSummary(); },

    'set-user': (el) => {
      Device.set('user', el.dataset.v);
      Sync.updatePresence();
      renderSettings();
      toast('この端末を「' + person(el.dataset.v).name + '」にしました');
    },
    'set-theme': (el) => {
      Device.set('theme', el.dataset.v);
      applyTheme();
      renderSettings();
    },
    backup: () => doBackup(),
    restore: () => {
      const input = $('#restoreInput');
      input.value = '';
      input.click();
    },
    csv: () => doCsv(),
    'delete-all': () => deleteAll(),

    onboard: (el) => {
      Device.set('user', el.dataset.v);
      $('#onboarding').hidden = true;
      $('#app').inert = false;
      $('#dock').inert = false;
      render();
    },
    'dismiss-install': () => {
      Device.set('hideInstallTip', true);
      renderHome();
    },
    'dismiss-backup': () => {
      Device.set('backupNudgeAfter', new Date(Date.now() + 7 * 864e5).toISOString());
      renderHome();
    },
    'toast-action': () => {
      const fn = toastAction;
      hideToast();
      if (fn) Promise.resolve(fn()).catch(showSaveError);
    },
    'close-save-error': () => { $('#saveError').hidden = true; },

    'go-sync': () => {
      switchTab('settings');
      const sec = $('#syncSection');
      if (sec) sec.scrollIntoView({ block: 'start' });
    },
    'sync-go': () => syncGo(),
    'sync-retry': () => { Sync.start().catch(() => {}); },
    'sync-leave': async () => {
      if (!confirm('この端末の同期をやめますか？\nこの端末の記録はそのまま残ります。もう一方のスマホの記録も消えません。\nあとで招待コードを貼り付ければ、また同期できます。')) return;
      await Sync.leave();
      renderSettings();
      toast('同期をやめました');
    },
    'invite-copy': async () => {
      if (await copyText(makeInvite(Sync.cfg))) toast('招待コードをコピーしました');
    },
    'invite-share': () => shareInvite(),
  };

  let longPressTimer = null;
  let longPressFired = false;

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || el.disabled) return;
      const fn = actions[el.dataset.action];
      if (fn) fn(el, e);
    });

    // ⌫ 長押しで金額を全部消す
    const back = document.querySelector('.key-back');
    back.addEventListener('pointerdown', () => {
      longPressFired = false;
      clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        pressKey('clear');
        if (navigator.vibrate) navigator.vibrate(20);
      }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => back.addEventListener(ev, () => clearTimeout(longPressTimer)));
    back.addEventListener('contextmenu', (e) => e.preventDefault());

    // 入力欄
    $('#entryMemo').addEventListener('input', (e) => { entry.memo = e.target.value; });
    $('#editAmount').addEventListener('input', (e) => {
      const clean = toHalfDigits(e.target.value).replace(/[^0-9]/g, '').replace(/^0+/, '').slice(0, MAX_DIGITS);
      if (clean !== e.target.value) e.target.value = clean;
      saveAmountSoon();
    });
    $('#editAmount').addEventListener('blur', () => saveAmountSoon.flush(true));
    $('#editMemo').addEventListener('input', () => saveMemoSoon());
    $('#editMemo').addEventListener('blur', () => saveMemoSoon.flush());
    $('#editDate').addEventListener('change', commitEditWhen);
    $('#editTime').addEventListener('change', commitEditWhen);
    ['editAmount', 'editMemo'].forEach((id) => {
      $('#' + id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    });

    document.addEventListener('change', (e) => {
      if (e.target.matches && e.target.matches('[data-setting]')) onSettingChange(e.target);
    });
    document.addEventListener('input', (e) => {
      if (e.target && e.target.id === 'syncInput') onSyncInput();
    });
    window.addEventListener('online', () => {
      if (!Sync.cfg) return;
      if (Sync.phase === 'live') Sync.schedulePush(0);
      else if (Sync.phase === 'waiting') Sync.start().catch(() => {});
      Sync.refresh();
    });
    window.addEventListener('offline', () => Sync.refresh());
    $('#restoreInput').addEventListener('change', (e) => handleRestoreFile(e.target.files && e.target.files[0]));

    // PCのキーボードでも入力できる
    document.addEventListener('keydown', (e) => {
      if (openSheetId === 'entrySheet') {
        if (e.target && e.target.id === 'entryMemo') {
          if (e.key === 'Enter' && !e.isComposing) {
            e.preventDefault();
            if (parseInt(entry.amount || '0', 10)) entryDone();
            else e.target.blur();
          }
          return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const k = toHalfDigits(e.key);
        if (/^[0-9]$/.test(k)) { pressKey(k); e.preventDefault(); }
        else if (e.key === 'Backspace') { pressKey('back'); e.preventDefault(); }
        else if (e.key === 'Enter') { entryDone(); e.preventDefault(); }
        else if (e.key === 'Escape') closeSheet('entrySheet');
      } else if (openSheetId === 'editSheet' && e.key === 'Escape') {
        closeEdit();
      }
    });

    // iOSで:activeの見た目を効かせる
    document.addEventListener('touchstart', () => {}, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      tickToday();
      if (Sync.phase === 'live') {
        Sync.schedulePush(0);
        Sync.updatePresence();
      }
    });
    setInterval(tickToday, 30000);
    if (window.matchMedia) {
      const mq = matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    }

    $('#quickGrid').addEventListener('scroll', updateQuickFade, { passive: true });

    // 下部の高さを測って、内容が隠れないようにする
    const dock = $('#dock');
    const setDockH = () => document.documentElement.style.setProperty('--dock-h', dock.offsetHeight + 'px');
    if (window.ResizeObserver) new ResizeObserver(setDockH).observe(dock);
    window.addEventListener('resize', setDockH);
    setDockH();
  }

  function onDataChange() {
    if (openSheetId === 'editSheet' && edit.id && !repo.get(edit.id)) closeSheet('editSheet');
    render();
  }

  /** 以前localStorageに保存された記録があれば、IndexedDBへ引っ越す */
  async function migrateFromLocalStorage(adapter) {
    if (adapter.kind !== 'indexeddb') return;
    let raw = null;
    try { raw = localStorage.getItem(LS_TX_KEY); } catch (_) { return; }
    if (!raw) return;
    const list = JSON.parse(raw);
    if (Array.isArray(list) && list.length) {
      const current = new Map((await adapter.getTransactions()).map((t) => [t.id, t]));
      const toPut = list.map(sanitizeTx).filter((t) => t && (!current.has(t.id) || t.updatedAt > current.get(t.id).updatedAt));
      if (toPut.length) await adapter.bulkPut(toPut);
    }
    localStorage.setItem(LS_TX_KEY + '.migrated', raw); // 念のため控えを残す
    localStorage.removeItem(LS_TX_KEY);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const okOrigin = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!okOrigin) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' }).catch((err) => console.warn('[なかログ] Service Worker 登録失敗', err));
    });
  }

  async function boot() {
    Device.load();
    applyTheme();
    $('.ob-logo').innerHTML = LOGO_SVG;
    registerServiceWorker();

    const adapter = await createAdapter();
    repo = new Repository(adapter);
    try { await Sync.init(); } catch (err) { console.warn('[なかログ] 同期設定の読み込み失敗', err); }
    try { await migrateFromLocalStorage(adapter); } catch (err) { console.warn('[なかログ] 引っ越し失敗', err); }
    try { await Shared.load(adapter); } catch (err) { console.warn('[なかログ] 設定の読み込み失敗', err); }
    try {
      await repo.load();
    } catch (err) {
      showSaveError(err);
    }
    repo.onChange(onDataChange);
    repo.onChange((info) => { if (info.type !== 'remote') Sync.schedulePush(); });
    // 別のタブ（将来はもう一方のスマホ）で変更があったら読み直す
    adapter.subscribe(async () => {
      try {
        await repo.load();
        await Shared.load(adapter);
        onDataChange();
      } catch (err) {
        console.warn(err);
      }
    });

    bindEvents();
    render();
    if (!Device.data.user) showOnboarding();
    if (env.standalone) requestPersist();
    if (Sync.cfg) Sync.start().catch(() => {}); // 画面を出してから、裏でつなぐ

    // 動作確認用（開発者ツールから window.nakalog で中身を見られる）
    window.nakalog = { version: APP_VERSION, repo: repo, state: state, sync: Sync };
  }

  boot();
})();
