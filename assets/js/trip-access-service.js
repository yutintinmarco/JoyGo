import { db } from "./firebase-service.js";
import { subscribeAuthState } from "./auth-service.js";
import { doc, onSnapshot } from "./firestore-observed-service.js";

export const TRIP_ROLES = Object.freeze({
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
  VIEWER: "viewer"
});

const ROLE_RANK = Object.freeze({ viewer: 1, member: 2, admin: 3, owner: 4 });
const ROLE_LABELS = Object.freeze({ owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" });

let activeTripId = "";
let currentAccess = { tripId: "", role: null, signedIn: false, source: "none", ready: false, fromCache: false, serverConfirmed: false };
let stopMember = null;
let stopAuth = null;
let latestMemberData = null;
let latestUser = null;
let memberResolved = false;
let memberFromCache = false;
let memberServerConfirmed = false;
let memberListenerEpoch = 0;
const subscribers = new Set();
const LAST_KNOWN_ACCESS_KEY = "travel_last_known_trip_access_v1";

function readLastKnownAccess(){
  try{
    const parsed=JSON.parse(localStorage.getItem(LAST_KNOWN_ACCESS_KEY)||"{}");
    return parsed&&typeof parsed==="object"?parsed:{};
  }catch(error){ return {}; }
}
function lastKnownKey(uid,tripId){ return `${String(uid||"").trim()}::${String(tripId||"").trim()}`; }
function getLastKnownRole(uid,tripId){
  const row=readLastKnownAccess()[lastKnownKey(uid,tripId)]||null;
  return validRole(row?.role)||null;
}
function saveLastKnownRole(uid,tripId,role){
  const valid=validRole(role);if(!uid||!tripId||!valid)return;
  try{
    const all=readLastKnownAccess();
    all[lastKnownKey(uid,tripId)]={role:valid,verifiedAt:Date.now()};
    localStorage.setItem(LAST_KNOWN_ACCESS_KEY,JSON.stringify(all));
  }catch(error){}
}
function clearLastKnownRole(uid,tripId){
  if(!uid||!tripId)return;
  try{
    const all=readLastKnownAccess();delete all[lastKnownKey(uid,tripId)];
    localStorage.setItem(LAST_KNOWN_ACCESS_KEY,JSON.stringify(all));
  }catch(error){}
}

function validRole(value) {
  return Object.values(TRIP_ROLES).includes(value) ? value : null;
}

function computeAccess() {
  const memberRole = validRole(latestMemberData?.role);
  const lastKnownRole = latestUser?.uid && activeTripId ? getLastKnownRole(latestUser.uid, activeTripId) : null;
  // v8.0.12 · A Firestore cache snapshot is not an authoritative revoke.
  // Preserve the exact UID + Trip's most recent server-confirmed role while a
  // replacement listener is attaching or only cache metadata is available.
  // The role is cleared only by an authoritative server snapshot / explicit
  // permission-denied response. Firestore / Storage Rules remain the write gate.
  const provisionalRole = !memberServerConfirmed ? lastKnownRole : null;
  const role = latestUser ? (memberRole || provisionalRole) : null;
  const ready = !activeTripId || !latestUser || memberServerConfirmed || !!role || (navigator.onLine === false && memberResolved);
  currentAccess = {
    tripId: activeTripId,
    role,
    roleLabel: role ? ROLE_LABELS[role] : "",
    signedIn: !!latestUser,
    source: memberRole
      ? (memberServerConfirmed ? "member-doc" : "member-doc-pending")
      : (role ? "last-known-access" : (latestUser ? (memberServerConfirmed ? "no-membership" : "membership-pending") : "signed-out")),
    ready,
    fromCache: memberServerConfirmed ? false : (role ? true : memberFromCache),
    serverConfirmed: memberServerConfirmed
  };
  const snapshot = { ...currentAccess };
  window.__appTripAccess = snapshot;
  window.dispatchEvent(new CustomEvent("app-trip-access", { detail: snapshot }));
  subscribers.forEach(callback => {
    try { callback(snapshot); } catch (error) { console.error("Trip access subscriber", error); }
  });
}

function resetMemberListener({ preserveState = false } = {}) {
  memberListenerEpoch += 1;
  if (stopMember) stopMember();
  stopMember = null;
  // Every replacement listener needs a fresh authoritative server decision.
  // preserveState keeps the last usable member role visible during that gap,
  // but never carries serverConfirmed=true into the new listener generation.
  memberServerConfirmed = false;
  if (preserveState) {
    memberResolved = true;
    memberFromCache = true;
    return;
  }
  latestMemberData = null;
  memberResolved = false;
  memberFromCache = false;
}

function attachMemberListener({ preserveState = false } = {}) {
  resetMemberListener({ preserveState });
  if (!activeTripId || !latestUser?.uid) {
    computeAccess();
    return;
  }

  const listenerTripId = activeTripId;
  const listenerUid = latestUser.uid;
  const listenerEpoch = memberListenerEpoch;
  stopMember = onSnapshot(doc(db, "trips", listenerTripId, "members", listenerUid), { includeMetadataChanges: true }, snapshot => {
    if (listenerEpoch !== memberListenerEpoch || listenerTripId !== activeTripId || listenerUid !== latestUser?.uid) return;
    memberResolved = true;
    const fromCache = snapshot.metadata?.fromCache === true;
    memberFromCache = fromCache;

    if (fromCache) {
      // A cache miss can occur while iOS/PWA listeners reattach. Never replace
      // a previously verified role with null until the server has spoken.
      if (snapshot.exists()) latestMemberData = snapshot.data();
      computeAccess();
      return;
    }

    memberServerConfirmed = true;
    latestMemberData = snapshot.exists() ? snapshot.data() : null;
    const resolvedRole = validRole(latestMemberData?.role);
    if (resolvedRole) saveLastKnownRole(listenerUid, listenerTripId, resolvedRole);
    else clearLastKnownRole(listenerUid, listenerTripId);
    computeAccess();
  }, error => {
    if (listenerEpoch !== memberListenerEpoch || listenerTripId !== activeTripId || listenerUid !== latestUser?.uid) return;
    memberResolved = true;
    memberFromCache = false;
    // Only an explicit permission-denied response is an authoritative revoke.
    // Transient connectivity/listener errors preserve the last verified role.
    const denied = error?.code === "permission-denied";
    memberServerConfirmed = denied;
    if (denied) {
      latestMemberData = null;
      clearLastKnownRole(listenerUid, listenerTripId);
    } else console.warn("Trip member access listener", error);
    computeAccess();
  });
}

export function initTripAccess(tripId) {
  const nextTripId = String(tripId || "").trim();
  if (activeTripId === nextTripId && stopAuth) return;
  activeTripId = nextTripId;
  resetMemberListener();
  if (stopAuth) stopAuth();
  stopAuth = subscribeAuthState(user => {
    latestUser = user || null;
    attachMemberListener();
  });
  computeAccess();
}

export function getTripAccess() {
  return { ...currentAccess };
}

export function subscribeTripAccess(callback, { immediate = true } = {}) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  if (immediate) callback({ ...currentAccess });
  return () => subscribers.delete(callback);
}

export function isTripAccessVerified({ allowCachedOffline = true } = {}) {
  if (!currentAccess.role) return false;
  if (currentAccess.serverConfirmed) return true;
  return allowCachedOffline && navigator.onLine === false && (currentAccess.fromCache || currentAccess.source === "last-known-access");
}

export function hasTripRole(minimumRole = TRIP_ROLES.VIEWER) {
  const currentRank = ROLE_RANK[currentAccess.role] || 0;
  const requiredRank = ROLE_RANK[minimumRole] || Infinity;
  return currentRank >= requiredRank;
}

export function clearLastKnownTripAccess(uid, tripId) {
  clearLastKnownRole(String(uid || "").trim(), String(tripId || "").trim());
}

export function isOwner() { return currentAccess.role === TRIP_ROLES.OWNER; }
export function isAdminOrOwner() { return hasTripRole(TRIP_ROLES.ADMIN); }
export function isMemberOrAbove() { return hasTripRole(TRIP_ROLES.MEMBER); }
export function getRoleLabel(role = currentAccess.role) { return ROLE_LABELS[role] || ""; }

export function refreshTripAccess() {
  // Preserve the last verified access while the replacement listener attaches.
  // v8.0.12 explicitly resets serverConfirmed for the new listener generation,
  // so a cache-only miss cannot masquerade as an authoritative online revoke.
  attachMemberListener({ preserveState: true });
  computeAccess();
}
