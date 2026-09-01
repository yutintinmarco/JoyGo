import { db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import { doc, getDoc, serverTimestamp, setDoc } from "./firestore-observed-service.js";

function clean(value) { return String(value ?? "").trim(); }

let entitlementCache = null;
let entitlementUid = "";

async function requireUser(userInput = null) {
  const user = userInput || getCurrentUser() || await waitForInitialAuth();
  if (!user?.uid) {
    const error = new Error("Google sign-in required");
    error.code = "auth-required";
    throw error;
  }
  return user;
}

export async function getTripCreatorEntitlement(userInput = null, { force = false } = {}) {
  const user = await requireUser(userInput);
  if (!force && entitlementCache && entitlementUid === user.uid) return { ...entitlementCache };

  const [creatorSnapshot, adminSnapshot] = await Promise.all([
    getDoc(doc(db, "authorizedTripCreators", user.uid)),
    getDoc(doc(db, "appAdmins", user.uid))
  ]);
  const creatorData = creatorSnapshot.exists() ? creatorSnapshot.data() || {} : {};
  const adminData = adminSnapshot.exists() ? adminSnapshot.data() || {} : {};
  const isAdmin = adminSnapshot.exists() && adminData.enabled === true;
  const isCreator = creatorSnapshot.exists() && creatorData.enabled === true;
  entitlementUid = user.uid;
  entitlementCache = {
    uid: user.uid,
    enabled: isAdmin || isCreator,
    via: isAdmin ? "app-admin" : (isCreator ? "creator" : "none"),
    source: (creatorSnapshot.metadata?.fromCache === true || adminSnapshot.metadata?.fromCache === true) ? "cache" : "server"
  };
  return { ...entitlementCache };
}

export function clearTripCreatorEntitlementCache() {
  entitlementCache = null;
  entitlementUid = "";
}

export async function inspectTripIdRegistry(tripIdInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) {
    const error = new Error("Missing tripId");
    error.code = "invalid-trip-id";
    throw error;
  }
  const user = await requireUser(userInput);
  const entitlement = await getTripCreatorEntitlement(user);
  if (!entitlement.enabled) {
    const error = new Error("Trip creator entitlement required");
    error.code = "creator-required";
    throw error;
  }
  const snapshot = await getDoc(doc(db, "tripIds", tripId));
  return {
    tripId,
    reserved: snapshot.exists(),
    fromCache: snapshot.metadata?.fromCache === true
  };
}

export function tripIdRegistryRecord(tripIdInput, userInput) {
  const tripId = clean(tripIdInput);
  const uid = clean(userInput?.uid);
  if (!tripId || !uid) {
    const error = new Error("Invalid Trip registry record");
    error.code = "invalid-trip-id";
    throw error;
  }
  return {
    tripId,
    status: "active",
    reservedBy: uid,
    createdAt: serverTimestamp()
  };
}

export async function ensureTripIdRegistry(tripIdInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) return { tripId: "", created: false, exists: false };
  const user = await requireUser(userInput);
  const ref = doc(db, "tripIds", tripId);
  const existing = await getDoc(ref);
  if (existing.exists()) return { tripId, created: false, exists: true };

  try {
    await setDoc(ref, tripIdRegistryRecord(tripId, user));
    return { tripId, created: true, exists: true };
  } catch (error) {
    // Another owner / creator may have backfilled the same canonical ID first.
    // Re-read once so a harmless race does not surface as an app error.
    try {
      const raced = await getDoc(ref);
      if (raced.exists()) return { tripId, created: false, exists: true };
    } catch (readError) {}
    throw error;
  }
}
