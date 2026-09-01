/*
 * v7.9.2.2 · Phase 3A Media Cache Safari Transaction Hardening
 *
 * Trip media blobs are cached separately from Firestore's own persistence.
 * This cache is best-effort only: Firebase Storage remains authoritative.
 */

const MEDIA_CACHE_DB = "travel-trip-media-cache-v1";
const MEDIA_CACHE_STORE = "media";
const MEDIA_CACHE_DB_VERSION = 1;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000;

let databasePromise = null;
const memoryLastAccessedAt = new Map();

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") {
    databasePromise = Promise.resolve(null);
    return databasePromise;
  }
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(MEDIA_CACHE_DB, MEDIA_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(MEDIA_CACHE_STORE)) {
        const store = database.createObjectStore(MEDIA_CACHE_STORE, { keyPath: "storagePath" });
        store.createIndex("tripId", "tripId", { unique: false });
        store.createIndex("lastAccessedAt", "lastAccessedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open media cache"));
  }).catch(error => {
    console.warn("Trip media cache unavailable; continuing without IndexedDB media cache", error);
    return null;
  });
  return databasePromise;
}

export async function getTripMediaCache(storagePathInput, { generation = "" } = {}) {
  const storagePath = clean(storagePathInput);
  if (!storagePath) return null;
  const database = await openDatabase();
  if (!database) return null;
  try {
    const readTransaction = database.transaction(MEDIA_CACHE_STORE, "readonly");
    const readDone = transactionDone(readTransaction);
    const record = await requestPromise(readTransaction.objectStore(MEDIA_CACHE_STORE).get(storagePath));
    await readDone;
    if (!record?.blob) return null;
    const expectedGeneration = clean(generation);
    if (expectedGeneration && clean(record.generation) && clean(record.generation) !== expectedGeneration) {
      await removeTripMediaCache(storagePath);
      return null;
    }

    // Do not rewrite the whole cached Blob merely to touch LRU metadata.
    // Safari/iOS can duplicate large Blob IO here, which is especially costly
    // during a second Full Backup when every media item is already cached.
    // Keep the hot-session access time in memory and leave the persisted Blob
    // untouched. Persistent pruning can still fall back to cachedAt.
    const accessedAt = Date.now();
    memoryLastAccessedAt.set(storagePath, accessedAt);

    return {
      blob: record.blob,
      storagePath,
      generation: clean(record.generation),
      contentType: clean(record.contentType || record.blob?.type),
      byteSize: finiteNumber(record.byteSize || record.blob?.size),
      tripId: clean(record.tripId),
      mediaId: clean(record.mediaId),
      variant: clean(record.variant || "display"),
      cachedAt: finiteNumber(record.cachedAt),
      lastAccessedAt: Math.max(finiteNumber(record.lastAccessedAt), finiteNumber(memoryLastAccessedAt.get(storagePath)))
    };
  } catch (error) {
    console.warn("Unable to read Trip media cache", error);
    return null;
  }
}

