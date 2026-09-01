import { firebaseConfig } from "./firebase-config.js";
import { getApp, getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.8.0/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache
} from "https://www.gstatic.com/firebasejs/11.8.0/firebase-firestore.js";

const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// v7.7.7.4 · Safari Firestore persistence stabilization.
// The Travel App is designed to run as one primary PWA instance per device.
// Keep IndexedDB persistence for fast warm boots and offline reads, but use
// Firestore's default single-tab persistence instead of multi-tab coordination.
// This removes an unnecessary coordination layer on Safari / iOS while leaving
// normal multi-device Firebase realtime sync completely unchanged.
let db;
let firestorePersistence = "memory";
try {
  db = initializeFirestore(firebaseApp, {
    localCache: persistentLocalCache()
  });
  firestorePersistence = "persistent-single-tab";
} catch (error) {
  console.warn("Persistent Firestore cache unavailable; using memory cache", error);
  db = getFirestore(firebaseApp);
}

window.__firestorePersistence = firestorePersistence;

export { firebaseApp, auth, db, firebaseConfig, firestorePersistence };
