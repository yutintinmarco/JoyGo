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

function activityPayload({ user, teamKey, teamLabel, color, reset = false }) {
  return {
    type: "trip.team.color_updated",
    actionType: "trip.team.color_updated",
    category: "itinerary",
    title: "更新 Team 顏色",
    summary: reset
      ? `${teamLabel || teamKey} 已還原預設顏色`
      : `${teamLabel || teamKey} 已更新為 ${color}`,
    actorUid: user.uid,
    actorName: clean(user.displayName),
    actorEmail: clean(user.email).toLowerCase(),
    teamKey,
    teamLabel: teamLabel || teamKey,
    color: reset ? "" : color,
    createdAt: serverTimestamp()
  };
}

export async function updateTeamColor(tripIdInput, teamKeyInput, colorInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const teamKey = clean(teamKeyInput);
  const color = normalizeHex(colorInput);
  const user = await requireUser(userInput);

  assertCloudOperationAvailable("Team 顏色設定");
  if (!tripId || !teamKey) {
    const error = new Error("Missing trip or Team");
    error.code = "invalid-team";
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
  const travellers = generalData?.travellers && typeof generalData.travellers === "object" ? clone(generalData.travellers) : {};
  if (!travellers[teamKey] || typeof travellers[teamKey] !== "object") {
    const error = new Error("Team not found");
    error.code = "team-not-found";
    throw error;
  }

  travellers[teamKey] = { ...travellers[teamKey], color };
  Object.values(travellers).forEach(item => { if (item && typeof item === "object") delete item.sortOrder; });
  const activityRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(generalRef, {
    travellers,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(activityRef, activityPayload({
    user,
    teamKey,
    teamLabel: clean(travellers[teamKey]?.label),
    color
  }));
  await batch.commit();
  return { tripId, teamKey, color };
}

export async function resetTeamColor(tripIdInput, teamKeyInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const teamKey = clean(teamKeyInput);
  const user = await requireUser(userInput);

  assertCloudOperationAvailable("Team 顏色設定");
  if (!tripId || !teamKey) {
    const error = new Error("Missing trip or Team");
    error.code = "invalid-team";
    throw error;
  }

  await requireManager(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const generalData = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const travellers = generalData?.travellers && typeof generalData.travellers === "object" ? clone(generalData.travellers) : {};
  if (!travellers[teamKey] || typeof travellers[teamKey] !== "object") {
    const error = new Error("Team not found");
    error.code = "team-not-found";
    throw error;
  }

  delete travellers[teamKey].color;
  Object.values(travellers).forEach(item => { if (item && typeof item === "object") delete item.sortOrder; });
  const activityRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(generalRef, {
    travellers,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(activityRef, activityPayload({
    user,
    teamKey,
    teamLabel: clean(travellers[teamKey]?.label),
    color: "",
    reset: true
  }));
  await batch.commit();
  return { tripId, teamKey, color: "" };
}
