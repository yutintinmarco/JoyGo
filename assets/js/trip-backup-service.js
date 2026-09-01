import { auth, db } from "./firebase-service.js";
import { normalizePortableTrip, normalizeTravellers } from "./trip-schema-service.js";
import { assertCloudOperationAvailable, beginCloudOperation, endCloudOperation } from "./cloud-safety-service.js";
import { acquireTripOperation, releaseTripOperation } from "./trip-operation-service.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch
} from "./firestore-observed-service.js";

const WRITE_CHUNK_SIZE = 8;
const SNAPSHOT_SOFT_LIMIT_BYTES = 760_000;
const SNAPSHOT_LIST_LIMIT = 10;
const MANAGE_ROLES = new Set(["owner", "admin"]);
const RESTORE_PREFLIGHT_TIMEOUT_MS = 14000;

function emitRestoreProgress(onProgress, stage, completed, detail = "") {
  if (typeof onProgress !== "function") return;
  onProgress({ completed: Math.max(0, Math.min(1, Number(completed) || 0)), total: 1, stage, detail });
}
function restorePreflightTimeout(stage, timeoutMs = RESTORE_PREFLIGHT_TIMEOUT_MS) {
  const error = new Error(`${stage} timed out before restore writes started`);
  error.code = "restore-preflight-timeout";
  error.stage = stage;
  error.timeoutMs = timeoutMs;
  error.mutationStarted = false;
  return error;
}
async function awaitRestorePreflight(promise, { stage, timeoutMs = RESTORE_PREFLIGHT_TIMEOUT_MS } = {}) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(restorePreflightTimeout(stage || "Restore preflight", timeoutMs)), Math.max(1000, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireRestoreOperationWithTimeout(tripId, user, { timeoutMs = 16000 } = {}) {
  const pending = acquireTripOperation(tripId, "restore", user);
  let timer = null;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Restore operation lock timed out");
          error.code = "restore-operation-timeout";
          error.stage = "取得旅程操作鎖";
          error.timeoutMs = timeoutMs;
          error.mutationStarted = false;
          reject(error);
        }, Math.max(1000, timeoutMs));
      })
    ]);
  } catch (error) {
    if (error?.code === "restore-operation-timeout") {
      pending.then(lock => releaseTripOperation(lock, user)).catch(() => {});
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clean(value) { return String(value ?? "").trim(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function safeArray(value) { return Array.isArray(value) ? value : []; }
function approxJsonBytes(value) {
  try { return new Blob([JSON.stringify(value)]).size; } catch (error) { return Infinity; }
}
function nowId(prefix = "snapshot") {
  const d = new Date();
  const stamp = [
    d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"), "_",
    String(d.getHours()).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"), String(d.getSeconds()).padStart(2, "0")
  ].join("");
  return `${prefix}_${stamp}_${Math.random().toString(36).slice(2, 7)}`;
}
async function requireUser(userInput = null) {
  if (userInput?.uid) return userInput;
  if (auth?.currentUser?.uid) return auth.currentUser;
  try {
    if (typeof auth?.authStateReady === "function") await auth.authStateReady();
  } catch (error) {
    console.warn("Unable to wait for Firebase Auth state", error);
  }
  if (auth?.currentUser?.uid) return auth.currentUser;
  const error = new Error("Google sign-in required");
  error.code = "auth-required";
  throw error;
}
function roleLabel(role) {
  return ({ owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" })[role] || "";
}
async function getRole(tripId, user) {
  const memberSnap = await getDoc(doc(db, "trips", tripId, "members", user.uid));
  return memberSnap.exists() ? clean(memberSnap.data()?.role) : "";
}
async function requireManageRole(tripId, user) {
  const role = await getRole(tripId, user);
  if (!MANAGE_ROLES.has(role)) {
    const error = new Error("Owner or Admin role required");
    error.code = "insufficient-role";
    error.role = role;
    throw error;
  }
  return role;
}
function opSet(ref, data, options) { return { type: "set", ref, data, options }; }
function opDelete(ref) { return { type: "delete", ref }; }
async function commitOps(ops, onProgress = null, progressBase = 0, progressTotal = ops.length) {
  if (!ops.length) return;
  let completed = 0;
  for (let offset = 0; offset < ops.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = ops.slice(offset, offset + WRITE_CHUNK_SIZE);
    const batch = writeBatch(db);
    chunk.forEach(op => {
      if (op.type === "delete") batch.delete(op.ref);
      else batch.set(op.ref, op.data, op.options || {});
    });
    await batch.commit();
    completed += chunk.length;
    if (typeof onProgress === "function") {
      onProgress({ completed: progressBase + completed, total: Math.max(progressTotal, progressBase + completed) });
    }
  }
}
function stripAudit(data = {}) {
  const output = { ...clone(data) };
  ["createdAt", "createdBy", "updatedAt", "updatedBy"].forEach(key => delete output[key]);
  return output;
}
function stripTripOperational(data = {}) {
  const output = { ...clone(data) };
  [
    "revision", "memberUids", "memberCount", "createdBy", "createdAt", "updatedBy", "updatedAt",
    "archived", "archivedAt", "archivedBy",
    "globalLocked", "globalLockedAt", "globalLockedBy", "globalLockedByName",
    "globalUnlockedAt", "globalUnlockedBy", "globalUnlockedByName",
    "contentHash", "contentHashVersion", "importState",
    "lastImportMode", "lastSnapshotId", "importedBy", "importedAt", "restoredBy", "restoredAt",
    "restoredFromSnapshotId", "restoreState",
    "activeOperationId", "activeOperationType", "activeOperationBy",
    "activeOperationStartedAtMs", "activeOperationStartedAt"
  ].forEach(key => delete output[key]);
  return output;
}
function snapshotTypeLabel(type) {
  return ({
    "pre-import": "匯入前自動備份",
    "pre-restore": "還原前安全備份",
    "manual": "手動備份"
  })[clean(type)] || "旅程備份";
}
function toDateInfo(value) {
  let date = null;
  try {
    if (value?.toDate) date = value.toDate();
    else if (typeof value === "string" || typeof value === "number") date = new Date(value);
    else if (value?.seconds != null) date = new Date(Number(value.seconds) * 1000);
  } catch (error) {}
  if (!date || !Number.isFinite(date.getTime())) return { millis: 0, iso: "", date: null };
  return { millis: date.getTime(), iso: date.toISOString(), date };
}
function structureCounts(structure) {
  const days = safeArray(structure?.days);
  return {
    dayCount: days.length,
    itemCount: days.reduce((sum, day) => sum + safeArray(day?.items).length, 0),
    savedPlaceCount: safeArray(structure?.savedPlaces).length
  };
}

async function readTripStructure(tripId, { onProgress = null, progressBase = 0.04, progressSpan = 0.16 } = {}) {
  const progress = (fraction, stage, detail = "") => emitRestoreProgress(onProgress, stage, progressBase + Math.max(0, Math.min(1, fraction)) * progressSpan, detail);
  const tripRef = doc(db, "trips", tripId);
  progress(0.02, "preflight-trip-root", "正在讀取目前旅程主資料。");
  const tripSnap = await awaitRestorePreflight(getDoc(tripRef), { stage: "讀取目前旅程主資料" });
  if (!tripSnap.exists()) {
    const error = new Error("Firebase trip not found");
    error.code = "trip-not-found";
    throw error;
  }

  progress(0.18, "preflight-trip-collections", "正在讀取 Days、收藏及旅程設定。");
  const [daySnaps, savedSnaps, settingsGeneral, settingsExpenses] = await Promise.all([
    awaitRestorePreflight(getDocs(collection(db, "trips", tripId, "days")), { stage: "讀取 Days" }),
    awaitRestorePreflight(getDocs(collection(db, "trips", tripId, "savedPlaces")), { stage: "讀取收藏" }),
    awaitRestorePreflight(getDoc(doc(db, "trips", tripId, "settings", "general")), { stage: "讀取一般設定" }),
    awaitRestorePreflight(getDoc(doc(db, "trips", tripId, "settings", "expenses")), { stage: "讀取支出設定" })
  ]);

  progress(0.48, "preflight-day-items", `正在讀取 ${daySnaps.docs.length} 日嘅行程項目。`);
  const days = await Promise.all(daySnaps.docs.map(async (daySnap, index) => {
    const itemSnaps = await awaitRestorePreflight(
      getDocs(collection(db, "trips", tripId, "days", daySnap.id, "items")),
      { stage: `讀取 Day ${index + 1} 行程項目` }
    );
    progress(0.48 + ((index + 1) / Math.max(1, daySnaps.docs.length)) * 0.48, "preflight-day-items", `已讀取 ${index + 1} / ${daySnaps.docs.length} 日。`);
    return {
      id: daySnap.id,
      data: daySnap.data(),
      items: itemSnaps.docs.map(itemSnap => ({ id: itemSnap.id, data: itemSnap.data() }))
    };
  }));
  progress(1, "preflight-trip-ready", "目前旅程資料已讀取完成。");
  return {
    tripId,
    tripDoc: tripSnap.data(),
    days,
    savedPlaces: savedSnaps.docs.map(placeSnap => ({ id: placeSnap.id, data: placeSnap.data() })),
    settings: {
      general: settingsGeneral.exists() ? settingsGeneral.data() : {},
      expenses: settingsExpenses.exists() ? settingsExpenses.data() : {}
    }
  };
}

function structureToPortableTrip(structure, { snapshotId = "" } = {}) {
  const tripDoc = structure?.tripDoc || {};
  const general = stripAudit(structure?.settings?.general || {});
  const expenses = stripAudit(structure?.settings?.expenses || {});
  const days = safeArray(structure?.days)
    .map(day => {
      const dayData = stripAudit(day?.data || {});
      const items = safeArray(day?.items)
        .map(item => ({ ...stripAudit(item?.data || {}), itemId: clean(item?.data?.itemId || item?.id) }))
        .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
      return { ...dayData, dayId: clean(dayData.dayId || day?.id), items };
    })
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  const savedItems = safeArray(structure?.savedPlaces)
    .map(place => ({ ...stripAudit(place?.data || {}), placeId: clean(place?.data?.placeId || place?.id) }))
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));
  const savedMeta = general.savedPlacesMeta && typeof general.savedPlacesMeta === "object" ? clone(general.savedPlacesMeta) : {};
  const portable = {
    schemaVersion: Math.max(2, Number(tripDoc.schemaVersion) || 2),
    tripId: clean(structure?.tripId || tripDoc.tripId),
    revision: Math.max(1, Number(tripDoc.revision) || 1),
    meta: {
      tripId: clean(structure?.tripId || tripDoc.tripId),
      titleSmall: clean(tripDoc.titleSmall),
      titleMain: clean(tripDoc.titleHtml || tripDoc.title),
      dateRange: clean(tripDoc.dateRange),
      route: clean(tripDoc.route),
      accentColor: clean(tripDoc.accentColor),
      tripStartIso: clean(tripDoc.startDate),
      tripEndIso: clean(tripDoc.endDate),
      status: clean(tripDoc.status),
      coverImage: clean(tripDoc.coverImage),
      tripIcon: clean(tripDoc.tripIcon || general.tripIcon),
      backgroundImage: clean(tripDoc.backgroundImage || general.backgroundImage),
      tripIconMedia: clone(tripDoc.tripIconMedia || general.tripIconMedia || null),
      backgroundImageMedia: clone(tripDoc.backgroundImageMedia || general.backgroundImageMedia || null),
      coverImageMedia: clone(tripDoc.coverImageMedia || general.coverImageMedia || null),
      travellers: normalizeTravellers(clone(general.travellers || {})),
      cities: clone(general.cities || {}),
      flights: clone(general.flights || []),
      outbound: clone(general.outbound || null),
      inbound: clone(general.inbound || null),
      airlineLogo: clean(general.airlineLogo),
      weather: clone(general.weather || {}),
      hotels: clone(general.hotels || {}),
      accommodations: clone(general.accommodations || []),
      bookingDocuments: clone(general.bookingDocuments || []),
      infoCard: clone(general.infoCard || {}),
      galleryDefaults: clone(general.galleryDefaults || {}),
      featureColors: clone(general.featureColors || {}),
      footerNote: clean(general.footerNote),
      expenses: clone(expenses || {})
    },
    days,
    snacks: {
      ...savedMeta,
      items: savedItems
    },
    exportMeta: {
      source: snapshotId ? "firebase-snapshot" : "firebase-current",
      snapshotId: clean(snapshotId),
      exportedAt: new Date().toISOString()
    }
  };
  return portable;
}

function canonicalPortableExport(sourceInput, { tripId = "", snapshotId = "", revision = 0 } = {}) {
  // v7.7.4.5: Current Trip and Snapshot export now enter through one
  // compatibility boundary. Modern snapshots store the Firestore structure,
  // while older / imported snapshot payloads may already look like Portable
  // JSON. Both shapes are normalised into the same export contract.
  const source = sourceInput?.structure && typeof sourceInput.structure === "object"
    ? sourceInput.structure
    : sourceInput;

  if (source?.tripDoc || source?.settings || safeArray(source?.savedPlaces).length) {
    const structure = { ...source, tripId: clean(source?.tripId || tripId) };
    const portable = structureToPortableTrip(structure, { snapshotId });
    if (revision) portable.revision = Math.max(1, Number(revision) || Number(portable.revision) || 1);
    portable.tripId = clean(portable.tripId || tripId);
    portable.meta = { ...(portable.meta || {}), tripId: clean(portable.tripId || tripId) };
    return portable;
  }

  if (source?.meta || Array.isArray(source?.days) || source?.tripId) {
    const portable = normalizePortableTrip({
      ...clone(source),
      tripId: clean(source?.tripId || source?.meta?.tripId || tripId),
      revision: Math.max(1, Number(revision) || Number(source?.revision) || 1)
    });
    portable.exportMeta = {
      ...(portable.exportMeta && typeof portable.exportMeta === "object" ? portable.exportMeta : {}),
      source: snapshotId ? "firebase-snapshot" : "firebase-current",
      snapshotId: clean(snapshotId),
      exportedAt: new Date().toISOString()
    };
    return portable;
  }

  const error = new Error("Snapshot payload format is not supported");
  error.code = "snapshot-invalid";
  throw error;
}


function portableTripToStructure(portableInput, { expenseSettings = null } = {}) {
  const portable = normalizePortableTrip(clone(portableInput) || {});
  const tripId = clean(portable?.tripId || portable?.meta?.tripId);
  const meta = portable?.meta || {};
  if (!tripId || !safeArray(portable?.days).every(day => Array.isArray(day?.items))) {
    const error = new Error("Local Trip data is incomplete");
    error.code = "local-export-incomplete";
    throw error;
  }
  const snackMeta = clone(portable?.snacks || {}) || {};
  delete snackMeta.items;
  const tripDoc = {
    schemaVersion: Math.max(2, Number(portable.schemaVersion) || 2),
    tripId,
    revision: Math.max(1, Number(portable.revision) || 1),
    titleSmall: clean(meta.titleSmall),
    title: clean(meta.titleMain),
    titleHtml: clean(meta.titleMain),
    dateRange: clean(meta.dateRange),
    route: clean(meta.route),
    accentColor: clean(meta.accentColor),
    startDate: clean(meta.tripStartIso),
    endDate: clean(meta.tripEndIso),
    status: clean(meta.status),
    coverImage: clean(meta.coverImage),
    tripIcon: clean(meta.tripIcon),
    backgroundImage: clean(meta.backgroundImage),
    ...(meta.coverImageMedia ? { coverImageMedia: clone(meta.coverImageMedia) } : {}),
    ...(meta.tripIconMedia ? { tripIconMedia: clone(meta.tripIconMedia) } : {}),
    ...(meta.backgroundImageMedia ? { backgroundImageMedia: clone(meta.backgroundImageMedia) } : {})
  };
  const general = {
    tripIcon: clean(meta.tripIcon),
    backgroundImage: clean(meta.backgroundImage),
    ...(meta.tripIconMedia ? { tripIconMedia: clone(meta.tripIconMedia) } : {}),
    ...(meta.backgroundImageMedia ? { backgroundImageMedia: clone(meta.backgroundImageMedia) } : {}),
    ...(meta.coverImageMedia ? { coverImageMedia: clone(meta.coverImageMedia) } : {}),
    travellers: clone(meta.travellers || {}),
    cities: clone(meta.cities || {}),
    flights: clone(meta.flights || []),
    outbound: clone(meta.outbound || null),
    inbound: clone(meta.inbound || null),
    airlineLogo: clean(meta.airlineLogo),
    weather: clone(meta.weather || {}),
    hotels: clone(meta.hotels || {}),
    accommodations: clone(meta.accommodations || []),
    bookingDocuments: clone(meta.bookingDocuments || []),
    infoCard: clone(meta.infoCard || {}),
    galleryDefaults: clone(meta.galleryDefaults || {}),
    featureColors: clone(meta.featureColors || {}),
    footerNote: clean(meta.footerNote),
    savedPlacesMeta: snackMeta
  };
  const days = safeArray(portable.days).map((day, index) => {
    const dayId = clean(day?.dayId || `day-${index + 1}`);
    const dayData = clone(day) || {};
    const items = safeArray(dayData.items);
    delete dayData.items;
    return {
      id: dayId,
      data: { ...dayData, dayId },
      items: items.map((item, itemIndex) => {
        const itemId = clean(item?.itemId || `${dayId}-item-${itemIndex + 1}`);
        return { id: itemId, data: { ...(clone(item) || {}), itemId } };
      })
    };
  });
  const savedPlaces = safeArray(portable?.snacks?.items).map((place, index) => {
    const placeId = clean(place?.placeId || `saved-${index + 1}`);
    return { id: placeId, data: { ...(clone(place) || {}), placeId } };
  });
  return {
    tripId,
    tripDoc,
    days,
    savedPlaces,
    settings: {
      general,
      expenses: clone(expenseSettings || meta.expenses || {}) || {}
    }
  };
}

export function exportLocalTrip(localTripInput, { role = "" } = {}) {
  const portable = canonicalPortableExport(localTripInput, {
    tripId: clean(localTripInput?.tripId || localTripInput?.meta?.tripId),
    revision: Number(localTripInput?.revision) || 1
  });
  const tripId = clean(portable.tripId || portable?.meta?.tripId);
  const revision = Math.max(1, Number(portable.revision) || 1);
  const structure = portableTripToStructure(portable);
  return {
    tripId,
    revision,
    role: clean(role),
    roleLabel: roleLabel(clean(role)),
    json: portable,
    filename: `${tripId}-r${revision}.json`,
    counts: structureCounts(structure),
    source: "local-live-state"
  };
}

export function exportLocalSnapshotTrip(snapshotInput) {
  const snapshot = snapshotInput || {};
  const payload = snapshot.payload || snapshot.structure || null;
  if (!payload) {
    const error = new Error("Snapshot payload is not cached locally");
    error.code = "snapshot-invalid";
    throw error;
  }
  const tripId = clean(snapshot.tripId || payload?.tripId || payload?.tripDoc?.tripId);
  const revision = Math.max(1, Number(snapshot.sourceRevision) || Number(payload?.tripDoc?.revision) || Number(payload?.revision) || 1);
  const json = canonicalPortableExport(payload, {
    tripId,
    snapshotId: clean(snapshot.snapshotId),
    revision
  });
  return {
    tripId,
    snapshotId: clean(snapshot.snapshotId),
    sourceRevision: revision,
    json,
    filename: `${tripId}-snapshot-r${revision}-${clean(snapshot.snapshotId)}.json`,
    source: "local-snapshot-cache"
  };
}

async function writeSnapshot(tripId, structure, user, { type = "manual", restoreTargetSnapshotId = "" } = {}) {
  const size = approxJsonBytes(structure);
  if (size > SNAPSHOT_SOFT_LIMIT_BYTES) {
    const error = new Error("Current trip is too large for a safe single-document snapshot");
    error.code = "snapshot-too-large";
    error.approxBytes = size;
    throw error;
  }
  const snapshotId = nowId(type === "manual" ? "manual" : "restore");
  const counts = structureCounts(structure);
  await writeBatch(db)
    .set(doc(db, "trips", tripId, "snapshots", snapshotId), {
      snapshotId,
      type,
      sourceRevision: Number(structure?.tripDoc?.revision) || 0,
      title: clean(structure?.tripDoc?.title),
      dayCount: counts.dayCount,
      itemCount: counts.itemCount,
      savedPlaceCount: counts.savedPlaceCount,
      approxBytes: size,
      restoreTargetSnapshotId: clean(restoreTargetSnapshotId),
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      payload: structure
    })
    .commit();
  return { snapshotId, type, sourceRevision: Number(structure?.tripDoc?.revision) || 0, ...counts, approxBytes: size };
}

function staleDeleteOps(current, target, tripId) {
  const ops = [];
  const targetDays = new Map(safeArray(target?.days).map(day => [day.id, new Set(safeArray(day?.items).map(item => item.id))]));
  safeArray(current?.days).forEach(day => {
    const nextItems = targetDays.get(day.id);
    safeArray(day?.items).forEach(item => {
      if (!nextItems || !nextItems.has(item.id)) ops.push(opDelete(doc(db, "trips", tripId, "days", day.id, "items", item.id)));
    });
    if (!targetDays.has(day.id)) ops.push(opDelete(doc(db, "trips", tripId, "days", day.id)));
  });
  const targetPlaces = new Set(safeArray(target?.savedPlaces).map(place => place.id));
  safeArray(current?.savedPlaces).forEach(place => {
    if (!targetPlaces.has(place.id)) ops.push(opDelete(doc(db, "trips", tripId, "savedPlaces", place.id)));
  });
  return ops;
}

function restoreWriteOps(target, tripId, user) {
  const ops = [];
  safeArray(target?.days).forEach(day => {
    const dayData = { ...stripAudit(day.data || {}), dayId: clean(day?.data?.dayId || day.id), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
    ops.push(opSet(doc(db, "trips", tripId, "days", day.id), dayData));
    safeArray(day?.items).forEach(item => {
      const itemData = { ...stripAudit(item.data || {}), itemId: clean(item?.data?.itemId || item.id), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
      ops.push(opSet(doc(db, "trips", tripId, "days", day.id, "items", item.id), itemData));
    });
  });
  safeArray(target?.savedPlaces).forEach(place => {
    const placeData = { ...stripAudit(place.data || {}), placeId: clean(place?.data?.placeId || place.id), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
    ops.push(opSet(doc(db, "trips", tripId, "savedPlaces", place.id), placeData));
  });
  ["general", "expenses"].forEach(settingId => {
    const data = { ...stripAudit(target?.settings?.[settingId] || {}), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
    ops.push(opSet(doc(db, "trips", tripId, "settings", settingId), data));
  });
  return ops;
}

export async function getTripBackupRole(tripIdInput, { user: userInput = null } = {}) {
  const user = await requireUser(userInput);
  const tripId = clean(tripIdInput);
  if (!tripId) throw new Error("Missing tripId");
  const role = await getRole(tripId, user);
  return { tripId, role, roleLabel: roleLabel(role), canManage: MANAGE_ROLES.has(role) };
}

export async function exportCurrentTrip(tripIdInput, { user: userInput = null } = {}) {
  const user = await requireUser(userInput);
  const tripId = clean(tripIdInput);
  if (!tripId) throw new Error("Missing tripId");
  const structure = await readTripStructure(tripId);
  const role = await getRole(tripId, user);
  if (!role) {
    const error = new Error("Current user is not a member of this trip");
    error.code = "insufficient-role";
    throw error;
  }
  const json = canonicalPortableExport(structure, { tripId });
  const revision = Math.max(1, Number(structure?.tripDoc?.revision) || 1);
  return {
    tripId,
    revision,
    role,
    roleLabel: roleLabel(role),
    json,
    filename: `${tripId}-r${revision}.json`,
    counts: structureCounts(structure)
  };
}

export async function listTripSnapshots(tripIdInput, { user: userInput = null, maxItems = SNAPSHOT_LIST_LIMIT, knownRole = "" } = {}) {
  const user = await requireUser(userInput);
  const tripId = clean(tripIdInput);
  if (!tripId) throw new Error("Missing tripId");
  const suppliedRole = clean(knownRole);
  const role = MANAGE_ROLES.has(suppliedRole) ? suppliedRole : await requireManageRole(tripId, user);
  const q = query(
    collection(db, "trips", tripId, "snapshots"),
    orderBy("createdAt", "desc"),
    limit(Math.max(1, Math.min(30, Number(maxItems) || SNAPSHOT_LIST_LIMIT)))
  );
  const snaps = await getDocs(q);
  const snapshots = snaps.docs.map(snap => {
    const data = snap.data() || {};
    const payload = data.payload || null;
    const counts = {
      dayCount: Number(data.dayCount) || structureCounts(payload).dayCount,
      itemCount: Number(data.itemCount) || structureCounts(payload).itemCount,
      savedPlaceCount: Number(data.savedPlaceCount) || structureCounts(payload).savedPlaceCount
    };
    const dateInfo = toDateInfo(data.createdAt);
    return {
      snapshotId: snap.id,
      type: clean(data.type),
      typeLabel: snapshotTypeLabel(data.type),
      sourceRevision: Number(data.sourceRevision) || Number(payload?.tripDoc?.revision) || 0,
      createdBy: clean(data.createdBy),
      createdAtMillis: dateInfo.millis,
      createdAtIso: dateInfo.iso,
      title: clean(data.title || payload?.tripDoc?.title),
      approxBytes: Number(data.approxBytes) || approxJsonBytes(payload),
      restoreTargetSnapshotId: clean(data.restoreTargetSnapshotId),
      payload,
      tripId,
      ...counts
    };
  });
  return { tripId, role, roleLabel: roleLabel(role), canManage: true, snapshots };
}

export async function getTripSnapshot(tripIdInput, snapshotIdInput, { user: userInput = null } = {}) {
  const user = await requireUser(userInput);
  const tripId = clean(tripIdInput);
  const snapshotId = clean(snapshotIdInput);
  if (!tripId || !snapshotId) throw new Error("Missing snapshot reference");
  const role = await requireManageRole(tripId, user);
  const snap = await getDoc(doc(db, "trips", tripId, "snapshots", snapshotId));
  if (!snap.exists()) {
    const error = new Error("Snapshot not found");
    error.code = "snapshot-not-found";
    throw error;
  }
  const data = snap.data() || {};
  const payload = data.payload || null;
  if (!payload) {
    const error = new Error("Snapshot payload is missing");
    error.code = "snapshot-invalid";
    throw error;
  }
  const dateInfo = toDateInfo(data.createdAt);
  return {
    tripId,
    role,
    roleLabel: roleLabel(role),
    snapshotId,
    type: clean(data.type),
    typeLabel: snapshotTypeLabel(data.type),
    sourceRevision: Number(data.sourceRevision) || Number(payload?.tripDoc?.revision) || 0,
    createdBy: clean(data.createdBy),
    createdAtMillis: dateInfo.millis,
    createdAtIso: dateInfo.iso,
    title: clean(data.title || payload?.tripDoc?.title),
    approxBytes: Number(data.approxBytes) || approxJsonBytes(payload),
    restoreTargetSnapshotId: clean(data.restoreTargetSnapshotId),
    counts: structureCounts(payload),
    payload
  };
}

export async function exportSnapshotTrip(tripIdInput, snapshotIdInput, { user: userInput = null } = {}) {
  const snapshot = await getTripSnapshot(tripIdInput, snapshotIdInput, { user: userInput });
  const revision = Math.max(1, Number(snapshot.sourceRevision) || Number(snapshot.payload?.revision) || 1);
  const json = canonicalPortableExport(snapshot.payload, {
    tripId: snapshot.tripId,
    snapshotId: snapshot.snapshotId,
    revision
  });
  return {
    ...snapshot,
    json,
    filename: `${snapshot.tripId}-snapshot-r${revision}-${snapshot.snapshotId}.json`
  };
}

export async function createManualSnapshot(tripIdInput, { user: userInput = null } = {}) {
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("建立手動備份");
  const tripId = clean(tripIdInput);
  const localOperationToken = beginCloudOperation({type:"snapshot",tripId,label:"建立手動備份"});
  try {
  if (!tripId) throw new Error("Missing tripId");
  const role = await requireManageRole(tripId, user);
  const structure = await readTripStructure(tripId);
  const result = await writeSnapshot(tripId, structure, user, { type: "manual" });
  const batch = writeBatch(db);
  batch.set(doc(collection(db, "trips", tripId, "activityLogs")), {
    type: "trip.snapshot.manual",
    actionType: "trip.snapshot.manual",
    category: "backup",
    title: "建立手動備份",
    summary: `Snapshot · Revision ${result.sourceRevision}`,
    actorUid: user.uid,
    actorName: clean(user.displayName),
    snapshotId: result.snapshotId,
    revision: result.sourceRevision,
    createdAt: serverTimestamp()
  });
  await batch.commit();
  return { tripId, role, roleLabel: roleLabel(role), ...result };
  } finally {
    endCloudOperation(localOperationToken);
  }
}
export async function restoreTripSnapshot(tripIdInput, snapshotIdInput, { user: userInput = null, onProgress = null } = {}) {
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("還原旅程");
  const tripId = clean(tripIdInput);
  const snapshotId = clean(snapshotIdInput);
  if (!tripId || !snapshotId) throw new Error("Missing snapshot reference");
  const localOperationToken = beginCloudOperation({type:"restore",tripId,label:"還原旅程"});
  let serverOperation = null;
  let mutationStarted = false;
  try {
  emitRestoreProgress(onProgress, "preflight-role", 0.06, "正在驗證 Owner / Admin 權限。");
  const role = await awaitRestorePreflight(requireManageRole(tripId, user), { stage: "驗證旅程權限" });
  emitRestoreProgress(onProgress, "preflight-lock", 0.10, "正在確認旅程未被全域鎖定。");
  const currentRoot = await awaitRestorePreflight(getDoc(doc(db, "trips", tripId)), { stage: "確認旅程鎖定狀態" });
  if (currentRoot.exists() && currentRoot.data()?.globalLocked === true) {
    const error = new Error("Trip is globally locked"); error.code = "trip-global-locked"; throw error;
  }
  emitRestoreProgress(onProgress, "preflight-operation", 0.14, "正在取得旅程操作鎖。");
  serverOperation = await acquireRestoreOperationWithTimeout(tripId,user);
  emitRestoreProgress(onProgress, "preflight-snapshot", 0.18, "正在讀取所選 Snapshot。");
  const snapshot = await awaitRestorePreflight(getTripSnapshot(tripId, snapshotId, { user }), { stage: "讀取所選 Snapshot" });
  const target = snapshot.payload;
  const current = await readTripStructure(tripId, { onProgress, progressBase: 0.20, progressSpan: 0.12 });

  emitRestoreProgress(onProgress, "preflight-safety-snapshot", 0.33, "正在建立還原前安全 Snapshot。");
  const safety = await writeSnapshot(tripId, current, user, {
    type: "pre-restore",
    restoreTargetSnapshotId: snapshotId
  });
  emitRestoreProgress(onProgress, "safety-snapshot", 0.36, "還原前安全 Snapshot 已建立。");

  const tripRef = doc(db, "trips", tripId);
  const currentTrip = current.tripDoc || {};
  const targetTrip = target?.tripDoc || {};
  const nextRevision = Math.max(1, Number(currentTrip.revision) || 0) + 1;
  const restoredTripContent = stripTripOperational(targetTrip);

  // Phase 2E loader suppresses partial renders while a restore is writing many
  // documents. Mark the trip as restoring before replacing parent/content docs.
  mutationStarted = true;
  await writeBatch(db).set(tripRef, {
    restoreState: "restoring",
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  }, { merge: true }).commit();

  await writeBatch(db).set(tripRef, {
    ...restoredTripContent,
    revision: nextRevision,
    memberUids: safeArray(currentTrip.memberUids),
    memberCount: Number(currentTrip.memberCount) || safeArray(currentTrip.memberUids).length,
    createdBy: clean(currentTrip.createdBy),
    createdAt: currentTrip.createdAt || serverTimestamp(),
    archived: currentTrip.archived === true,
    archivedAt: currentTrip.archivedAt || null,
    archivedBy: clean(currentTrip.archivedBy),
    globalLocked: currentTrip.globalLocked === true,
    globalLockedAt: currentTrip.globalLockedAt || null,
    globalLockedBy: clean(currentTrip.globalLockedBy),
    globalLockedByName: clean(currentTrip.globalLockedByName),
    globalUnlockedAt: currentTrip.globalUnlockedAt || null,
    globalUnlockedBy: clean(currentTrip.globalUnlockedBy),
    globalUnlockedByName: clean(currentTrip.globalUnlockedByName),
    contentHash: "",
    contentHashVersion: 1,
    importState: "ready",
    restoreState: "restoring",
    lastImportMode: "snapshot-restore",
    lastSnapshotId: safety.snapshotId,
    restoredFromSnapshotId: snapshotId,
    restoredBy: user.uid,
    restoredAt: serverTimestamp(),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: false }).commit();
  emitRestoreProgress(onProgress, "trip", 0.48, "Trip metadata 同 Revision 正在切換。");

  const writes = restoreWriteOps(target, tripId, user);
  const deletes = staleDeleteOps(current, target, tripId);
  const totalContentOps = Math.max(1, writes.length + deletes.length);
  let lastContentCompleted = 0;
  const contentProgress = ({ completed, total }) => {
    lastContentCompleted = completed;
    if (typeof onProgress === "function") {
      const ratio = Math.min(1, completed / Math.max(1, total));
      emitRestoreProgress(onProgress, "content", 0.48 + ratio * 0.42, `${completed}/${total}`);
    }
  };
  await commitOps(writes, contentProgress, 0, totalContentOps);
  await commitOps(deletes, contentProgress, writes.length, totalContentOps);
  if (typeof onProgress === "function" && !lastContentCompleted) emitRestoreProgress(onProgress, "content", 0.90, "0/0");

  const finalBatch = writeBatch(db);
  finalBatch.set(doc(collection(db, "trips", tripId, "activityLogs")), {
    type: "trip.snapshot.restore",
    actionType: "trip.snapshot.restore",
    category: "backup",
    title: "還原旅程版本",
    summary: `由 Revision ${snapshot.sourceRevision || 0} 還原 · 新 Revision ${nextRevision}`,
    actorUid: user.uid,
    actorName: clean(user.displayName),
    snapshotId,
    safetySnapshotId: safety.snapshotId,
    sourceRevision: snapshot.sourceRevision,
    revision: nextRevision,
    createdAt: serverTimestamp()
  });
  finalBatch.set(tripRef, {
    restoreState: "ready",
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  }, { merge: true });
  await finalBatch.commit();
  emitRestoreProgress(onProgress, "done", 0.99, "Firebase restore writes 已完成。");

  return {
    tripId,
    role,
    roleLabel: roleLabel(role),
    snapshotId,
    safetySnapshotId: safety.snapshotId,
    sourceRevision: snapshot.sourceRevision,
    revision: nextRevision,
    counts: structureCounts(target)
  };

  } catch (error) {
    try {
      if (mutationStarted) {
        await writeBatch(db).set(doc(db,"trips",tripId),{
          restoreState:"failed",updatedAt:serverTimestamp(),updatedBy:user.uid
        },{merge:true}).commit();
      }
    } catch (stateError) {
      console.warn("Unable to mark failed restore",stateError);
    }
    throw error;
  } finally {
    if (serverOperation) await releaseTripOperation(serverOperation,user);
    endCloudOperation(localOperationToken);
  }
}
// =========================================================================
// v7.9.2.0 · Full Backup v1 data contract + Phase 3A media package bridge
// =========================================================================
const FULL_BACKUP_FORMAT = "travel-full-backup";
const FULL_BACKUP_VERSION = 1;
const FULL_BACKUP_SCOPES = new Set(["all", "trip", "expenses"]);

const FULL_BACKUP_INTEGRITY_ALGORITHM = "SHA-256";

function stableBackupValue(value) {
  if (Array.isArray(value)) return value.map(stableBackupValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableBackupValue(value[key])]));
  }
  return value;
}

function stableBackupStringify(value) {
  return JSON.stringify(stableBackupValue(value));
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) {
    const error = new Error("SHA-256 is unavailable in this browser");
    error.code = "backup-integrity-unavailable";
    throw error;
  }
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function attachFullBackupIntegrity(jsonInput) {
  // Integrity calculation is read-only. A shallow shell is enough to omit the
  // integrity field without duplicating the entire Trip / expense payload.
  const payload = jsonInput && typeof jsonInput === "object" ? { ...jsonInput } : {};
  delete payload.integrity;
  const payloadHash = await sha256Hex(stableBackupStringify(payload));
  return {
    ...payload,
    integrity: {
      algorithm: FULL_BACKUP_INTEGRITY_ALGORITHM,
      scope: "backup-without-integrity",
      payloadHash
    }
  };
}

export async function verifyFullBackupIntegrity(rawInput) {
  const backup = normalizeFullBackupInput(rawInput);
  const integrity = backup.integrity && typeof backup.integrity === "object" ? backup.integrity : null;
  if (!integrity?.payloadHash) return { verified:false, legacy:true, algorithm:"" };
  if (clean(integrity.algorithm).toUpperCase() !== FULL_BACKUP_INTEGRITY_ALGORITHM) {
    const error = new Error("Unsupported Full Backup integrity algorithm");
    error.code = "backup-integrity-unsupported";
    throw error;
  }
  const payload = { ...backup };
  delete payload.integrity;
  const actual = await sha256Hex(stableBackupStringify(payload));
  const expected = clean(integrity.payloadHash).toLowerCase();
  if (!expected || actual !== expected) {
    const error = new Error("Full Backup integrity verification failed");
    error.code = "backup-integrity-mismatch";
    error.expectedHash = expected;
    error.actualHash = actual;
    throw error;
  }
  return { verified:true, legacy:false, algorithm:FULL_BACKUP_INTEGRITY_ALGORITHM, payloadHash:actual };
}

export function evaluateLocalBackupFreshness(localTripInput, expenseSnapshotInput, tripFreshnessInput = {}) {
  const localTrip = localTripInput || {};
  const expenseSnapshot = expenseSnapshotInput || {};
  const tripMeta = localTrip?.cloudMeta || {};
  const tripFreshness = tripFreshnessInput || {};
  const tripServerConfirmed = tripFreshness.serverConfirmed === true || tripMeta.serverConfirmed === true;
  const tripPendingWrites = tripFreshness.hasPendingWrites === true || tripMeta.hasPendingWrites === true;
  const expenseFreshness = expenseSnapshot?.freshness || {};
  const expenseServerConfirmed = expenseFreshness.serverConfirmed === true;
  const expensePendingWrites = expenseFreshness.hasPendingWrites === true;
  const online = typeof navigator === "undefined" ? true : navigator.onLine !== false;
  const serverConfirmed = tripServerConfirmed && expenseServerConfirmed && !tripPendingWrites && !expensePendingWrites;
  const archiveGrade = online && serverConfirmed;
  return {
    status: archiveGrade ? "server-confirmed" : "last-synced",
    archiveGrade,
    online,
    evaluatedAt: new Date().toISOString(),
    trip: {
      serverConfirmed: tripServerConfirmed && !tripPendingWrites,
      hasPendingWrites: tripPendingWrites,
      source: clean(tripFreshness.source || tripMeta.source || "local"),
      updatedAt: clean(tripFreshness.updatedAt || tripMeta.updatedAt),
      revision: Math.max(1, Number(localTrip?.revision) || 1)
    },
    expenses: {
      serverConfirmed: expenseServerConfirmed && !expensePendingWrites,
      hasPendingWrites: expensePendingWrites,
      capturedAt: clean(expenseSnapshot?.capturedAt),
      sources: clone(expenseFreshness.sources || {}) || {}
    }
  };
}

function fullBackupSerialize(value) {
  if (value == null) return value;
  try {
    if (typeof value?.toDate === "function") {
      const date = value.toDate();
      return { __travelBackupType: "timestamp", iso: date.toISOString() };
    }
  } catch (error) {}
  if (value instanceof Date) return { __travelBackupType: "timestamp", iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(fullBackupSerialize);
  if (typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([key, item]) => {
      if (typeof item !== "undefined") out[key] = fullBackupSerialize(item);
    });
    return out;
  }
  return value;
}

function fullBackupDeserialize(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(fullBackupDeserialize);
  if (typeof value === "object") {
    if (value.__travelBackupType === "timestamp" && value.iso) {
      const date = new Date(String(value.iso));
      return Number.isFinite(date.getTime()) ? date : null;
    }
    const out = {};
    Object.entries(value).forEach(([key, item]) => { out[key] = fullBackupDeserialize(item); });
    return out;
  }
  return value;
}

async function readBackupCollection(tripId, collectionName) {
  const snaps = await getDocs(collection(db, "trips", tripId, collectionName));
  return snaps.docs.map(snap => ({ id: snap.id, data: fullBackupSerialize(snap.data() || {}) }));
}

function fullBackupCountsFromData(data = {}) {
  const structure = fullBackupDeserialize(data.tripStructure || {});
  const tripCounts = structureCounts(structure);
  return {
    ...tripCounts,
    expenseCount: safeArray(data.expenses).length,
    settlementCount: safeArray(data.settlements).length,
    activityLogCount: safeArray(data.activityLogs).length
  };
}

function normalizeFullBackupInput(rawInput) {
  let raw = rawInput;
  if (typeof rawInput === "string") {
    try { raw = JSON.parse(rawInput); }
    catch (error) {
      const invalid = new Error("Backup JSON is invalid");
      invalid.code = "backup-invalid-json";
      throw invalid;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const invalid = new Error("Backup format is invalid");
    invalid.code = "backup-invalid";
    throw invalid;
  }
  const format = clean(raw.backupFormat);
  const version = Number(raw.backupVersion) || 0;
  const tripId = clean(raw.tripId || raw?.trip?.tripId);
  if (format !== FULL_BACKUP_FORMAT || version !== FULL_BACKUP_VERSION || !tripId || !raw.data?.tripStructure) {
    const invalid = new Error("Unsupported Full Backup format");
    invalid.code = "backup-unsupported";
    invalid.backupFormat = format;
    invalid.backupVersion = version;
    throw invalid;
  }
  // One normalized deep copy is enough. v7.9.2.0 separately cloned raw,
  // raw.data and counts, multiplying peak memory during repeated exports.
  const normalized = clone(raw) || {};
  normalized.backupFormat = format;
  normalized.backupVersion = version;
  normalized.tripId = tripId;
  normalized.mediaIncluded = raw.mediaIncluded === true;
  normalized.mediaManifest = safeArray(normalized.mediaManifest);
  normalized.documentManifest = safeArray(normalized.documentManifest);
  normalized.data = normalized.data && typeof normalized.data === "object" ? normalized.data : {};
  normalized.counts = normalized.counts && typeof normalized.counts === "object"
    ? normalized.counts
    : fullBackupCountsFromData(normalized.data);
  return normalized;
}

export function inspectFullBackup(rawInput) {
  const backup = normalizeFullBackupInput(rawInput);
  return {
    valid: true,
    backupFormat: backup.backupFormat,
    backupVersion: backup.backupVersion,
    tripId: backup.tripId,
    sourceRevision: Number(backup.sourceRevision) || Number(fullBackupDeserialize(backup.data.tripStructure)?.tripDoc?.revision) || 0,
    exportedAt: clean(backup.exportedAt),
    mediaIncluded: backup.mediaIncluded,
    counts: { ...(backup.counts || {}), mediaCount: safeArray(backup.mediaManifest).length, documentCount: safeArray(backup.documentManifest).length },
    integrity: backup.integrity?.payloadHash ? { algorithm: clean(backup.integrity.algorithm), present: true } : { algorithm: "", present: false },
    freshness: clone(backup.freshness || {}) || {},
    auditPolicy: "append-only"
  };
}

function stripMediaGenerations(value) {
  if (Array.isArray(value)) return value.map(stripMediaGenerations);
  if (!value || typeof value !== "object") return value;
  const mediaDescriptor = Boolean(clean(value.storagePath) || clean(value.thumbnailStoragePath) || clean(value.source) === "storage");
  const output = {};
  Object.entries(value).forEach(([key, item]) => {
    if (mediaDescriptor && (key === "generation" || key === "thumbnailGeneration")) {
      output[key] = "";
      return;
    }
    output[key] = stripMediaGenerations(item);
  });
  return output;
}

export async function withFullBackupMediaManifest(rawInput, mediaManifestInput = []) {
  // Validate the freshly-created Data Backup, then build one transformed copy.
  // Avoid normalize -> verify(normalize again) -> clone -> strip, which was the
  // main non-media memory amplification path on iOS.
  await verifyFullBackupIntegrity(rawInput);
  const mediaManifest = safeArray(mediaManifestInput).map(item => clone(item)).filter(item => clean(item?.mediaId) && clean(item?.storagePath));
  const next = stripMediaGenerations(rawInput || {});
  next.mediaIncluded = true;
  next.mediaManifest = mediaManifest;
  next.mediaNote = mediaManifest.length
    ? "Media-aware Full Backup package. Media bytes are stored beside trip-data.json inside the ZIP package."
    : "Media-aware Full Backup package. This Trip currently has no Storage media files.";
  next.counts = { ...(next.counts || {}), mediaCount: mediaManifest.length };
  delete next.integrity;
  return attachFullBackupIntegrity(next);
}


export async function withFullBackupDocumentManifest(rawInput, documentManifestInput = []) {
  const backup = normalizeFullBackupInput(rawInput);
  await verifyFullBackupIntegrity(backup);
  const documentManifest = safeArray(documentManifestInput).map(item => clone(item)).filter(item => clean(item?.documentId) && clean(item?.storagePath));
  const next = clone(backup) || {};
  next.documentIncluded = documentManifest.length > 0;
  next.documentManifest = documentManifest;
  next.documentNote = documentManifest.length
    ? "Booking Documents are included in the Full Backup package."
    : "No Firebase Booking Documents are referenced by this Trip.";
  next.counts = { ...(next.counts || {}), documentCount: documentManifest.length };
  delete next.integrity;
  return attachFullBackupIntegrity(next);
}

export async function exportLocalFullBackup(localTripInput, expenseSnapshotInput, {
  user = null,
  role = "",
  tripFreshness = null,
  requireArchiveGrade = false
} = {}) {
  const normalizedRole = clean(role);
  if (!MANAGE_ROLES.has(normalizedRole)) {
    const error = new Error("Owner or Admin role required");
    error.code = "insufficient-role";
    error.role = normalizedRole;
    throw error;
  }
  const expenseSnapshot = expenseSnapshotInput || {};
  const tripId = clean(localTripInput?.tripId || localTripInput?.meta?.tripId);
  if (!tripId || clean(expenseSnapshot.tripId) !== tripId || expenseSnapshot.ready !== true) {
    const error = new Error("Local expense data is not fully synchronized");
    error.code = "local-export-incomplete";
    throw error;
  }
  const freshness = evaluateLocalBackupFreshness(localTripInput, expenseSnapshot, tripFreshness || {});
  if (requireArchiveGrade && !freshness.archiveGrade) {
    const error = new Error(freshness.online ? "Backup state is not yet server confirmed" : "Device is offline");
    error.code = freshness.online ? "backup-freshness-unconfirmed" : "backup-freshness-offline";
    error.freshness = freshness;
    throw error;
  }
  const portableTrip = canonicalPortableExport(localTripInput, {
    tripId,
    revision: Number(localTripInput?.revision) || 1
  });
  const structure = portableTripToStructure(portableTrip, { expenseSettings: expenseSnapshot.settings || portableTrip?.meta?.expenses || {} });
  const data = {
    tripStructure: fullBackupSerialize(structure),
    portableTrip,
    expenses: safeArray(expenseSnapshot.expenses),
    settlements: safeArray(expenseSnapshot.settlements),
    activityLogs: safeArray(expenseSnapshot.activityLogs)
  };
  const counts = fullBackupCountsFromData(data);
  const revision = Math.max(1, Number(portableTrip.revision) || 1);
  const baseJson = {
    backupFormat: FULL_BACKUP_FORMAT,
    backupVersion: FULL_BACKUP_VERSION,
    appName: "travel-webapp",
    tripId,
    sourceRevision: revision,
    exportedAt: new Date().toISOString(),
    exportedBy: {
      uid: clean(user?.uid),
      name: clean(user?.displayName),
      email: clean(user?.email).toLowerCase()
    },
    mediaIncluded: false,
    mediaManifest: [],
    documentIncluded: false,
    documentManifest: [],
    mediaNote: "Data-only Full Backup v1. Phase 3A will add media files through a versioned backup package.",
    accessPolicy: "Trip membership / roles are not restored from this backup.",
    activityLogPolicy: "Activity logs are backed up for archival integrity. Existing audit logs remain append-only during in-place restore.",
    localExport: {
      source: "local-live-state",
      capturedAt: clean(expenseSnapshot.capturedAt) || new Date().toISOString()
    },
    freshness,
    counts,
    data
  };
  const json = await attachFullBackupIntegrity(baseJson);
  return {
    tripId,
    role: normalizedRole,
    roleLabel: roleLabel(normalizedRole),
    revision,
    counts,
    freshness,
    integrity: json.integrity,
    json,
    filename: `${tripId}-full-backup-data-v1-r${revision}.json`,
    source: "local-live-state"
  };
}

export async function exportFullBackup(tripIdInput, { user: userInput = null } = {}) {
  const user = await requireUser(userInput);
  const tripId = clean(tripIdInput);
  if (!tripId) throw new Error("Missing tripId");
  const role = await requireManageRole(tripId, user);
  const [structure, expenses, settlements, activityLogs] = await Promise.all([
    readTripStructure(tripId),
    readBackupCollection(tripId, "expenses"),
    readBackupCollection(tripId, "settlements"),
    readBackupCollection(tripId, "activityLogs")
  ]);
  const data = {
    tripStructure: fullBackupSerialize(structure),
    portableTrip: canonicalPortableExport(structure, { tripId }),
    expenses,
    settlements,
    activityLogs
  };
  const counts = fullBackupCountsFromData(data);
  const revision = Math.max(1, Number(structure?.tripDoc?.revision) || 1);
  const baseJson = {
    backupFormat: FULL_BACKUP_FORMAT,
    backupVersion: FULL_BACKUP_VERSION,
    appName: "travel-webapp",
    tripId,
    sourceRevision: revision,
    exportedAt: new Date().toISOString(),
    exportedBy: {
      uid: user.uid,
      name: clean(user.displayName),
      email: clean(user.email).toLowerCase()
    },
    mediaIncluded: false,
    mediaManifest: [],
    documentIncluded: false,
    documentManifest: [],
    mediaNote: "Data-only Full Backup v1. Phase 3A will add media files through a versioned backup package.",
    accessPolicy: "Trip membership / roles are not restored from this backup.",
    activityLogPolicy: "Activity logs are backed up for archival integrity. Existing audit logs remain append-only during in-place restore.",
    freshness: {
      status: "server-confirmed",
      archiveGrade: true,
      online: true,
      evaluatedAt: new Date().toISOString(),
      trip: { serverConfirmed:true, hasPendingWrites:false, source:"server", revision },
      expenses: { serverConfirmed:true, hasPendingWrites:false, sources:{} }
    },
    counts,
    data
  };
  const json = await attachFullBackupIntegrity(baseJson);
  return {
    tripId,
    role,
    roleLabel: roleLabel(role),
    revision,
    counts,
    freshness: json.freshness,
    integrity: json.integrity,
    json,
    filename: `${tripId}-full-backup-data-v1-r${revision}.json`
  };
}

function fullRestoreTripWriteOps(target, tripId, user) {
  const ops = [];
  safeArray(target?.days).forEach(day => {
    const dayData = { ...stripAudit(day.data || {}), dayId: clean(day?.data?.dayId || day.id), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
    ops.push(opSet(doc(db, "trips", tripId, "days", day.id), dayData));
    safeArray(day?.items).forEach(item => {
      const itemData = { ...stripAudit(item.data || {}), itemId: clean(item?.data?.itemId || item.id), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
      ops.push(opSet(doc(db, "trips", tripId, "days", day.id, "items", item.id), itemData));
    });
  });
  safeArray(target?.savedPlaces).forEach(place => {
    const placeData = { ...stripAudit(place.data || {}), placeId: clean(place?.data?.placeId || place.id), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
    ops.push(opSet(doc(db, "trips", tripId, "savedPlaces", place.id), placeData));
  });
  const generalData = { ...stripAudit(target?.settings?.general || {}), createdAt: serverTimestamp(), createdBy: user.uid, updatedAt: serverTimestamp(), updatedBy: user.uid };
  ops.push(opSet(doc(db, "trips", tripId, "settings", "general"), generalData));
  return ops;
}

async function restoreTripScopeFromBackup(target, current, tripId, user, { onProgress = null, progressOffset = 0, progressSpan = 1 } = {}) {
  const tripRef = doc(db, "trips", tripId);
  const currentTrip = current?.tripDoc || {};
  const targetTrip = target?.tripDoc || {};
  const nextRevision = Math.max(1, Number(currentTrip.revision) || 0) + 1;
  const restoredTripContent = stripTripOperational(targetTrip);

  await writeBatch(db).set(tripRef, {
    restoreState: "restoring",
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  }, { merge: true }).commit();

  await writeBatch(db).set(tripRef, {
    ...restoredTripContent,
    revision: nextRevision,
    memberUids: safeArray(currentTrip.memberUids),
    memberCount: Number(currentTrip.memberCount) || safeArray(currentTrip.memberUids).length,
    createdBy: clean(currentTrip.createdBy),
    createdAt: currentTrip.createdAt || serverTimestamp(),
    archived: currentTrip.archived === true,
    archivedAt: currentTrip.archivedAt || null,
    archivedBy: clean(currentTrip.archivedBy),
    globalLocked: currentTrip.globalLocked === true,
    globalLockedAt: currentTrip.globalLockedAt || null,
    globalLockedBy: clean(currentTrip.globalLockedBy),
    globalLockedByName: clean(currentTrip.globalLockedByName),
    globalUnlockedAt: currentTrip.globalUnlockedAt || null,
    globalUnlockedBy: clean(currentTrip.globalUnlockedBy),
    globalUnlockedByName: clean(currentTrip.globalUnlockedByName),
    contentHash: "",
    contentHashVersion: 1,
    importState: "ready",
    restoreState: "restoring",
    lastImportMode: "full-backup-trip-restore",
    restoredBy: user.uid,
    restoredAt: serverTimestamp(),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: false }).commit();

  const writes = fullRestoreTripWriteOps(target, tripId, user);
  const deletes = staleDeleteOps(current, target, tripId);
  const totalOps = Math.max(1, writes.length + deletes.length);
  const progress = ({ completed, total }) => {
    if (typeof onProgress !== "function") return;
    const ratio = Math.min(1, completed / Math.max(1, total));
    onProgress({ completed: progressOffset + ratio * progressSpan, total: 1, stage: "trip-content" });
  };
  await commitOps(writes, progress, 0, totalOps);
  await commitOps(deletes, progress, writes.length, totalOps);
  return { revision: nextRevision };
}

async function readCurrentExpenseCollections(tripId) {
  const [expenseSnaps, settlementSnaps] = await Promise.all([
    getDocs(collection(db, "trips", tripId, "expenses")),
    getDocs(collection(db, "trips", tripId, "settlements"))
  ]);
  return {
    expenses: new Map(expenseSnaps.docs.map(snap => [snap.id, snap.data() || {}])),
    settlements: new Map(settlementSnaps.docs.map(snap => [snap.id, snap.data() || {}]))
  };
}

function restoreExpenseWriteOps(backup, current, tripId, user) {
  const ops = [];
  const targetExpenses = new Map(safeArray(backup?.data?.expenses).map(entry => [clean(entry?.id), fullBackupDeserialize(entry?.data || {})]).filter(([id]) => id));
  const targetSettlements = new Map(safeArray(backup?.data?.settlements).map(entry => [clean(entry?.id), fullBackupDeserialize(entry?.data || {})]).filter(([id]) => id));
  const targetStructure = fullBackupDeserialize(backup?.data?.tripStructure || {});
  const expenseSettings = { ...stripAudit(targetStructure?.settings?.expenses || {}), updatedBy: user.uid, updatedAt: serverTimestamp() };
  ops.push(opSet(doc(db, "trips", tripId, "settings", "expenses"), expenseSettings, { merge: false }));

  targetExpenses.forEach((data, id) => {
    const existing = current.expenses.get(id) || null;
    const restored = {
      ...clone(data),
      createdBy: existing ? (clean(data?.createdBy) || clean(existing.createdBy) || user.uid) : user.uid,
      createdAt: existing ? (data?.createdAt || existing.createdAt || serverTimestamp()) : serverTimestamp(),
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    };
    ops.push(opSet(doc(db, "trips", tripId, "expenses", id), restored, { merge: false }));
  });
  current.expenses.forEach((data, id) => {
    if (targetExpenses.has(id)) return;
    ops.push(opSet(doc(db, "trips", tripId, "expenses", id), {
      isDeleted: true,
      deletedBy: user.uid,
      deletedByName: clean(user.displayName),
      deletedAt: serverTimestamp(),
      updatedBy: user.uid,
      updatedAt: serverTimestamp(),
      restoreExcluded: true
    }, { merge: true }));
  });

  targetSettlements.forEach((data, id) => {
    const existing = current.settlements.get(id) || null;
    const restored = {
      ...clone(data),
      createdBy: existing ? (clean(data?.createdBy) || clean(existing.createdBy) || user.uid) : user.uid
    };
    ops.push(opSet(doc(db, "trips", tripId, "settlements", id), restored, { merge: false }));
  });
  current.settlements.forEach((data, id) => {
    if (!targetSettlements.has(id)) ops.push(opDelete(doc(db, "trips", tripId, "settlements", id)));
  });
  return ops;
}

export function fullBackupPortableTrip(rawInput) {
  const backup = normalizeFullBackupInput(rawInput);
  const portable = backup?.data?.portableTrip;
  if (portable && typeof portable === "object" && !Array.isArray(portable)) return clone(portable);
  const structure = fullBackupDeserialize(backup?.data?.tripStructure || {});
  return canonicalPortableExport(structure, { tripId: backup.tripId });
}

function retargetMediaReferences(value, oldTripId, newTripId) {
  if (Array.isArray(value)) return value.map(item => retargetMediaReferences(item, oldTripId, newTripId));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    const oldMediaPrefix = `trips/${oldTripId}/media/`;
    const oldDocumentPrefix = `trips/${oldTripId}/documents/`;
    if (value.startsWith(oldMediaPrefix)) return `trips/${newTripId}/media/${value.slice(oldMediaPrefix.length)}`;
    if (value.startsWith(oldDocumentPrefix)) return `trips/${newTripId}/documents/${value.slice(oldDocumentPrefix.length)}`;
    return value;
  }
  const output = {};
  Object.entries(value).forEach(([key, item]) => {
    if (key === "tripId" && clean(item) === oldTripId) output[key] = newTripId;
    else output[key] = retargetMediaReferences(item, oldTripId, newTripId);
  });
  return output;
}

export async function retargetFullBackupTripId(rawInput, newTripIdInput) {
  const backup = normalizeFullBackupInput(rawInput);
  await verifyFullBackupIntegrity(backup);
  const newTripId = clean(newTripIdInput);
  if (!newTripId || newTripId.includes("/") || newTripId.length > 160) {
    const error = new Error("Invalid target Trip ID");
    error.code = "backup-trip-id-invalid";
    throw error;
  }
  if (newTripId === backup.tripId) return clone(backup);

  const retargeted = retargetMediaReferences(clone(backup) || {}, backup.tripId, newTripId);
  retargeted.tripId = newTripId;
  retargeted.restoredFromTripId = backup.tripId;

  const structure = fullBackupDeserialize(retargeted?.data?.tripStructure || {});
  if (!structure?.tripDoc) {
    const error = new Error("Backup Trip payload is missing");
    error.code = "backup-invalid";
    throw error;
  }
  structure.tripId = newTripId;
  structure.tripDoc = { ...(structure.tripDoc || {}), tripId: newTripId };
  retargeted.data = { ...(retargeted.data || {}), tripStructure: fullBackupSerialize(structure) };

  const portable = fullBackupPortableTrip(backup);
  portable.tripId = newTripId;
  portable.meta = { ...(portable.meta || {}), tripId: newTripId };
  retargeted.data.portableTrip = portable;
  delete retargeted.integrity;
  return attachFullBackupIntegrity(retargeted);
}

export async function restoreFullBackup(rawInput, {
  scope = "all",
  user: userInput = null,
  onProgress = null
} = {}) {
  const user = await requireUser(userInput);
  const backup = normalizeFullBackupInput(rawInput);
  await verifyFullBackupIntegrity(backup);
  const selectedScope = clean(scope).toLowerCase();
  if (!FULL_BACKUP_SCOPES.has(selectedScope)) {
    const error = new Error("Invalid restore scope");
    error.code = "backup-invalid-scope";
    throw error;
  }
  assertCloudOperationAvailable("還原完整備份");
  const tripId = backup.tripId;
  emitRestoreProgress(onProgress, "preflight-start", 0.03, "Backup 已驗證，開始檢查目前旅程。");
  const currentTrip = await readTripStructure(tripId, { onProgress, progressBase: 0.04, progressSpan: 0.16 });
  emitRestoreProgress(onProgress, "preflight-role", 0.21, "正在驗證 Owner / Admin 權限。");
  await awaitRestorePreflight(requireManageRole(tripId, user), { stage: "驗證旅程權限" });
  emitRestoreProgress(onProgress, "preflight-lock", 0.235, "正在確認旅程未被全域鎖定。");
  if (currentTrip?.tripDoc?.globalLocked === true) {
    const error = new Error("Trip is globally locked"); error.code = "trip-global-locked"; throw error;
  }
  if (clean(currentTrip?.tripId) !== tripId) {
    const error = new Error("Backup Trip ID does not match current Trip");
    error.code = "backup-trip-mismatch";
    throw error;
  }

  const localOperationToken = beginCloudOperation({ type: "restore", tripId, label: "還原完整備份" });
  let serverOperation = null;
  let mutationStarted = false;
  try {
    emitRestoreProgress(onProgress, "preflight-operation", 0.25, "正在取得旅程操作鎖，避免另一部裝置同時更新。");
    serverOperation = await acquireRestoreOperationWithTimeout(tripId, user);
    emitRestoreProgress(onProgress, "preflight-operation-ready", 0.27, "操作鎖已取得。");
    const targetStructure = fullBackupDeserialize(backup.data.tripStructure || {});
    if (!targetStructure?.tripDoc) {
      const error = new Error("Backup Trip payload is missing");
      error.code = "backup-invalid";
      throw error;
    }
    let revision = Number(currentTrip?.tripDoc?.revision) || 1;
    let safetySnapshotId = "";

    if (selectedScope === "all" || selectedScope === "trip") {
      emitRestoreProgress(onProgress, "preflight-safety-snapshot", 0.29, "正在建立還原前安全 Snapshot。");
      const safety = await writeSnapshot(tripId, currentTrip, user, { type: "pre-restore" });
      emitRestoreProgress(onProgress, "safety-snapshot", 0.32, "還原前安全 Snapshot 已建立。");
      safetySnapshotId = safety.snapshotId;
      mutationStarted = true;
      const tripResult = await restoreTripScopeFromBackup(targetStructure, currentTrip, tripId, user, {
        onProgress,
        progressOffset: 0.33,
        progressSpan: selectedScope === "all" ? 0.32 : 0.57
      });
      revision = tripResult.revision;
    }

    if (selectedScope === "all" || selectedScope === "expenses") {
      mutationStarted = true;
      const currentExpenses = await readCurrentExpenseCollections(tripId);
      const ops = restoreExpenseWriteOps(backup, currentExpenses, tripId, user);
      await commitOps(ops, ({ completed, total }) => {
        if (typeof onProgress !== "function") return;
        const ratio = Math.min(1, completed / Math.max(1, total));
        const base = selectedScope === "all" ? 0.68 : 0.30;
        const span = selectedScope === "all" ? 0.22 : 0.60;
        onProgress({ completed: base + ratio * span, total: 1, stage: "expense-content" });
      });
    }

    const finalBatch = writeBatch(db);
    finalBatch.set(doc(collection(db, "trips", tripId, "activityLogs")), {
      type: "trip.full_backup.restore",
      actionType: "trip.full_backup.restore",
      category: "backup",
      title: "還原完整備份",
      summary: selectedScope === "all"
        ? "完整還原行程及支出資料"
        : selectedScope === "trip"
          ? "只還原行程，現有支出保持不變"
          : "只還原支出，現有行程保持不變",
      actorUid: user.uid,
      actorName: clean(user.displayName),
      backupVersion: backup.backupVersion,
      restoreScope: selectedScope,
      sourceRevision: Number(backup.sourceRevision) || 0,
      revision,
      safetySnapshotId,
      archivedActivityLogCount: safeArray(backup.data.activityLogs).length,
      createdAt: serverTimestamp()
    });
    finalBatch.set(doc(db, "trips", tripId), {
      restoreState: "ready",
      updatedAt: serverTimestamp(),
      updatedBy: user.uid
    }, { merge: true });
    await finalBatch.commit();
    if (typeof onProgress === "function") onProgress({ completed: 1, total: 1, stage: "done" });

    return {
      tripId,
      scope: selectedScope,
      backupVersion: backup.backupVersion,
      sourceRevision: Number(backup.sourceRevision) || 0,
      revision,
      safetySnapshotId,
      counts: backup.counts,
      activityLogsRestored: false,
      activityLogPolicy: "append-only"
    };
  } catch (error) {
    try {
      if (mutationStarted) {
        await writeBatch(db).set(doc(db, "trips", tripId), {
          restoreState: "failed",
          updatedAt: serverTimestamp(),
          updatedBy: user.uid
        }, { merge: true }).commit();
      }
    } catch (stateError) {
      console.warn("Unable to mark failed Full Backup restore", stateError);
    }
    throw error;
  } finally {
    if (serverOperation) await releaseTripOperation(serverOperation, user);
    endCloudOperation(localOperationToken);
  }
}
