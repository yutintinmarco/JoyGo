import { db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import { assertCloudOperationAvailable } from "./cloud-safety-service.js";
import {
  collection,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch
} from "./firestore-observed-service.js";

const MANAGER_ROLES = new Set(["owner", "admin"]);

function clean(value) { return String(value ?? "").trim(); }
function normalizeHex(value) {
  const raw = clean(value).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : "";
}
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

async function requireUser(input = null) {
  const user = input || getCurrentUser() || await waitForInitialAuth();
  if (!user?.uid) {
    const error = new Error("Google sign-in required");
    error.code = "auth-required";
    throw error;
  }
  return user;
}

async function requireManager(tripId, user) {
  const memberSnap = await getDoc(doc(db, "trips", tripId, "members", user.uid));
  const role = memberSnap.exists() ? clean(memberSnap.data()?.role).toLowerCase() : "";
  if (!MANAGER_ROLES.has(role)) {
    const error = new Error("Insufficient role");
    error.code = "insufficient-role";
    error.role = role;
    throw error;
  }
  return role;
}

function activityPayload({ user, cityKey, cityLabel, color, reset = false }) {
  return {
    type: "trip.destination.color_updated",
    actionType: "trip.destination.color_updated",
    category: "itinerary",
    title: "更新目的地顏色",
    summary: reset
      ? `${cityLabel || cityKey} 已還原預設顏色`
      : `${cityLabel || cityKey} 已更新為 ${color}`,
    actorUid: user.uid,
    actorName: clean(user.displayName),
    actorEmail: clean(user.email).toLowerCase(),
    cityKey,
    cityLabel: cityLabel || cityKey,
    color: reset ? "" : color,
    createdAt: serverTimestamp()
  };
}

export async function updateDestinationColor(tripIdInput, cityKeyInput, colorInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const cityKey = clean(cityKeyInput);
  const color = normalizeHex(colorInput);
  const user = await requireUser(userInput);

  assertCloudOperationAvailable("目的地顏色設定");
  if (!tripId || !cityKey) {
    const error = new Error("Missing trip or destination");
    error.code = "invalid-destination";
    throw error;
  }
  if (!color) {
    const error = new Error("Invalid colour");
    error.code = "invalid-colour";
    throw error;
  }

  await requireManager(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const generalData = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const cities = generalData?.cities && typeof generalData.cities === "object" ? clone(generalData.cities) : {};
  if (!cities[cityKey] || typeof cities[cityKey] !== "object") {
    const error = new Error("Destination not found");
    error.code = "destination-not-found";
    throw error;
  }

  cities[cityKey] = { ...cities[cityKey], color };
  const activityRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(generalRef, {
    cities,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(activityRef, activityPayload({
    user,
    cityKey,
    cityLabel: clean(cities[cityKey]?.label),
    color
  }));
  await batch.commit();
  return { tripId, cityKey, color };
}

export async function resetDestinationColor(tripIdInput, cityKeyInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const cityKey = clean(cityKeyInput);
  const user = await requireUser(userInput);

  assertCloudOperationAvailable("目的地顏色設定");
  if (!tripId || !cityKey) {
    const error = new Error("Missing trip or destination");
    error.code = "invalid-destination";
    throw error;
  }

  await requireManager(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const generalData = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const cities = generalData?.cities && typeof generalData.cities === "object" ? clone(generalData.cities) : {};
  if (!cities[cityKey] || typeof cities[cityKey] !== "object") {
    const error = new Error("Destination not found");
    error.code = "destination-not-found";
    throw error;
  }

  delete cities[cityKey].color;
  const activityRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(generalRef, {
    cities,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(activityRef, activityPayload({
    user,
    cityKey,
    cityLabel: clean(cities[cityKey]?.label),
    color: "",
    reset: true
  }));
  await batch.commit();
  return { tripId, cityKey, color: "" };
}
