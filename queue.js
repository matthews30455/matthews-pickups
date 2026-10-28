// Outbox on the phone (IndexedDB): pickups saved while offline wait here until sent.
const DB = "matthews-pickups", STORE = "outbox";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "client_id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then((r) => { out = r; });
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const outbox = {
  put: (item) => tx("readwrite", (s) => wrap(s.put(item))),
  all: () => tx("readonly", (s) => wrap(s.getAll())),
  remove: (id) => tx("readwrite", (s) => wrap(s.delete(id))),
};
