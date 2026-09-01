const DB_NAME = "travel-webapp-render-cache";
const DB_VERSION = 1;
const STORE_NAME = "tripRenderCache";
const MAX_TRIPS_PER_USER = 6;
const WRITE_DEBOUNCE_MS = 450;

function clean(value) { return String(value ?? "").trim(); }
function cacheKey(uid, tripId) { return `${clean(uid)}::${clean(tripId)}`; }

let dbPromise = null;
let queuedWriteTimer = 0;
const queuedWrites = new Map();

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      const error = new Error("IndexedDB unavailable");
      error.code = "indexeddb-unavailable";
      reject(error);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("uid", "uid", { unique: false });
        store.createIndex("savedAt", "savedAt", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        try { db.close(); } catch (error) {}
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error("Unable to open render cache"));
    };
    request.onblocked = () => {
      // Keep waiting for the browser to release an older handle. Render cache is
      // acceleration only, so callers already tolerate open failures.
    };
  });
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

function validTripData(data, tripId) {
  if (!data || typeof data !== "object") return false;
  const id = clean(data.tripId || data?.meta?.tripId || data?.meta?.expenses?.tripId);
  return !!id && id === clean(tripId) && Array.isArray(data.days);
}

async function pruneUserCache(db, uid) {
  const readTx = db.transaction(STORE_NAME, "readonly");
  const rows = await requestResult(readTx.objectStore(STORE_NAME).index("uid").getAll(clean(uid)));
  const sorted = (Array.isArray(rows) ? rows : []).sort((a, b) => Number(b?.savedAt || 0) - Number(a?.savedAt || 0));
  const stale = sorted.slice(MAX_TRIPS_PER_USER).filter(row => row?.key);
  if (!stale.length) return;
  const deleteTx = db.transaction(STORE_NAME, "readwrite");
  const store = deleteTx.objectStore(STORE_NAME);
  stale.forEach(row => store.delete(row.key));
  await transactionDone(deleteTx);
}

async function writeRecords(records) {
  if (!records.length) return true;
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const now = Date.now();
  records.forEach(record => {
    store.put({
      key: cacheKey(record.uid, record.tripId),
      uid: record.uid,
      tripId: record.tripId,
      revision: Number(record.data?.revision) || 0,
      savedAt: now,
      data: record.data
    });
  });
  await transactionDone(tx);
  for (const uid of new Set(records.map(record => record.uid))) {
    await pruneUserCache(db, uid);
  }
  return true;
}

export async function readTripRenderCache(uidInput, tripIdInput) {
  const uid = clean(uidInput);
  const tripId = clean(tripIdInput);
  if (!uid || !tripId) return null;

  // If the latest state is queued but not committed yet, it is already a valid
  // warm-boot candidate for this tab and avoids an unnecessary IndexedDB read.
  const queued = queuedWrites.get(cacheKey(uid, tripId));
  if (queued && validTripData(queued.data, tripId)) {
    return {
      data: queued.data,
      tripId,
      uid,
      revision: Number(queued.data?.revision) || 0,
      savedAt: Number(queued.queuedAt) || Date.now()
    };
  }

  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const record = await requestResult(tx.objectStore(STORE_NAME).get(cacheKey(uid, tripId)));
  if (!record || !validTripData(record.data, tripId)) return null;
  return {
    data: record.data,
    tripId,
    uid,
    revision: Number(record.revision) || Number(record.data?.revision) || 0,
    savedAt: Number(record.savedAt) || 0
  };
}

export async function writeTripRenderCache(uidInput, tripIdInput, data) {
  const uid = clean(uidInput);
  const tripId = clean(tripIdInput);
  if (!uid || !tripId || !validTripData(data, tripId)) return false;
  try {
    await writeRecords([{ uid, tripId, data }]);
    return true;
  } catch (error) {
    console.warn("Trip render cache write skipped", error);
    return false;
  }
}

export function queueTripRenderCacheWrite(uidInput, tripIdInput, data, { delayMs = WRITE_DEBOUNCE_MS } = {}) {
  const uid = clean(uidInput);
  const tripId = clean(tripIdInput);
  if (!uid || !tripId || !validTripData(data, tripId)) return Promise.resolve(false);
  const key = cacheKey(uid, tripId);

  return new Promise(resolve => {
    const current = queuedWrites.get(key);
    const resolvers = current?.resolvers || [];
    resolvers.push(resolve);
    queuedWrites.set(key, { uid, tripId, data, queuedAt: Date.now(), resolvers });
    clearTimeout(queuedWriteTimer);
    queuedWriteTimer = setTimeout(() => {
      flushTripRenderCacheWrites().catch(() => {});
    }, Math.max(0, Number(delayMs) || WRITE_DEBOUNCE_MS));
  });
}

export async function flushTripRenderCacheWrites() {
  clearTimeout(queuedWriteTimer);
  queuedWriteTimer = 0;
  if (!queuedWrites.size) return true;

  const batch = [...queuedWrites.values()];
  queuedWrites.clear();
  let ok = false;
  try {
    await writeRecords(batch);
    ok = true;
  } catch (error) {
    console.warn("Trip render cache batch write skipped", error);
  }
  batch.forEach(record => record.resolvers.forEach(resolve => {
    try { resolve(ok); } catch (error) {}
  }));
  return ok;
}

export async function deleteTripRenderCache(uidInput, tripIdInput) {
  const uid = clean(uidInput);
  const tripId = clean(tripIdInput);
  if (!uid || !tripId) return false;
  const key = cacheKey(uid, tripId);
  const pending = queuedWrites.get(key);
  if (pending) {
    queuedWrites.delete(key);
    pending.resolvers.forEach(resolve => { try { resolve(false); } catch (error) {} });
  }
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    await transactionDone(tx);
    return true;
  } catch (error) {
    console.warn("Trip render cache delete skipped", error);
    return false;
  }
}
