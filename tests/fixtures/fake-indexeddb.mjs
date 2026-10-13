// LOCAL model of the IndexedDB surface public/meta-pixel.js uses (open, one object store,
// a readwrite transaction with add/put). One instance stands for one origin's storage,
// shared by every tab of the browser. Like real IndexedDB, everything completes
// asynchronously, readwrite transactions on a store apply one at a time, and "add" on an
// existing key fails and aborts its transaction. It is a model, not a browser: the real
// cross-tab behaviour is proven by tests/browser/meta-pixel-browser.mjs.
const later = fn => setTimeout(fn, 0);
const request = () => ({ result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null });

export function createFakeIndexedDB({ failOpen = false } = {}) {
  const dbs = new Map();
  function makeDb(rec) {
    return {
      createObjectStore(name) {
        if (rec.stores.has(name)) throw new Error('ConstraintError');
        rec.stores.set(name, new Map());
      },
      close() {},
      transaction(name, mode) {
        const store = rec.stores.get(name);
        if (!store) throw new Error('NotFoundError');
        if (mode !== 'readwrite') throw new Error('ReadOnlyError');
        const tx = { oncomplete: null, onabort: null, onerror: null };
        const ops = [];
        const op = (r, fn) => { ops.push(() => fn(r)); return r; };
        tx.objectStore = () => ({
          add: (value, key) => op(request(), r => {
            if (store.has(key)) { r.error = new Error('ConstraintError'); r.onerror?.({ target: r }); return false; }
            store.set(key, value);
            return true;
          }),
          put: (value, key) => op(request(), () => { store.set(key, value); return true; }),
        });
        later(() => {
          const snapshot = new Map(store);
          const ok = ops.every(f => f());
          if (!ok) { store.clear(); for (const [k, v] of snapshot) store.set(k, v); }
          later(() => (ok ? tx.oncomplete?.() : tx.onabort?.()));
        });
        return tx;
      },
    };
  }
  return {
    dbs,
    open(name, version) {
      const req = request();
      later(() => {
        if (failOpen) { req.error = new Error('UnknownError'); return req.onerror?.({ target: req }); }
        let rec = dbs.get(name);
        const upgrade = !rec;
        if (!rec) { rec = { version, stores: new Map() }; dbs.set(name, rec); }
        req.result = makeDb(rec);
        if (upgrade) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}
