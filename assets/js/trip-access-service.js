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
  // Offline travel continuity: if Firestore cannot surface the cached member
  // document, the last server-confirmed role for this exact UID + Trip may keep
  // the cached workspace usable until reconnect. Online server denial always wins.
  const role = latestUser ? (memberRole || (navigator.onLine === false ? lastKnownRole : null)) : null;
  currentAccess = {
    tripId: activeTripId,
    role,
    roleLabel: role ? ROLE_LABELS[role] : "",
    signedIn: !!latestUser,
    source: memberRole ? "member-doc" : (role ? "last-known-access" : (latestUser ? "no-membership" : "signed-out")),
    ready: !activeTripId || !latestUser || memberResolved,
    fromCache: memberRole ? memberFromCache : (role ? true : memberFromCache),
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
  if (stopMember) stopMember();
  stopMember = null;
  if (preserveState) return;
  latestMemberData = null;
  memberResolved = false;
  memberFromCache = false;
  memberServerConfirmed = false;
}

function attachMemberListener({ preserveState = false } = {}) {
  resetMemberListener({ preserveState });
  if (!activeTripId || !latestUser?.uid) {
    computeAccess();
    return;
  }

  stopMember = onSnapshot(doc(db, "trips", activeTripId, "members", latestUser.uid), { includeMetadataChanges: true }, snapshot => {
    memberResolved = true;
    memberFromCache = snapshot.metadata?.fromCache === true;
    if (!memberFromCache) memberServerConfirmed = true;
    latestMemberData = snapshot.exists() ? snapshot.data() : null;
    const resolvedRole=validRole(latestMemberData?.role);
    if(memberServerConfirmed && latestUser?.uid && activeTripId){
      if(resolvedRole) saveLastKnownRole(latestUser.uid,activeTripId,resolvedRole);
      else clearLastKnownRole(latestUser.uid,activeTripId);
    }
    computeAccess();
  }, error => {
    memberResolved = true;
    memberFromCache = false;
    // Only an explicit permission-denied response is an authoritative revoke.
    // A transient online/network listener error must never throw away a usable
    // local Trip just because the device happens to be connected to Wi-Fi.
    const denied = error?.code === "permission-denied";
    memberServerConfirmed = denied;
    if (denied) {
      latestMemberData = null;
      if(latestUser?.uid&&activeTripId) clearLastKnownRole(latestUser.uid,activeTripId);
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
  // This avoids a transient no-role frame during iOS cold-start refreshes; an
  // authoritative server denial still clears access on the next callback.
  attachMemberListener({ preserveState: true });
  computeAccess();
}
