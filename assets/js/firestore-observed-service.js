/*
 * v7.7.3.1 · Firestore I/O Audit Lite
 *
 * Memory-only observation layer around the Firebase modular Firestore SDK.
 * It NEVER issues an extra Firestore request and NEVER persists diagnostic
 * data. Metrics describe activity observed by this app process and are not a
 * substitute for Firebase billing / quota metrics.
 */
import {
  addDoc as nativeAddDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc as nativeDeleteDoc,
  doc,
  getDoc as nativeGetDoc,
  getDocs as nativeGetDocs,
  increment,
  limit,
  onSnapshot as nativeOnSnapshot,
  orderBy,
  query,
  runTransaction as nativeRunTransaction,
  serverTimestamp,
  setDoc as nativeSetDoc,
  updateDoc as nativeUpdateDoc,
  where,
  writeBatch as nativeWriteBatch
} from "https://www.gstatic.com/firebasejs/11.8.0/firebase-firestore.js";

const state = {
  listenerSubscriptions: 0,
  activeListeners: 0,
  peakActiveListeners: 0,
  snapshotEvents: 0,
  snapshotDocs: 0,
  snapshotCacheDocs: 0,
  snapshotServerDocs: 0,
  snapshotDocChanges: 0,
  explicitReadCalls: 0,
  explicitReadDocs: 0,
  explicitReadCacheDocs: 0,
  explicitReadServerDocs: 0,
  writeCalls: 0,
  writeDocs: 0,
  deleteCalls: 0,
  deleteDocs: 0,
  transactionCalls: 0,
  transactionAttempts: 0
};

let notifyQueued = false;
function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    try {
      window.dispatchEvent(new CustomEvent("app-firestore-io-audit", { detail: snapshotAudit() }));
      if (typeof window.__refreshPerfLiteDiagnostics === "function") window.__refreshPerfLiteDiagnostics();
    } catch (error) {}
  });
}
function bump(key, amount = 1) {
  const step = Number(amount);
  state[key] = (Number(state[key]) || 0) + (Number.isFinite(step) ? step : 1);
}
function sourceIsCache(snapshot) {
  return snapshot?.metadata?.fromCache === true;
}
function docsInSnapshot(snapshot) {
  if (!snapshot) return 0;
  if (Number.isFinite(Number(snapshot.size))) return Math.max(0, Number(snapshot.size));
  try { return typeof snapshot.exists === "function" && snapshot.exists() ? 1 : 0; }
  catch (error) { return 0; }
}
function changesInSnapshot(snapshot) {
  try { return typeof snapshot?.docChanges === "function" ? snapshot.docChanges().length : 0; }
  catch (error) { return 0; }
}
function observeSnapshot(snapshot) {
  const docs = docsInSnapshot(snapshot);
  bump("snapshotEvents");
  bump("snapshotDocs", docs);
  bump(sourceIsCache(snapshot) ? "snapshotCacheDocs" : "snapshotServerDocs", docs);
  bump("snapshotDocChanges", changesInSnapshot(snapshot));
  notify();
}
function observeExplicitRead(snapshot) {
  const docs = docsInSnapshot(snapshot);
  bump("explicitReadCalls");
  bump("explicitReadDocs", docs);
  bump(sourceIsCache(snapshot) ? "explicitReadCacheDocs" : "explicitReadServerDocs", docs);
  notify();
  return snapshot;
}
function observeWrite({ writes = 0, deletes = 0, calls = 1 } = {}) {
  if (writes > 0) {
    bump("writeCalls", calls);
    bump("writeDocs", writes);
  }
  if (deletes > 0) {
    bump("deleteCalls", calls);
    bump("deleteDocs", deletes);
  }
  notify();
}
function snapshotAudit() { return { ...state }; }

try {
  window.__firestoreIoLite = {
    snapshot: snapshotAudit,
    note: "Observed app activity only; not Firebase billing reads/writes."
  };
} catch (error) {}

async function getDoc(...args) {
  return observeExplicitRead(await nativeGetDoc(...args));
}
async function getDocs(...args) {
  return observeExplicitRead(await nativeGetDocs(...args));
}
async function setDoc(...args) {
  const result = await nativeSetDoc(...args);
  observeWrite({ writes: 1 });
  return result;
}
async function updateDoc(...args) {
  const result = await nativeUpdateDoc(...args);
  observeWrite({ writes: 1 });
  return result;
}
async function addDoc(...args) {
  const result = await nativeAddDoc(...args);
  observeWrite({ writes: 1 });
  return result;
}
async function deleteDoc(...args) {
  const result = await nativeDeleteDoc(...args);
  observeWrite({ deletes: 1 });
  return result;
}

