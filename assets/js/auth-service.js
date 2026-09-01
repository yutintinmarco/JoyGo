import { auth, db } from "./firebase-service.js";
import {
  GoogleAuthProvider,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from "https://www.gstatic.com/firebasejs/11.8.0/firebase-auth.js";
import {
  doc,
  serverTimestamp,
  setDoc
} from "./firestore-observed-service.js";

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

let currentUser = auth.currentUser || null;
let authReady = false;
let resolveInitialAuth;
const initialAuthPromise = new Promise(resolve => { resolveInitialAuth = resolve; });
const subscribers = new Set();

function publicUser(user) {
  return user ? {
    uid: user.uid || "",
    displayName: user.displayName || "",
    email: user.email || "",
    photoURL: user.photoURL || ""
  } : null;
}

function dispatchAuthState(user) {
  const safeUser = publicUser(user);
  window.__appAuthUser = safeUser;
  window.dispatchEvent(new CustomEvent("app-auth-state", { detail: { user: safeUser } }));
  subscribers.forEach(callback => {
    try { callback(user, safeUser); } catch (error) { console.error("Auth subscriber error", error); }
  });
}

const PROFILE_HEARTBEAT_MS = 12 * 60 * 60 * 1000;
const PROFILE_SYNC_KEY_PREFIX = "travel_profile_sync_v1:";
const LAST_AUTH_UID_KEY = "travel_last_auth_uid";

function profileFingerprint(user) {
  return JSON.stringify([
    String(user?.displayName || ""),
    String(user?.email || "").trim().toLowerCase(),
    String(user?.photoURL || "")
  ]);
}

function readProfileSyncState(uid) {
  if (!uid) return null;
  try {
    const raw = localStorage.getItem(`${PROFILE_SYNC_KEY_PREFIX}${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { at: Number(parsed?.at) || 0, fingerprint: String(parsed?.fingerprint || "") };
  } catch (error) {
    return null;
  }
}

function saveProfileSyncState(uid, fingerprint, at = Date.now()) {
  if (!uid) return;
  try {
    localStorage.setItem(`${PROFILE_SYNC_KEY_PREFIX}${uid}`, JSON.stringify({ at, fingerprint }));
  } catch (error) {}
}

function isRememberedAuthUid(uid) {
  try { return String(localStorage.getItem(LAST_AUTH_UID_KEY) || "").trim() === String(uid || "").trim(); }
  catch (error) { return false; }
}

async function ensureUserProfile(user) {
  if (!user?.uid) return;

  const uid = String(user.uid);
  const now = Date.now();
  const fingerprint = profileFingerprint(user);
  const previous = readProfileSyncState(uid);

  // Existing installs before v7.7.3.2 already wrote this profile on every boot.
  // Seed the local heartbeat marker from the remembered signed-in UID without
  // creating one more migration-only Firestore write. A genuinely new account /
  // device has no matching remembered UID, so its profile is still created now.
  if (!previous && isRememberedAuthUid(uid)) {
    saveProfileSyncState(uid, fingerprint, now);
    return;
  }

  const identityChanged = Boolean(previous && previous.fingerprint !== fingerprint);
  const heartbeatDue = !previous || (now - previous.at >= PROFILE_HEARTBEAT_MS);
  if (!identityChanged && !heartbeatDue) return;

  try {
    await setDoc(doc(db, "users", uid), {
      displayName: user.displayName || "",
      email: String(user.email || "").trim().toLowerCase(),
      photoURL: user.photoURL || "",
      lastSeenAt: serverTimestamp()
    }, { merge: true });
    saveProfileSyncState(uid, fingerprint, now);
  } catch (error) {
    // Existing Phase 1 rules may not allow /users yet. Phase 2F will deploy the new rules.
    if (error?.code !== "permission-denied") console.warn("Unable to update user profile", error);
  }
}

onAuthStateChanged(auth, user => {
  currentUser = user || null;
  ensureUserProfile(user);
  dispatchAuthState(user);
  if (!authReady) {
    authReady = true;
    resolveInitialAuth(user || null);
  }
});

getRedirectResult(auth).catch(error => {
  console.error("Google redirect login error:", error?.code, error?.message, error);
  window.dispatchEvent(new CustomEvent("app-auth-error", { detail: { error } }));
});

export function subscribeAuthState(callback, { immediate = true } = {}) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  if (immediate && authReady) callback(currentUser, publicUser(currentUser));
  return () => subscribers.delete(callback);
}

export function getCurrentUser() {
  return currentUser;
}

export function getPublicCurrentUser() {
  return publicUser(currentUser);
}

export function waitForInitialAuth() {
  return authReady ? Promise.resolve(currentUser) : initialAuthPromise;
}

export async function signInWithGoogle() {
  try {
    return await signInWithPopup(auth, provider);
  } catch (error) {
    const redirectCodes = new Set([
      "auth/popup-blocked",
      "auth/cancelled-popup-request",
      "auth/operation-not-supported-in-this-environment"
    ]);
    if (redirectCodes.has(error?.code)) {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw error;
  }
}

export function signOutCurrentUser() {
  try { localStorage.removeItem("travel_last_auth_uid"); } catch (error) {}
  return signOut(auth);
}

export { auth, db, publicUser };
