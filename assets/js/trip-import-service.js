import { auth, db } from "./firebase-service.js";
import { buildFirestoreTripPlan, getTripSummary, normalizePortableTrip, validatePortableTrip } from "./trip-schema-service.js";
import { assertCloudOperationAvailable, beginCloudOperation, endCloudOperation } from "./cloud-safety-service.js";
import { acquireTripOperation, releaseTripOperation } from "./trip-operation-service.js";
import { getTripCreatorEntitlement, inspectTripIdRegistry, tripIdRegistryRecord } from "./trip-creator-service.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  writeBatch
} from "./firestore-observed-service.js";

const WRITE_CHUNK_SIZE = 8;
const SNAPSHOT_SOFT_LIMIT_BYTES = 760_000;
const VALID_REPLACE_ROLES = new Set(["owner", "admin"]);
const CONTENT_HASH_VERSION = 1;
const IGNORED_CONTENT_KEYS = new Set([
  "createdAt",
  "createdBy",
  "updatedAt",
  "updatedBy",
  "importedAt",
  "importedBy",
  "importState",
  "lastImportMode",
  "lastSnapshotId",
  "revision",
  "memberUids",
  "memberCount",
  "archived",
  "archivedAt",
  "archivedBy",
  "globalLocked", "globalLockedAt", "globalLockedBy", "globalLockedByName",
  "globalUnlockedAt", "globalUnlockedBy", "globalUnlockedByName",
  "contentHash",
  "contentHashVersion",
  "activeOperationId","activeOperationType","activeOperationBy","activeOperationStartedAtMs","activeOperationStartedAt"
]);