function wrapObserver(observer, closeListener) {
  if (!observer || typeof observer !== "object") return observer;
  return {
    ...observer,
    next(snapshot) {
      observeSnapshot(snapshot);
      if (typeof observer.next === "function") return observer.next(snapshot);
    },
    error(error) {
      closeListener();
      if (typeof observer.error === "function") return observer.error(error);
    },
    complete() {
      closeListener();
      if (typeof observer.complete === "function") return observer.complete();
    }
  };
}

function onSnapshot(reference, ...args) {
  bump("listenerSubscriptions");
  bump("activeListeners");
  state.peakActiveListeners = Math.max(Number(state.peakActiveListeners) || 0, Number(state.activeListeners) || 0);
  notify();

  let closed = false;
  function closeListener() {
    if (closed) return;
    closed = true;
    state.activeListeners = Math.max(0, (Number(state.activeListeners) || 0) - 1);
    notify();
  }

  const wrapped = [...args];
  // Supported Firebase overloads:
  // onSnapshot(ref, next, error?, complete?)
  // onSnapshot(ref, options, next, error?, complete?)
  // onSnapshot(ref, observer)
  // onSnapshot(ref, options, observer)
  let handlerIndex = 0;
  if (wrapped[0] && typeof wrapped[0] === "object" && !("next" in wrapped[0]) && !("error" in wrapped[0]) && !("complete" in wrapped[0])) handlerIndex = 1;

  const handler = wrapped[handlerIndex];
  if (typeof handler === "function") {
    const originalNext = handler;
    wrapped[handlerIndex] = snapshot => {
      observeSnapshot(snapshot);
      return originalNext(snapshot);
    };
    const errorIndex = handlerIndex + 1;
    const originalError = wrapped[errorIndex];
    wrapped[errorIndex] = error => {
      closeListener();
      if (typeof originalError === "function") return originalError(error);
    };
    const completeIndex = handlerIndex + 2;
    const originalComplete = wrapped[completeIndex];
    if (typeof originalComplete === "function") {
      wrapped[completeIndex] = () => {
        closeListener();
        return originalComplete();
      };
    }
  } else if (handler && typeof handler === "object") {
    wrapped[handlerIndex] = wrapObserver(handler, closeListener);
  }

  let unsubscribe;
  try {
    unsubscribe = nativeOnSnapshot(reference, ...wrapped);
  } catch (error) {
    closeListener();
    throw error;
  }
  return () => {
    closeListener();
    return unsubscribe();
  };
}

function writeBatch(db) {
  const batch = nativeWriteBatch(db);
  let writes = 0;
  let deletes = 0;
  let wrapper;
  wrapper = new Proxy(batch, {
    get(target, prop, receiver) {
      if (prop === "set" || prop === "update") {
        return (...args) => {
          target[prop](...args);
          writes += 1;
          return wrapper;
        };
      }
      if (prop === "delete") {
        return (...args) => {
          target.delete(...args);
          deletes += 1;
          return wrapper;
        };
      }
      if (prop === "commit") {
        return async (...args) => {
          const result = await target.commit(...args);
          observeWrite({ writes, deletes, calls: 1 });
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return wrapper;
}

async function runTransaction(db, updateFunction, options) {
  bump("transactionCalls");
  notify();
  let finalWrites = 0;
  let finalDeletes = 0;
  const result = await nativeRunTransaction(db, async transaction => {
    bump("transactionAttempts");
    notify();
    let attemptWrites = 0;
    let attemptDeletes = 0;
    let proxy;
    proxy = new Proxy(transaction, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (...args) => observeExplicitRead(await target.get(...args));
        }
        if (prop === "set" || prop === "update") {
          return (...args) => {
            target[prop](...args);
            attemptWrites += 1;
            return proxy;
          };
        }
        if (prop === "delete") {
          return (...args) => {
            target.delete(...args);
            attemptDeletes += 1;
            return proxy;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const value = await updateFunction(proxy);
    finalWrites = attemptWrites;
    finalDeletes = attemptDeletes;
    return value;
  }, options);
  observeWrite({ writes: finalWrites, deletes: finalDeletes, calls: 1 });
  return result;
}

export {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
};
