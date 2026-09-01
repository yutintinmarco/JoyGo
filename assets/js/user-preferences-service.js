import { db } from "./firebase-service.js";
import { subscribeAuthState } from "./auth-service.js";
import { doc, getDoc, serverTimestamp, setDoc } from "./firestore-observed-service.js";

const LOCAL_THEME = "trip_theme";
const LOCAL_FONT = "trip_font_scale";
let currentUid = "";
let currentPreferences = readLocalPreferences();
const subscribers = new Set();

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function validTheme(value) { return ["auto", "light", "dark"].includes(value) ? value : "auto"; }

function readLocalPreferences() {
  let theme = "auto";
  let fontScale = 1;
  try { theme = validTheme(localStorage.getItem(LOCAL_THEME) || "auto"); } catch (error) {}
  try { fontScale = clamp(Number(localStorage.getItem(LOCAL_FONT)) || 1, .85, 1.30); } catch (error) {}
  return { theme, fontScale };
}

function saveLocal(preferences) {
  try { localStorage.setItem(LOCAL_THEME, validTheme(preferences.theme)); } catch (error) {}
  try { localStorage.setItem(LOCAL_FONT, String(clamp(Number(preferences.fontScale) || 1, .85, 1.30))); } catch (error) {}
}

function publish(source = "local") {
  const detail = { preferences: { ...currentPreferences }, source };
  window.__appPreferences = detail.preferences;
  window.dispatchEvent(new CustomEvent("app-preferences-state", { detail }));
  subscribers.forEach(callback => {
    try { callback(detail.preferences, source); } catch (error) { console.error("Preference subscriber", error); }
  });
}

async function loadCloudPreferences(uid) {
  if (!uid) return;
  try {
    const snapshot = await getDoc(doc(db, "users", uid, "preferences", "app"));
    if (!snapshot.exists()) return;
    const data = snapshot.data() || {};
    currentPreferences = {
      theme: validTheme(data.theme ?? currentPreferences.theme),
      fontScale: clamp(Number(data.fontScale ?? currentPreferences.fontScale) || 1, .85, 1.30)
    };
    saveLocal(currentPreferences);
    publish("cloud");
  } catch (error) {
    if (error?.code !== "permission-denied") console.warn("Unable to load user preferences", error);
  }
}

subscribeAuthState(user => {
  currentUid = user?.uid || "";
  if (currentUid) loadCloudPreferences(currentUid);
});

export function getPreferences() { return { ...currentPreferences }; }

export function subscribePreferences(callback, { immediate = true } = {}) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  if (immediate) callback({ ...currentPreferences }, "local");
  return () => subscribers.delete(callback);
}

export async function updatePreferences(patch = {}) {
  currentPreferences = {
    theme: validTheme(patch.theme ?? currentPreferences.theme),
    fontScale: clamp(Number(patch.fontScale ?? currentPreferences.fontScale) || 1, .85, 1.30)
  };
  saveLocal(currentPreferences);
  publish("local");
  if (!currentUid) return currentPreferences;
  try {
    await setDoc(doc(db, "users", currentUid, "preferences", "app"), {
      ...currentPreferences,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } catch (error) {
    if (error?.code !== "permission-denied") console.warn("Unable to save user preferences", error);
  }
  return currentPreferences;
}