function clean(value) { return String(value ?? "").trim(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function nowId() {
  const d = new Date();
  const stamp = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"), "_", String(d.getHours()).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"), String(d.getSeconds()).padStart(2, "0")].join("");
  return `import_${stamp}_${Math.random().toString(36).slice(2, 7)}`;
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
function roleLabel(role) { return ({ owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" })[role] || ""; }
function approxJsonBytes(value) {
  try { return new Blob([JSON.stringify(value)]).size; } catch (error) { return Infinity; }
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
    if (typeof onProgress === "function") onProgress({ completed: progressBase + completed, total: Math.max(progressTotal, progressBase + completed) });
  }
}

function withAuditFields(data, user, { preserveCreated = false } = {}) {
  const output = { ...data, updatedAt: serverTimestamp(), updatedBy: user.uid };
  if (!preserveCreated) {
    output.createdAt = serverTimestamp();
    output.createdBy = clean(data?.createdBy) || user.uid;
  }
  return output;
}

function contentWriteOps(plan, user) {
  const tripId = plan.tripId;
  const ops = [];
  plan.days.forEach(day => {
    ops.push(opSet(doc(db, "trips", tripId, "days", day.id), withAuditFields(day.data, user)));
    day.items.forEach(item => ops.push(opSet(doc(db, "trips", tripId, "days", day.id, "items", item.id), withAuditFields(item.data, user))));
  });
  plan.savedPlaces.forEach(place => ops.push(opSet(doc(db, "trips", tripId, "savedPlaces", place.id), withAuditFields(place.data, user))));
  ops.push(opSet(doc(db, "trips", tripId, "settings", "general"), withAuditFields(plan.settings.general || {}, user)));
  ops.push(opSet(doc(db, "trips", tripId, "settings", "expenses"), withAuditFields(plan.settings.expenses || {}, user)));
  return ops;
}

function stripOperationalFields(value) {
  if (Array.isArray(value)) return value.map(stripOperationalFields);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.keys(value).sort().forEach(key => {
    if (IGNORED_CONTENT_KEYS.has(key)) return;
    const next = value[key];
    if (typeof next === "undefined") return;
    output[key] = stripOperationalFields(next);
  });
  return output;
}

function stableStringify(value) {
  return JSON.stringify(stripOperationalFields(value));
}

function fallbackHash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `f${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

async function digestText(text) {
  try {
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch (error) {
    console.warn("SHA-256 content fingerprint unavailable; using local fallback", error);
  }
  return fallbackHash(text);
}

function canonicalPlanContent(plan) {
  return {
    tripDoc: stripOperationalFields(plan.tripDoc || {}),
    days: [...(plan.days || [])]
      .map(day => ({
        id: day.id,
        data: stripOperationalFields(day.data || {}),
        items: [...(day.items || [])]
          .map(item => ({ id: item.id, data: stripOperationalFields(item.data || {}) }))
          .sort((a, b) => a.id.localeCompare(b.id))
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    savedPlaces: [...(plan.savedPlaces || [])]
      .map(place => ({ id: place.id, data: stripOperationalFields(place.data || {}) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    settings: stripOperationalFields(plan.settings || {})
  };
}

function canonicalExistingContent(existing) {
  return {
    tripDoc: stripOperationalFields(existing?.tripDoc || {}),
    days: [...(existing?.days || [])]
      .map(day => ({
        id: day.id,
        data: stripOperationalFields(day.data || {}),
        items: [...(day.items || [])]
          .map(item => ({ id: item.id, data: stripOperationalFields(item.data || {}) }))
          .sort((a, b) => a.id.localeCompare(b.id))
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    savedPlaces: [...(existing?.savedPlaces || [])]
      .map(place => ({ id: place.id, data: stripOperationalFields(place.data || {}) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    settings: stripOperationalFields(existing?.settings || {})
  };
}

async function planContentHash(plan) {
  return digestText(stableStringify(canonicalPlanContent(plan)));
}

function equalContent(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function compareById(existingEntries = [], plannedEntries = [], getExistingData = entry => entry?.data, getPlannedData = entry => entry?.data) {
  const existingMap = new Map(existingEntries.map(entry => [entry.id, entry]));
  const plannedMap = new Map(plannedEntries.map(entry => [entry.id, entry]));
  let added = 0;
  let modified = 0;
  let deleted = 0;
  plannedMap.forEach((entry, id) => {
    const before = existingMap.get(id);
    if (!before) added += 1;
    else if (!equalContent(getExistingData(before), getPlannedData(entry))) modified += 1;
  });
  existingMap.forEach((entry, id) => {
    if (!plannedMap.has(id)) deleted += 1;
  });
  return { added, modified, deleted, changed: added + modified + deleted };
}

function buildChangeSummary(existing, plan) {
  const daySummary = compareById(existing?.days || [], plan.days || []);
  const existingItems = [];
  const plannedItems = [];
  (existing?.days || []).forEach(day => (day.items || []).forEach(item => existingItems.push({ id: `${day.id}/${item.id}`, data: item.data })));
  (plan.days || []).forEach(day => (day.items || []).forEach(item => plannedItems.push({ id: `${day.id}/${item.id}`, data: item.data })));
  const itemSummary = compareById(existingItems, plannedItems);
  const savedSummary = compareById(existing?.savedPlaces || [], plan.savedPlaces || []);
  const tripChanged = equalContent(existing?.tripDoc || {}, plan.tripDoc || {}) ? 0 : 1;
  const settingsChanged = ["general", "expenses"].reduce((sum, key) => sum + (equalContent(existing?.settings?.[key] || {}, plan.settings?.[key] || {}) ? 0 : 1), 0);
  const totalChanged = daySummary.changed + itemSummary.changed + savedSummary.changed + tripChanged + settingsChanged;
  return {
    days: daySummary,
    items: itemSummary,
    savedPlaces: savedSummary,
    tripChanged,
    settingsChanged,
    totalChanged,
    unchanged: totalChanged === 0
  };
}

async function readExistingStructure(tripId) {
  const tripRef = doc(db, "trips", tripId);
  const tripSnap = await getDoc(tripRef);
  if (!tripSnap.exists()) return null;

  const [daySnaps, savedSnaps, settingsGeneral, settingsExpenses] = await Promise.all([
    getDocs(collection(db, "trips", tripId, "days")),
    getDocs(collection(db, "trips", tripId, "savedPlaces")),
    getDoc(doc(db, "trips", tripId, "settings", "general")),
    getDoc(doc(db, "trips", tripId, "settings", "expenses"))
  ]);
  const days = await Promise.all(daySnaps.docs.map(async daySnap => {
    const itemSnaps = await getDocs(collection(db, "trips", tripId, "days", daySnap.id, "items"));
    return {
      id: daySnap.id,
      data: daySnap.data(),
      items: itemSnaps.docs.map(itemSnap => ({ id: itemSnap.id, data: itemSnap.data() }))
    };
  }));
  return {
    tripId,
    tripDoc: tripSnap.data(),
    days,
    savedPlaces: savedSnaps.docs.map(s => ({ id: s.id, data: s.data() })),
    settings: {
      general: settingsGeneral.exists() ? settingsGeneral.data() : null,
      expenses: settingsExpenses.exists() ? settingsExpenses.data() : null
    }
  };
}

function staleDeleteOps(existing, plan) {
  if (!existing) return [];
  const ops = [];
  const nextDays = new Map(plan.days.map(day => [day.id, new Set(day.items.map(item => item.id))]));
  existing.days.forEach(day => {
    const nextItems = nextDays.get(day.id);
    day.items.forEach(item => {
      if (!nextItems || !nextItems.has(item.id)) ops.push(opDelete(doc(db, "trips", plan.tripId, "days", day.id, "items", item.id)));
    });
    if (!nextDays.has(day.id)) ops.push(opDelete(doc(db, "trips", plan.tripId, "days", day.id)));
  });
  const nextPlaces = new Set(plan.savedPlaces.map(place => place.id));
  existing.savedPlaces.forEach(place => {
    if (!nextPlaces.has(place.id)) ops.push(opDelete(doc(db, "trips", plan.tripId, "savedPlaces", place.id)));
  });
  return ops;
}

async function createSnapshot(existing, user) {
  if (!existing) return null;
  const size = approxJsonBytes(existing);
  if (size > SNAPSHOT_SOFT_LIMIT_BYTES) {
    const error = new Error("Existing trip is too large for a safe single-document import snapshot");
    error.code = "snapshot-too-large";
    error.approxBytes = size;
    throw error;
  }
  const snapshotId = nowId();
  await writeBatch(db)
    .set(doc(db, "trips", existing.tripId, "snapshots", snapshotId), {
      snapshotId,
      type: "pre-import",
      sourceRevision: Number(existing.tripDoc?.revision) || 0,
      createdBy: user.uid,
      createdAt: serverTimestamp(),
      payload: existing
    })
    .commit();
  return snapshotId;
}

async function inspectExistingAgainstPlan(existingTripDoc, plan, tripId) {
  const nextHash = await planContentHash(plan);
  const storedHash = clean(existingTripDoc?.contentHash);
  if (storedHash && storedHash === nextHash && Number(existingTripDoc?.contentHashVersion || CONTENT_HASH_VERSION) === CONTENT_HASH_VERSION) {
    return {
      unchanged: true,
      contentHash: nextHash,
      existing: null,
      changeSummary: {
        days: { added: 0, modified: 0, deleted: 0, changed: 0 },
        items: { added: 0, modified: 0, deleted: 0, changed: 0 },
        savedPlaces: { added: 0, modified: 0, deleted: 0, changed: 0 },
        tripChanged: 0,
        settingsChanged: 0,
        totalChanged: 0,
        unchanged: true
      }
    };
  }
  const existing = await readExistingStructure(tripId);
  const changeSummary = buildChangeSummary(existing, plan);
  return { unchanged: changeSummary.unchanged, contentHash: nextHash, existing, changeSummary };
}

async function inspectCreateEligibility(validation, summary, user) {
  let entitlement;
  try { entitlement = await getTripCreatorEntitlement(user); }
  catch (error) {
    if (error?.code === "permission-denied") {
      return { ...validation, summary, exists: false, role: null, canImport: false, mode: "creator-required", creatorRequired: true };
    }
    throw error;
  }
  if (!entitlement?.enabled) {
    return { ...validation, summary, exists: false, role: null, canImport: false, mode: "creator-required", creatorRequired: true };
  }

  const registry = await inspectTripIdRegistry(validation.trip.tripId, { user });
  if (registry.reserved) {
    return {
      ...validation, summary, exists: true, role: null, roleLabel: "", canImport: false,
      mode: "collision", existingTrip: null, changeSummary: null, protectedProbe: true, tripIdReserved: true
    };
  }
  return {
    ...validation, summary, exists: false, role: null, canImport: true, mode: "create",
    existingTrip: null, changeSummary: null, creatorAuthorized: true
  };
}

export async function inspectTripImport(rawInput, userInput = null) {
  const user = await requireUser(userInput);
  const built = buildFirestoreTripPlan(rawInput, user);
  const validation = built.valid
    ? { valid: true, errors: built.errors || [], warnings: built.warnings || [], trip: built.trip }
    : validatePortableTrip(rawInput);
  const summary = getTripSummary(validation.trip);
  if (!validation.valid || !built.plan) return { ...validation, summary, exists: false, role: null, canImport: false, mode: "invalid" };

  const tripRef = doc(db, "trips", validation.trip.tripId);
  let tripSnap = null;
  try {
    tripSnap = await getDoc(tripRef);
  } catch (error) {
    if (error?.code === "permission-denied") {
      // Private Trip documents deliberately cannot be probed. New-Trip creation
      // is decided by the creator entitlement + privacy-preserving Trip ID
      // registry instead of treating permission-denied as an available ID.
      return inspectCreateEligibility(validation, summary, user);
    }
    throw error;
  }
  if (!tripSnap.exists()) return inspectCreateEligibility(validation, summary, user);
  const existingTrip = tripSnap.data() || {};
  const listedMember = Array.isArray(existingTrip.memberUids) && existingTrip.memberUids.includes(user.uid);
  if (!listedMember) {
    return {
      ...validation, summary, exists: true, role: null, roleLabel: "", canImport: false, mode: "replace", existingTrip, changeSummary: null
    };
  }
  const memberSnap = await getDoc(doc(db, "trips", validation.trip.tripId, "members", user.uid));
  const role = memberSnap.exists() ? clean(memberSnap.data()?.role) : null;
  if (!VALID_REPLACE_ROLES.has(role)) {
    return {
      ...validation,
      summary,
      exists: true,
      role,
      roleLabel: roleLabel(role),
      canImport: false,
      mode: "replace",
      existingTrip,
      changeSummary: null
    };
  }

  const comparison = await inspectExistingAgainstPlan(existingTrip, built.plan, validation.trip.tripId);
  if (comparison.unchanged) {
    return {
      ...validation,
      summary,
      exists: true,
      role,
      roleLabel: roleLabel(role),
      canImport: false,
      mode: "unchanged",
      existingTrip,
      contentHash: comparison.contentHash,
      changeSummary: comparison.changeSummary
    };
  }
  return {
    ...validation,
    summary,
    exists: true,
    role,
    roleLabel: roleLabel(role),
    canImport: true,
    mode: "replace",
    existingTrip,
    contentHash: comparison.contentHash,
    changeSummary: comparison.changeSummary
  };
}

export async function importTrip(rawInput, {
  mode = "create",
  user: userInput = null,
  onProgress = null
} = {}) {
  let localOperationToken = null;
  let serverOperation = null;
  let mutationStarted = false;
  let user = null;
  let plan = null;

  try {
    assertCloudOperationAvailable("匯入 trip.json");
    user = await requireUser(userInput);

    const built = buildFirestoreTripPlan(rawInput, user);
    if (!built.valid || !built.plan) {
      const error = new Error(built.errors?.join("; ") || "Invalid portable trip JSON");
      error.code = "invalid-trip";
      error.validation = built;
      throw error;
    }

    plan = built.plan;
    localOperationToken = beginCloudOperation({
      type: "import",
      tripId: plan.tripId,
      label: "匯入 trip.json"
    });

    const contentHash = await planContentHash(plan);
    const tripRef = doc(db, "trips", plan.tripId);
    let tripSnap = null;
    let exists = false;

    if (mode === "replace") {
      tripSnap = await getDoc(tripRef);
      exists = tripSnap.exists();
      if (!exists) mode = "create";
    } else {
      try {
        tripSnap = await getDoc(tripRef);
        exists = tripSnap.exists();
        if (exists) {
          const error = new Error("Trip already exists");
          error.code = "trip-exists";
          throw error;
        }
      } catch (error) {
        if (error?.code !== "permission-denied") throw error;
        tripSnap = null;
        exists = false;
      }
    }

    if (mode === "create") {
      const entitlement = await getTripCreatorEntitlement(user);
      if (!entitlement?.enabled) {
        const error = new Error("Trip creator entitlement required");
        error.code = "creator-required";
        throw error;
      }
      const registry = await inspectTripIdRegistry(plan.tripId, { user });
      if (registry.reserved) {
        const error = new Error("Trip ID already used");
        error.code = "trip-id-unavailable";
        throw error;
      }
    }

    let existing = null;
    let snapshotId = null;
    let existingRole = null;
    let changeSummary = null;

    if (mode === "replace") {
      const parentData = tripSnap.data() || {};
      if (parentData.globalLocked === true) {
        const error = new Error("Trip is globally locked");
        error.code = "trip-global-locked";
        throw error;
      }
      if (!Array.isArray(parentData.memberUids) || !parentData.memberUids.includes(user.uid)) {
        const error = new Error("Current user is not a member of this trip");
        error.code = "insufficient-role";
        throw error;
      }

      const memberSnap = await getDoc(doc(db, "trips", plan.tripId, "members", user.uid));
      existingRole = memberSnap.exists() ? clean(memberSnap.data()?.role) : null;
      if (!VALID_REPLACE_ROLES.has(existingRole)) {
        const error = new Error("Owner or Admin role required to replace an existing trip");
        error.code = "insufficient-role";
        throw error;
      }

      const comparison = await inspectExistingAgainstPlan(parentData, plan, plan.tripId);
      changeSummary = comparison.changeSummary;
      existing = comparison.existing;

      if (comparison.unchanged) {
        return {
          tripId: plan.tripId,
          mode: "unchanged",
          role: existingRole,
          revision: Number(parentData.revision) || 1,
          snapshotId: null,
          contentHash,
          changeSummary,
          normalizedTrip: normalizePortableTrip(rawInput),
          summary: getTripSummary(rawInput)
        };
      }

      if (!existing) existing = await readExistingStructure(plan.tripId);
      serverOperation = await acquireTripOperation(plan.tripId, "import", user);

      if (typeof onProgress === "function") {
        onProgress({ completed: 0.15, total: 1, stage: "snapshot" });
      }
      snapshotId = await createSnapshot(existing, user);
      if (typeof onProgress === "function") {
        onProgress({ completed: 0.22, total: 1, stage: "prepare" });
      }
    }

    const baseExisting = exists && tripSnap ? tripSnap.data() || {} : {};
    const finalRevision = mode === "replace"
      ? Math.max(Number(baseExisting.revision || 0) + 1, Number(plan.tripDoc.revision || 1))
      : Math.max(1, Number(plan.tripDoc.revision || 1));

    mutationStarted = true;

    if (mode === "create") {
      const batch = writeBatch(db);
      batch.set(doc(db, "tripIds", plan.tripId), tripIdRegistryRecord(plan.tripId, user));
      batch.set(tripRef, {
        ...plan.tripDoc,
        revision: finalRevision,
        contentHash,
        contentHashVersion: CONTENT_HASH_VERSION,
        importState: "importing",
        importedBy: user.uid,
        importedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      batch.set(doc(db, "trips", plan.tripId, "members", user.uid), {
        ...plan.memberDoc,
        joinedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await batch.commit();
    } else {
      const batch = writeBatch(db);
      batch.set(tripRef, {
        ...baseExisting,
        ...plan.tripDoc,
        revision: finalRevision,
        contentHash,
        contentHashVersion: CONTENT_HASH_VERSION,
        memberUids: Array.isArray(baseExisting.memberUids) ? baseExisting.memberUids : plan.tripDoc.memberUids,
        memberCount: Number(baseExisting.memberCount) || (Array.isArray(baseExisting.memberUids) ? baseExisting.memberUids.length : 1),
        createdBy: clean(baseExisting.createdBy) || plan.tripDoc.createdBy,
        createdAt: baseExisting.createdAt || serverTimestamp(),
        archived: baseExisting.archived === true,
        archivedAt: baseExisting.archivedAt || null,
        archivedBy: clean(baseExisting.archivedBy),
        importState: "importing",
        importedBy: user.uid,
        importedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      await batch.commit();
    }

    const writes = contentWriteOps(plan, user);
    const deletes = staleDeleteOps(existing, plan);
    const totalOps = writes.length + deletes.length + 2;

    if (typeof onProgress === "function") {
      onProgress({ completed: 1, total: totalOps, stage: "prepare" });
    }

    const contentProgress = ({ completed, total }) => {
      if (typeof onProgress === "function") {
        onProgress({
          completed,
          total,
          stage: "content",
          detail: `${Math.max(0, Math.round(completed - 1))}/${Math.max(1, totalOps - 2)}`
        });
      }
    };

    await commitOps(writes, contentProgress, 1, totalOps);
    await commitOps(deletes, contentProgress, 1 + writes.length, totalOps);

    if (typeof onProgress === "function") {
      onProgress({ completed: totalOps - 1, total: totalOps, stage: "finalize" });
    }

    const finalBatch = writeBatch(db);
    finalBatch.set(tripRef, {
      revision: finalRevision,
      schemaVersion: Number(plan.tripDoc.schemaVersion) || 2,
      contentHash,
      contentHashVersion: CONTENT_HASH_VERSION,
      importState: "ready",
      lastImportMode: mode,
      lastSnapshotId: snapshotId || "",
      importedBy: user.uid,
      importedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    const logRef = doc(collection(db, "trips", plan.tripId, "activityLogs"));
    const importType = mode === "replace" ? "trip.import.replace" : "trip.import.create";
    finalBatch.set(logRef, {
      type: importType,
      actionType: importType,
      category: "itinerary",
      title: mode === "replace" ? "匯入 trip.json" : "建立旅程",
      summary: mode === "replace" ? `更新 Firebase 旅程 · Revision ${finalRevision}` : `首次匯入 trip.json · Revision ${finalRevision}`,
      actorUid: user.uid,
      actorName: clean(user.displayName),
      revision: finalRevision,
      schemaVersion: Number(plan.tripDoc.schemaVersion) || 2,
      snapshotId: snapshotId || "",
      changeSummary: changeSummary || null,
      createdAt: serverTimestamp()
    });
    await finalBatch.commit();

    if (typeof onProgress === "function") {
      onProgress({ completed: totalOps, total: totalOps, stage: "done" });
    }

    return {
      tripId: plan.tripId,
      mode,
      role: mode === "create" ? "owner" : existingRole,
      revision: finalRevision,
      snapshotId,
      contentHash,
      changeSummary,
      normalizedTrip: normalizePortableTrip(rawInput),
      summary: getTripSummary(rawInput)
    };
  } catch (error) {
    try {
      if (mutationStarted && plan?.tripId && user?.uid) {
        const failedBatch = writeBatch(db);
        failedBatch.set(doc(db, "trips", plan.tripId), {
          importState: "failed",
          updatedAt: serverTimestamp(),
          updatedBy: user.uid
        }, { merge: true });
        await failedBatch.commit();
      }
    } catch (stateError) {
      console.warn("Unable to mark failed import", stateError);
    }

    if (error?.code === "permission-denied" && mode === "create") {
      error.code = "trip-id-unavailable";
    }
    throw error;
  } finally {
    if (serverOperation && user?.uid) {
      await releaseTripOperation(serverOperation, user);
    }
    if (localOperationToken) {
      endCloudOperation(localOperationToken);
    }
  }
}
