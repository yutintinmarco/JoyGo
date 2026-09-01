const DB_NAME = "travel-transit-route-cache";
const DB_VERSION = 1;
const STORE_NAME = "routes";
const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1000;
const FALLBACK_FRESH_MS = 2 * 60 * 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 120;

let databasePromise = null;

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function roundCoordinate(value) {
  const n = finiteNumber(value);
  return n == null ? "" : n.toFixed(5);
}
function endpointFingerprint(record = {}) {
  const loc = record?.location && typeof record.location === "object" ? record.location : record;
  const lat = roundCoordinate(loc?.latitude ?? loc?.lat);
  const lng = roundCoordinate(loc?.longitude ?? loc?.lng ?? loc?.lon);
  const placeId = clean(loc?.placeId || record?.placeId);
  const mapsUrl = clean(loc?.mapsUrl || record?.maps || record?.mapsUrl || record?.googleMapsUrl);
  const address = clean(loc?.address || record?.address);
  const name = clean(record?.title || loc?.name || record?.name);
  return { lat, lng, placeId, mapsUrl, address, name };
}
function departureFingerprint(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
export function buildTransitRouteCacheKey(provider, request = {}) {
  const payload = {
    v: 1,
    provider: clean(provider),
    tripId: clean(request?.tripId),
    origin: endpointFingerprint(request?.origin),
    destination: endpointFingerprint(request?.destination),
    departure: departureFingerprint(request?.departureTime),
    country: clean(request?.locationContext?.countryCode || request?.locationContext?.country).toUpperCase(),
    timeZone: clean(request?.locationContext?.providerTimeZone || request?.locationContext?.timeZone)
  };
  const serialized = JSON.stringify(payload);
  return `transit-v1:${fnv1a(serialized)}:${serialized.length}`;
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
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "cacheKey" });
        store.createIndex("cachedAt", "cachedAt", { unique: false });
        store.createIndex("tripId", "tripId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open Transit route cache"));
  }).catch(error => {
    console.warn("Transit route cache unavailable; continuing without persistent cache", error);
    return null;
  });
  return databasePromise;
}
export async function getTransitRouteCache(cacheKeyInput) {
  const cacheKey = clean(cacheKeyInput);
  if (!cacheKey) return null;
  const database = await openDatabase();
  if (!database) return null;
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const done = transactionDone(transaction);
    const record = await requestPromise(transaction.objectStore(STORE_NAME).get(cacheKey));
    await done;
    if (!record?.result) return null;
    const now = Date.now();
    if (now - Number(record.cachedAt || 0) > MAX_AGE_MS) {
      void removeTransitRouteCache(cacheKey);
      return null;
    }
    return {
      result: record.result,
      cachedAt: Number(record.cachedAt || 0),
      freshUntil: Number(record.freshUntil || 0),
      fresh: now <= Number(record.freshUntil || 0)
    };
  } catch (error) {
    console.warn("Unable to read Transit route cache", error);
    return null;
  }
}
export async function putTransitRouteCache(cacheKeyInput, result, { tripId = "" } = {}) {
  const cacheKey = clean(cacheKeyInput);
  if (!cacheKey || !result || typeof result !== "object") return false;
  const database = await openDatabase();
  if (!database) return false;
  try {
    const now = Date.now();
    const freshMs = result?.basis === "now-fallback" ? FALLBACK_FRESH_MS : DEFAULT_FRESH_MS;
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).put({
      cacheKey,
      tripId: clean(tripId),
      result,
      cachedAt: now,
      freshUntil: now + freshMs
    });
    await done;
    void pruneTransitRouteCache();
    return true;
  } catch (error) {
    console.warn("Unable to write Transit route cache", error);
    return false;
  }
}
export async function removeTransitRouteCache(cacheKeyInput) {
  const cacheKey = clean(cacheKeyInput);
  if (!cacheKey) return false;
  const database = await openDatabase();
  if (!database) return false;
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).delete(cacheKey);
    await done;
    return true;
  } catch (_) { return false; }
}
export async function pruneTransitRouteCache() {
  const database = await openDatabase();
  if (!database) return 0;
  try {
    const readTransaction = database.transaction(STORE_NAME, "readonly");
    const readDone = transactionDone(readTransaction);
    const records = await requestPromise(readTransaction.objectStore(STORE_NAME).getAll());
    await readDone;
    const now = Date.now();
    const deleteKeys = new Set(records.filter(row => now - Number(row?.cachedAt || 0) > MAX_AGE_MS).map(row => clean(row?.cacheKey)).filter(Boolean));
    const remaining = records.filter(row => !deleteKeys.has(clean(row?.cacheKey))).sort((a, b) => Number(b?.cachedAt || 0) - Number(a?.cachedAt || 0));
    remaining.slice(MAX_ENTRIES).forEach(row => { const key = clean(row?.cacheKey); if (key) deleteKeys.add(key); });
    if (!deleteKeys.size) return 0;
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(STORE_NAME);
    deleteKeys.forEach(key => store.delete(key));
    await done;
    return deleteKeys.size;
  } catch (error) {
    console.warn("Unable to prune Transit route cache", error);
    return 0;
  }
}