export async function putTripMediaCache(storagePathInput, blob, {
  generation = "",
  contentType = "",
  tripId = "",
  mediaId = "",
  variant = "display"
} = {}) {
  const storagePath = clean(storagePathInput);
  if (!storagePath || !(blob instanceof Blob)) return false;
  const database = await openDatabase();
  if (!database) return false;
  try {
    const now = Date.now();
    const transaction = database.transaction(MEDIA_CACHE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(MEDIA_CACHE_STORE).put({
      storagePath,
      blob,
      generation: clean(generation),
      contentType: clean(contentType || blob.type),
      byteSize: finiteNumber(blob.size),
      tripId: clean(tripId),
      mediaId: clean(mediaId),
      variant: clean(variant || "display"),
      cachedAt: now,
      lastAccessedAt: now
    });
    await done;
    memoryLastAccessedAt.set(storagePath, now);
    return true;
  } catch (error) {
    console.warn("Unable to write Trip media cache", error);
    return false;
  }
}

export async function removeTripMediaCache(storagePathInput) {
  const storagePath = clean(storagePathInput);
  if (!storagePath) return false;
  const database = await openDatabase();
  if (!database) return false;
  try {
    const transaction = database.transaction(MEDIA_CACHE_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(MEDIA_CACHE_STORE).delete(storagePath);
    await done;
    memoryLastAccessedAt.delete(storagePath);
    return true;
  } catch (error) {
    console.warn("Unable to remove Trip media cache entry", error);
    return false;
  }
}

export async function clearTripMediaCache({ tripId = "" } = {}) {
  const database = await openDatabase();
  if (!database) return 0;
  const safeTripId = clean(tripId);
  try {
    if (!safeTripId) {
      const countTransaction = database.transaction(MEDIA_CACHE_STORE, "readonly");
      const countDone = transactionDone(countTransaction);
      const count = await requestPromise(countTransaction.objectStore(MEDIA_CACHE_STORE).count());
      await countDone;
      const clearTransaction = database.transaction(MEDIA_CACHE_STORE, "readwrite");
      const clearDone = transactionDone(clearTransaction);
      clearTransaction.objectStore(MEDIA_CACHE_STORE).clear();
      await clearDone;
      memoryLastAccessedAt.clear();
      return finiteNumber(count);
    }

    const readTransaction = database.transaction(MEDIA_CACHE_STORE, "readonly");
    const readTransactionDone = transactionDone(readTransaction);
    const records = await requestPromise(readTransaction.objectStore(MEDIA_CACHE_STORE).getAll());
    await readTransactionDone;
    const paths = records
      .filter(record => clean(record?.tripId) === safeTripId)
      .map(record => clean(record?.storagePath))
      .filter(Boolean);
    if (!paths.length) return 0;
    const deleteTransaction = database.transaction(MEDIA_CACHE_STORE, "readwrite");
    const deleteDone = transactionDone(deleteTransaction);
    const store = deleteTransaction.objectStore(MEDIA_CACHE_STORE);
    paths.forEach(path => store.delete(path));
    await deleteDone;
    paths.forEach(path => memoryLastAccessedAt.delete(path));
    return paths.length;
  } catch (error) {
    console.warn("Unable to clear Trip media cache", error);
    return 0;
  }
}

export async function pruneTripMediaCache({
  maxBytes = DEFAULT_MAX_BYTES,
  maxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  const database = await openDatabase();
  if (!database) return { deleted: 0, bytesFreed: 0, remainingBytes: 0 };
  const budget = Math.max(8 * 1024 * 1024, finiteNumber(maxBytes, DEFAULT_MAX_BYTES));
  const ageLimit = Math.max(24 * 60 * 60 * 1000, finiteNumber(maxAgeMs, DEFAULT_MAX_AGE_MS));
  try {
    const readTransaction = database.transaction(MEDIA_CACHE_STORE, "readonly");
    const readTransactionDone = transactionDone(readTransaction);
    const records = await requestPromise(readTransaction.objectStore(MEDIA_CACHE_STORE).getAll());
    await readTransactionDone;

    const now = Date.now();
    let totalBytes = records.reduce((sum, record) => sum + finiteNumber(record?.byteSize || record?.blob?.size), 0);
    let bytesFreed = 0;
    const paths = new Set();
    const markForDelete = record => {
      const path = clean(record?.storagePath);
      if (!path || paths.has(path)) return;
      paths.add(path);
      const bytes = finiteNumber(record?.byteSize || record?.blob?.size);
      totalBytes = Math.max(0, totalBytes - bytes);
      bytesFreed += bytes;
    };

    records
      .filter(record => now - Math.max(finiteNumber(record?.lastAccessedAt || record?.cachedAt), finiteNumber(memoryLastAccessedAt.get(clean(record?.storagePath)))) > ageLimit)
      .forEach(markForDelete);

    if (totalBytes > budget) {
      const candidates = records
        .filter(record => !paths.has(clean(record?.storagePath)))
        .sort((a, b) => Math.max(finiteNumber(a?.lastAccessedAt || a?.cachedAt), finiteNumber(memoryLastAccessedAt.get(clean(a?.storagePath)))) - Math.max(finiteNumber(b?.lastAccessedAt || b?.cachedAt), finiteNumber(memoryLastAccessedAt.get(clean(b?.storagePath)))));
      for (const record of candidates) {
        if (totalBytes <= budget) break;
        markForDelete(record);
      }
    }

    if (paths.size) {
      const deleteTransaction = database.transaction(MEDIA_CACHE_STORE, "readwrite");
      const deleteDone = transactionDone(deleteTransaction);
      const store = deleteTransaction.objectStore(MEDIA_CACHE_STORE);
      paths.forEach(path => store.delete(path));
      await deleteDone;
      paths.forEach(path => memoryLastAccessedAt.delete(path));
    }
    return { deleted: paths.size, bytesFreed, remainingBytes: totalBytes };
  } catch (error) {
    console.warn("Unable to prune Trip media cache", error);
    return { deleted: 0, bytesFreed: 0, remainingBytes: 0 };
  }
}

export async function getTripMediaCacheStats() {
  const database = await openDatabase();
  if (!database) return { entries: 0, bytes: 0, available: false };
  try {
    const transaction = database.transaction(MEDIA_CACHE_STORE, "readonly");
    const done = transactionDone(transaction);
    const records = await requestPromise(transaction.objectStore(MEDIA_CACHE_STORE).getAll());
    await done;
    return {
      entries: records.length,
      bytes: records.reduce((sum, record) => sum + finiteNumber(record?.byteSize || record?.blob?.size), 0),
      available: true
    };
  } catch (error) {
    return { entries: 0, bytes: 0, available: false };
  }
}

export const TRIP_MEDIA_CACHE_LIMITS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxAgeMs: DEFAULT_MAX_AGE_MS
});
