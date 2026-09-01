import { db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where
} from "./firestore-observed-service.js";

function clean(value) { return String(value ?? "").trim(); }
function cleanEmail(value) { return clean(value).toLowerCase(); }

let adminCache = null;
let adminUid = "";

async function requireUser(userInput = null) {
  const user = userInput || getCurrentUser() || await waitForInitialAuth();
  if (!user?.uid) {
    const error = new Error("Google sign-in required");
    error.code = "auth-required";
    throw error;
  }
  return user;
}

export async function getAppAdminEntitlement(userInput = null, { force = false } = {}) {
  const user = await requireUser(userInput);
  if (!force && adminCache && adminUid === user.uid) return { ...adminCache };

  const snapshot = await getDoc(doc(db, "appAdmins", user.uid));
  const data = snapshot.exists() ? snapshot.data() || {} : {};
  adminUid = user.uid;
  adminCache = {
    uid: user.uid,
    enabled: snapshot.exists() && data.enabled === true,
    source: snapshot.metadata?.fromCache === true ? "cache" : "server"
  };
  return { ...adminCache };
}

export function clearAppAdminEntitlementCache() {
  adminCache = null;
  adminUid = "";
}

async function requireAppAdmin(userInput = null) {
  const user = await requireUser(userInput);
  const entitlement = await getAppAdminEntitlement(user);
  if (!entitlement.enabled) {
    const error = new Error("App Admin permission required");
    error.code = "app-admin-required";
    throw error;
  }
  return user;
}

async function currentUserProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snapshot = await getDoc(ref);
  const existing = snapshot.exists() ? snapshot.data() || {} : {};
  const canonical = {
    displayName: clean(user.displayName),
    email: cleanEmail(user.email),
    photoURL: clean(user.photoURL)
  };
  const needsSync = !snapshot.exists()
    || cleanEmail(existing.email) !== canonical.email
    || clean(existing.displayName) !== canonical.displayName
    || clean(existing.photoURL) !== canonical.photoURL;
  if (needsSync) {
    await setDoc(ref, { ...canonical, lastSeenAt: serverTimestamp() }, { merge: true });
    return { uid: user.uid, ...existing, ...canonical };
  }
  return { uid: user.uid, ...existing };
}

async function findUserByEmailForAdmin(emailInput, user) {
  const email = cleanEmail(emailInput);
  if (!email || !email.includes("@")) {
    const error = new Error("Invalid Google email");
    error.code = "invalid-email";
    throw error;
  }

  if (cleanEmail(user.email) === email) {
    const profile = await currentUserProfile(user);
    if (profile) return profile;
  }

  const snapshot = await getDocs(query(collection(db, "users"), where("email", "==", email), limit(2)));
  if (snapshot.empty) {
    const error = new Error("User profile not found");
    error.code = "user-not-found";
    throw error;
  }
  if (snapshot.size > 1) {
    const error = new Error("Multiple user profiles use this email");
    error.code = "ambiguous-user";
    throw error;
  }
  const match = snapshot.docs[0];
  return { uid: match.id, ...(match.data() || {}) };
}

export async function findUserByEmail(emailInput, { user: userInput = null } = {}) {
  const user = await requireAppAdmin(userInput);
  return findUserByEmailForAdmin(emailInput, user);
}

async function hydrateLegacyCreator(item) {
  if (clean(item.email)) return item;
  try {
    const profile = await getDoc(doc(db, "users", item.uid));
    if (!profile.exists()) return item;
    const data = profile.data() || {};
    return {
      ...item,
      email: cleanEmail(data.email),
      displayName: clean(data.displayName),
      photoURL: clean(data.photoURL)
    };
  } catch (error) {
    return item;
  }
}

export async function listTripCreators({ user: userInput = null } = {}) {
  await requireAppAdmin(userInput);
  const snapshot = await getDocs(collection(db, "authorizedTripCreators"));
  const active = snapshot.docs
    .map(entry => ({ uid: entry.id, ...(entry.data() || {}) }))
    .filter(entry => entry.enabled === true);
  const rows = await Promise.all(active.map(hydrateLegacyCreator));
  return rows.sort((a, b) => {
    const left = clean(a.displayName || a.email || a.uid).toLowerCase();
    const right = clean(b.displayName || b.email || b.uid).toLowerCase();
    return left.localeCompare(right);
  });
}

export async function grantTripCreatorByEmail(emailInput, { user: userInput = null } = {}) {
  const user = await requireAppAdmin(userInput);
  const target = await findUserByEmailForAdmin(emailInput, user);
  const email = cleanEmail(target.email);
  if (!target?.uid || !email) {
    const error = new Error("User profile is incomplete");
    error.code = "user-not-found";
    throw error;
  }

  const [adminSnapshot, creatorSnapshot] = await Promise.all([
    getDoc(doc(db, "appAdmins", target.uid)),
    getDoc(doc(db, "authorizedTripCreators", target.uid))
  ]);
  if (adminSnapshot.exists() && adminSnapshot.data()?.enabled === true) {
    const error = new Error("User is already an App Admin");
    error.code = "already-app-admin";
    throw error;
  }
  if (creatorSnapshot.exists() && creatorSnapshot.data()?.enabled === true) {
    const error = new Error("User is already a Trip Creator");
    error.code = "already-creator";
    throw error;
  }

  await setDoc(doc(db, "authorizedTripCreators", target.uid), {
    uid: target.uid,
    enabled: true,
    email,
    displayName: clean(target.displayName),
    photoURL: clean(target.photoURL),
    grantedBy: user.uid,
    grantedAt: serverTimestamp()
  });

  try {
    window.dispatchEvent(new CustomEvent("app-trip-creator-changed", {
      detail: { uid: target.uid, enabled: true }
    }));
  } catch (error) {}

  return {
    uid: target.uid,
    email,
    displayName: clean(target.displayName),
    photoURL: clean(target.photoURL),
    enabled: true
  };
}

export async function revokeTripCreator(uidInput, { user: userInput = null } = {}) {
  const user = await requireAppAdmin(userInput);
  const uid = clean(uidInput);
  if (!uid) {
    const error = new Error("Missing creator UID");
    error.code = "invalid-user";
    throw error;
  }
  await deleteDoc(doc(db, "authorizedTripCreators", uid));
  try {
    window.dispatchEvent(new CustomEvent("app-trip-creator-changed", {
      detail: { uid, enabled: false, actorUid: user.uid }
    }));
  } catch (error) {}
  return { uid, enabled: false };
}
