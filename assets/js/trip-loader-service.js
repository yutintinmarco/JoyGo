import { db } from "./firebase-service.js";
import { normalizeTravellers } from "./trip-schema-service.js";
import {
  collection,
  doc,
  onSnapshot
} from "./firestore-observed-service.js";

const AUDIT_KEYS = new Set(["createdAt", "createdBy", "updatedAt", "updatedBy"]);
const EMIT_DEBOUNCE_MS = 120;

function clean(value) { return String(value ?? "").trim(); }
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (!value || typeof value !== "object") return value;
  if (typeof value.toDate === "function" || value.seconds != null) return undefined;
  const output = {};
  Object.entries(value).forEach(([key, next]) => {
    if (AUDIT_KEYS.has(key)) return;
    const cloned = clonePlain(next);
    if (typeof cloned !== "undefined") output[key] = cloned;
  });
  return output;
}
function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function normalizeTimestamp(value) {
  try {
    if (value?.toDate) return value.toDate().toISOString();
    if (value?.seconds != null) return new Date(Number(value.seconds) * 1000).toISOString();
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : "";
  } catch (error) {
    return "";
  }
}
function contentSignature(value) {
  try { return JSON.stringify(clonePlain(value) || {}); }
  catch (error) { return ""; }
}
function changedTopLevelKeys(previous, next) {
  const a = clonePlain(previous || {}) || {};
  const b = clonePlain(next || {}) || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(key => contentSignature(a[key]) !== contentSignature(b[key]));
}
function mapSignature(map) {
  try {
    return JSON.stringify([...map.entries()]
      .map(([id, row]) => [id, row?.signature || contentSignature(row?.data || {})])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  } catch (error) {
    return "";
  }
}

function assemblePortableTrip(tripId, state) {
  const tripDoc = state.tripDoc || {};
  const general = clonePlain(state.settings.general || {}) || {};
  const expenses = clonePlain(state.settings.expenses || {}) || {};
  const dayDocs = [...state.days.values()]
    .sort((a, b) => numberOr(a.data?.sortOrder) - numberOr(b.data?.sortOrder));

  const days = dayDocs.map(day => {
    const itemMap = state.itemsByDay.get(day.id) || new Map();
    const items = [...itemMap.values()]
      .map(item => ({ ...clonePlain(item.data || {}), itemId: clean(item.data?.itemId || item.id) }))
      .sort((a, b) => numberOr(a.sortOrder) - numberOr(b.sortOrder));
    return {
      ...clonePlain(day.data || {}),
      dayId: clean(day.data?.dayId || day.id),
      items
    };
  });

  const savedPlaces = [...state.savedPlaces.values()]
    .map(place => ({ ...clonePlain(place.data || {}), placeId: clean(place.data?.placeId || place.id) }))
    .sort((a, b) => numberOr(a.sortOrder) - numberOr(b.sortOrder));

  const savedPlacesMeta = general.savedPlacesMeta && typeof general.savedPlacesMeta === "object"
    ? clonePlain(general.savedPlacesMeta)
    : {};

  return {
    schemaVersion: Math.max(2, numberOr(tripDoc.schemaVersion, 2)),
    tripId,
    revision: Math.max(1, numberOr(tripDoc.revision, 1)),
    meta: {
      tripId,
      titleSmall: clean(tripDoc.titleSmall),
      titleMain: clean(tripDoc.titleHtml || tripDoc.title),
      dateRange: clean(tripDoc.dateRange),
      route: clean(tripDoc.route),
      accentColor: clean(tripDoc.accentColor),
      tripStartIso: clean(tripDoc.startDate),
      tripEndIso: clean(tripDoc.endDate),
      status: clean(tripDoc.status),
      globalLocked: tripDoc.globalLocked === true,
      coverImage: clean(tripDoc.coverImage),
      tripIcon: clean(tripDoc.tripIcon || general.tripIcon),
      backgroundImage: clean(tripDoc.backgroundImage || general.backgroundImage),
      tripIconMedia: clonePlain(tripDoc.tripIconMedia || general.tripIconMedia || null) || null,
      backgroundImageMedia: clonePlain(tripDoc.backgroundImageMedia || general.backgroundImageMedia || null) || null,
      coverImageMedia: clonePlain(tripDoc.coverImageMedia || general.coverImageMedia || null) || null,
      travellers: normalizeTravellers(clonePlain(general.travellers || {}) || {}),
      cities: clonePlain(general.cities || {}) || {},
      flights: clonePlain(general.flights || []) || [],
      outbound: clonePlain(general.outbound || null) || null,
      inbound: clonePlain(general.inbound || null) || null,
      airlineLogo: clean(general.airlineLogo),
      weather: clonePlain(general.weather || {}) || {},
      hotels: clonePlain(general.hotels || {}) || {},
      accommodations: clonePlain(general.accommodations || []) || [],
      bookingDocuments: clonePlain(general.bookingDocuments || []) || [],
      infoCard: clonePlain(general.infoCard || {}) || {},
      galleryDefaults: clonePlain(general.galleryDefaults || {}) || {},
      featureColors: clonePlain(general.featureColors || {}) || {},
      footerNote: clean(general.footerNote),
      expenses
    },
    days,
    snacks: {
      ...(savedPlacesMeta || {}),
      items: savedPlaces
    },
    cloudMeta: {
      source: state.allFromCache() ? "cache" : "server",
      serverConfirmed: state.allRequiredServerConfirmed(),
      hasPendingWrites: state.hasPendingWrites(),
      updatedAt: normalizeTimestamp(tripDoc.updatedAt),
      importState: clean(tripDoc.importState || "ready"),
      restoreState: clean(tripDoc.restoreState || "ready"),
      globalLocked: tripDoc.globalLocked === true,
      globalLockedAt: normalizeTimestamp(tripDoc.globalLockedAt),
      globalLockedBy: clean(tripDoc.globalLockedBy),
      globalLockedByName: clean(tripDoc.globalLockedByName)
    }
  };
}

/*
 * v7.7.4.0 · Active-Day Realtime
 *
 * Returning users already have a complete render cache. Keep only the active
 * day's item collection live, while inactive days continue to render from the
 * trusted local seed. A newly seen day is hydrated once, and a revision change
 * temporarily hydrates every day before returning to active-day-only realtime.
 * This reduces Firestore listener/read fan-out without making Day switching
 * wait on the network.
 */
export function subscribeTripData(tripIdInput, callback, options = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId || typeof callback !== "function") return () => {};

  const seedData = options?.seedData && clean(options.seedData?.tripId || options.seedData?.meta?.tripId) === tripId
    ? options.seedData
    : null;
  const seedRevision = seedData ? Math.max(1, numberOr(seedData.revision, 1)) : 0;
  let hydratedRevision = seedRevision;
  // v7.9.10.5 · Server-confirmation evidence for Day item listeners is
  // revision-scoped. When the Trip root advances first, old itemServerReady
  // flags must not certify a transient composite of the new revision with
  // previous-revision item data.
  let hydrationTargetRevision = 0;
  const seedDays = Array.isArray(seedData?.days) ? seedData.days : [];
  const seedComplete = seedDays.length > 0 && seedDays.every(day => Array.isArray(day?.items));
  // Phase 3A.3 passive Backup gate: a render-cache seed may stand in for
  // inactive-Day item listeners only when that exact cached snapshot was
  // previously fully server-confirmed with no pending writes. The live Trip
  // root must then confirm the same revision from the server. Import / Restore
  // already bump Trip revision whenever Day / Item content changes; Phase 3E
  // itinerary editing must preserve that invariant. This lets Backup observe
  // normal autosync without opening Backup-only listeners or issuing getDocs().
  const seedWasServerConfirmed = seedData?.cloudMeta?.serverConfirmed === true
    && seedData?.cloudMeta?.hasPendingWrites !== true;

  const unsubs = [];
  const itemUnsubs = new Map();
  const sourceMeta = new Map();
  const documentSignatures = new Map();
  const initial = { trip: false, days: false, saved: false, general: false, expenses: false };
  const itemReady = new Set();
  const itemListenerPrimed = new Set();
  const itemServerReady = new Set();
  const seededItemDays = new Set();
  const state = {
    tripDoc: null,
    days: new Map(),
    itemsByDay: new Map(),
    savedPlaces: new Map(),
    settings: { general: {}, expenses: {} },
    allFromCache() {
      const values = [...sourceMeta.values()];
      return values.length > 0 && values.every(meta => meta.fromCache === true);
    },
    hasPendingWrites() {
      return [...sourceMeta.values()].some(meta => meta.hasPendingWrites === true);
    },
    allRequiredServerConfirmed() {
      const baseKeys = ["trip", "days", "saved", "settings:general", "settings:expenses"];
      if (!baseKeys.every(key => sourceMeta.get(key)?.fromCache === false)) return false;
      const dayIds = [...state.days.keys()];
      if (dayIds.length === 0 || dayIds.every(dayId => itemServerReady.has(dayId))) return true;
      const serverRevision = Math.max(1, numberOr(state.tripDoc?.revision, 1));
      return seedComplete && seedWasServerConfirmed && seedRevision > 0 && serverRevision === seedRevision;
    }
  };

  seedDays.forEach(day => {
    const dayId = clean(day?.dayId);
    if (!dayId || !Array.isArray(day?.items)) return;
    const map = new Map();
    day.items.forEach((item, index) => {
      const itemId = clean(item?.itemId) || `seed_${index}`;
      const data = clonePlain(item || {}) || {};
      map.set(itemId, { id: itemId, data, signature: contentSignature(data) });
    });
    state.itemsByDay.set(dayId, map);
    itemReady.add(dayId);
    seededItemDays.add(dayId);
  });

  let desiredRealtimeDayId = clean(options?.activeDayId);
  if (!desiredRealtimeDayId && seedDays.length) desiredRealtimeDayId = clean(seedDays[0]?.dayId);
  // v7.9.3.7 · Trust-chain self repair / live revision baseline. A complete render-cache payload is not
  // automatically a trusted server witness. If a previous launch left the seed
  // unconfirmed, temporarily hydrate every Day once so this session can rebuild
  // archive-grade trust and then fall back to Active-Day Realtime normally.
  let fullHydrationNeeded = !seedComplete || !seedWasServerConfirmed;
  let stopped = false;
  let emitTimer = 0;
  let firstReadyEmitted = false;
  let lastMetadataState = "";
  const dirtySections = new Set();

  function snapshotMeta(key, snapshot) {
    const next = {
      fromCache: snapshot?.metadata?.fromCache === true,
      hasPendingWrites: snapshot?.metadata?.hasPendingWrites === true
    };
    const prev = sourceMeta.get(key);
    sourceMeta.set(key, next);
    return !prev || prev.fromCache !== next.fromCache || prev.hasPendingWrites !== next.hasPendingWrites;
  }

  function markDirty(...sections) {
    sections.flat().filter(Boolean).forEach(section => dirtySections.add(String(section)));
  }

  function readyForEmit() {
    if (!initial.trip || !initial.days || !initial.saved || !initial.general || !initial.expenses) return false;
    for (const dayId of state.days.keys()) {
      if (!itemReady.has(dayId)) return false;
    }
    return true;
  }

  function emitStatus(status, extra = {}) {
    if (stopped) return;
    callback({ status, tripId, ...extra });
  }

  function currentMetadataState() {
    return `${state.allFromCache() ? "cache" : "server"}|${state.allRequiredServerConfirmed() ? "confirmed" : "partial"}|${state.hasPendingWrites() ? "pending" : "clean"}`;
  }

  function scheduleEmit(reason = "change", sections = []) {
    markDirty(sections);
    if (stopped || !readyForEmit() || !state.tripDoc) return;

    const importState = clean(state.tripDoc.importState || "ready");
    const restoreState = clean(state.tripDoc.restoreState || "ready");
    if (importState === "importing" || restoreState === "restoring") {
      emitStatus("syncing", {
        reason: importState === "importing" ? "import" : "restore",
        source: state.allFromCache() ? "cache" : "server"
      });
      return;
    }
    if (importState === "failed" || restoreState === "failed") {
      emitStatus("recovery-needed", {
        reason: importState === "failed" ? "import" : "restore",
        source: state.allFromCache() ? "cache" : "server"
      });
      return;
    }

    clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      if (stopped || !readyForEmit() || !state.tripDoc) return;

      const metadataState = currentMetadataState();
      const sectionsNow = [...dirtySections];
      dirtySections.clear();

      if (firstReadyEmitted && sectionsNow.length === 0) {
        if (metadataState !== lastMetadataState) {
          lastMetadataState = metadataState;
          emitStatus("metadata", {
            source: state.allFromCache() ? "cache" : "server",
            fromCache: state.allFromCache(),
            serverConfirmed: state.allRequiredServerConfirmed(),
            hasPendingWrites: state.hasPendingWrites(),
            reason
          });
        }
        return;
      }

      const data = assemblePortableTrip(tripId, state);
      firstReadyEmitted = true;
      lastMetadataState = metadataState;
      emitStatus("ready", {
        data,
        dirtySections: sectionsNow.length ? sectionsNow : ["initial"],
        reason,
        source: data.cloudMeta?.source || "server",
        fromCache: data.cloudMeta?.source === "cache",
        serverConfirmed: data.cloudMeta?.serverConfirmed === true,
        hasPendingWrites: data.cloudMeta?.hasPendingWrites === true,
        updatedAt: data.cloudMeta?.updatedAt || "",
        realtimeDayId: desiredRealtimeDayId,
        realtimeMode: fullHydrationNeeded ? "full-hydration" : "active-day"
      });
    }, EMIT_DEBOUNCE_MS);
  }

  function detachItemListener(dayId, { dropData = false } = {}) {
    const stop = itemUnsubs.get(dayId);
    if (stop) {
      try { stop(); } catch (error) {}
      itemUnsubs.delete(dayId);
    }
    itemListenerPrimed.delete(dayId);
    sourceMeta.delete(`items:${dayId}`);
    if (dropData) {
      itemReady.delete(dayId);
      itemServerReady.delete(dayId);
      seededItemDays.delete(dayId);
      state.itemsByDay.delete(dayId);
    }
  }

  function replaceItemSnapshot(dayId, snapshot) {
    const previous = state.itemsByDay.get(dayId) || new Map();
    const next = new Map();
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data() || {};
      next.set(docSnap.id, { id: docSnap.id, data, signature: contentSignature(data) });
    });
    const changed = mapSignature(previous) !== mapSignature(next);
    state.itemsByDay.set(dayId, next);
    return changed;
  }

  function applyCollectionChanges(snapshot, targetMap, { idField = "", section = "" } = {}) {
    let contentChanged = false;
    const changes = snapshot.docChanges();
    changes.forEach(change => {
      const id = change.doc.id;
      if (change.type === "removed") {
        if (targetMap.delete(id)) contentChanged = true;
        return;
      }
      const data = change.doc.data() || {};
      const sig = contentSignature(data);
      const prev = targetMap.get(id);
      if (!prev || prev.signature !== sig) contentChanged = true;
      targetMap.set(id, { id, data, signature: sig, idField });
    });
    if (contentChanged && section) markDirty(section);
    return contentChanged;
  }

  function allDaysServerHydrated() {
    const dayIds = [...state.days.keys()];
    return dayIds.length === 0 || dayIds.every(dayId => itemServerReady.has(dayId));
  }

  function finishFullHydrationIfReady() {
    if (!fullHydrationNeeded || !allDaysServerHydrated()) return false;
    fullHydrationNeeded = false;
    state.days.forEach((_, dayId) => seededItemDays.add(dayId));
    if (sourceMeta.get("trip")?.fromCache === false) {
      hydratedRevision = Math.max(1, numberOr(state.tripDoc?.revision, hydratedRevision || 1));
      hydrationTargetRevision = 0;
    }
    return true;
  }

  function reconcileItemListeners() {
    if (stopped || !initial.days) return;
    const dayIds = [...state.days.keys()];
    if ((!desiredRealtimeDayId || !state.days.has(desiredRealtimeDayId)) && dayIds.length) {
      desiredRealtimeDayId = dayIds[0];
    }

    dayIds.forEach(dayId => {
      const active = dayId === desiredRealtimeDayId;
      const missingLocalData = !itemReady.has(dayId);
      const needsOneShotServerHydration = missingLocalData && !itemServerReady.has(dayId);
      if (fullHydrationNeeded || active || needsOneShotServerHydration) attachItemListener(dayId);
      else detachItemListener(dayId);
    });

    [...itemUnsubs.keys()].forEach(dayId => {
      if (!state.days.has(dayId)) detachItemListener(dayId, { dropData: true });
    });
  }

  function attachItemListener(dayId) {
    if (!dayId || itemUnsubs.has(dayId)) return;
    if (!state.itemsByDay.has(dayId)) state.itemsByDay.set(dayId, new Map());

    const stop = onSnapshot(
      collection(db, "trips", tripId, "days", dayId, "items"),
      { includeMetadataChanges: true },
      snapshot => {
        snapshotMeta(`items:${dayId}`, snapshot);
        const firstSnapshot = !itemListenerPrimed.has(dayId);
        let changed = false;
        if (firstSnapshot) {
          changed = replaceItemSnapshot(dayId, snapshot);
          itemListenerPrimed.add(dayId);
          if (changed) markDirty(`items:${dayId}`);
        } else {
          const map = state.itemsByDay.get(dayId) || new Map();
          changed = applyCollectionChanges(snapshot, map, { section: `items:${dayId}` });
          state.itemsByDay.set(dayId, map);
        }
        itemReady.add(dayId);
        if (snapshot.metadata?.fromCache !== true) itemServerReady.add(dayId);
        const finishedHydration = finishFullHydrationIfReady();
        scheduleEmit(snapshot.metadata?.fromCache ? "cache" : "items", changed ? [`items:${dayId}`] : []);
        if (finishedHydration || (dayId !== desiredRealtimeDayId && itemServerReady.has(dayId))) {
          queueMicrotask(reconcileItemListeners);
        }
      },
      error => emitStatus(error?.code === "permission-denied" ? "permission-denied" : "error", { error })
    );
    itemUnsubs.set(dayId, stop);
  }

  emitStatus("loading", { source: "unknown" });

  unsubs.push(onSnapshot(
    doc(db, "trips", tripId),
    { includeMetadataChanges: true },
    snapshot => {
      snapshotMeta("trip", snapshot);
      initial.trip = true;
      if (!snapshot.exists()) {
        state.tripDoc = null;
        emitStatus("not-found");
        return;
      }
      const next = snapshot.data() || {};
      const sig = contentSignature(next);
      const hadPrevious = documentSignatures.has("trip");
      const changed = documentSignatures.get("trip") !== sig;
      const previous = state.tripDoc;
      documentSignatures.set("trip", sig);
      state.tripDoc = next;

      const serverRevision = Math.max(1, numberOr(next.revision, 1));
      if (hydratedRevision && serverRevision !== hydratedRevision) {
        // A root revision can arrive before every Day/items listener reflects
        // the same transaction. Invalidate old-revision hydration evidence once
        // per target revision so assemblePortableTrip cannot label that mixed
        // snapshot serverConfirmed and briefly resurrect a deleted item.
        if (hydrationTargetRevision !== serverRevision) {
          hydrationTargetRevision = serverRevision;
          itemServerReady.clear();
        }
        fullHydrationNeeded = true;
        reconcileItemListeners();
      }

      const sections = changed ? (hadPrevious ? changedTopLevelKeys(previous, next).map(key => `trip:${key}`) : ["trip"]) : [];
      scheduleEmit(snapshot.metadata?.fromCache ? "cache" : "trip", sections.length ? sections : (changed ? ["trip"] : []));
    },
    error => emitStatus(error?.code === "permission-denied" ? "permission-denied" : "error", { error })
  ));

  unsubs.push(onSnapshot(
    collection(db, "trips", tripId, "days"),
    { includeMetadataChanges: true },
    snapshot => {
      snapshotMeta("days", snapshot);
      initial.days = true;
      const changes = snapshot.docChanges();
      let changed = false;
      changes.forEach(change => {
        const dayId = change.doc.id;
        if (change.type === "removed") {
          if (state.days.delete(dayId)) changed = true;
          detachItemListener(dayId, { dropData: true });
          return;
        }
        const data = change.doc.data() || {};
        const sig = contentSignature(data);
        const prev = state.days.get(dayId);
        if (!prev || prev.signature !== sig) changed = true;
        state.days.set(dayId, { id: dayId, data, signature: sig });
      });
      reconcileItemListeners();
      scheduleEmit(snapshot.metadata?.fromCache ? "cache" : "days", changed ? ["days"] : []);
    },
    error => emitStatus(error?.code === "permission-denied" ? "permission-denied" : "error", { error })
  ));

  unsubs.push(onSnapshot(
    collection(db, "trips", tripId, "savedPlaces"),
    { includeMetadataChanges: true },
    snapshot => {
      snapshotMeta("saved", snapshot);
      initial.saved = true;
      const changed = applyCollectionChanges(snapshot, state.savedPlaces, { section: "snacks" });
      scheduleEmit(snapshot.metadata?.fromCache ? "cache" : "saved", changed ? ["snacks"] : []);
    },
    error => emitStatus(error?.code === "permission-denied" ? "permission-denied" : "error", { error })
  ));

  ["general", "expenses"].forEach(settingId => {
    unsubs.push(onSnapshot(
      doc(db, "trips", tripId, "settings", settingId),
      { includeMetadataChanges: true },
      snapshot => {
        snapshotMeta(`settings:${settingId}`, snapshot);
        initial[settingId] = true;
        const next = snapshot.exists() ? snapshot.data() || {} : {};
        const sig = contentSignature(next);
        const key = `settings:${settingId}`;
        const hadPrevious = documentSignatures.has(key);
        const changed = documentSignatures.get(key) !== sig;
        const previous = state.settings[settingId] || {};
        documentSignatures.set(key, sig);
        state.settings[settingId] = next;
        let sections = [];
        if (changed) {
          if (settingId === "general" && hadPrevious) {
            sections = changedTopLevelKeys(previous, next).map(field => `general:${field}`);
          } else {
            sections = [settingId];
          }
        }
        scheduleEmit(snapshot.metadata?.fromCache ? "cache" : key, sections.length ? sections : (changed ? [settingId] : []));
      },
      error => emitStatus(error?.code === "permission-denied" ? "permission-denied" : "error", { error })
    ));
  });

  const stopAll = () => {
    stopped = true;
    clearTimeout(emitTimer);
    unsubs.forEach(stop => { try { stop(); } catch (error) {} });
    itemUnsubs.forEach(stop => { try { stop(); } catch (error) {} });
    itemUnsubs.clear();
    dirtySections.clear();
  };

  stopAll.setActiveDayId = dayIdInput => {
    const dayId = clean(dayIdInput);
    if (!dayId || dayId === desiredRealtimeDayId) return;
    desiredRealtimeDayId = dayId;
    reconcileItemListeners();
  };
  stopAll.getActiveDayId = () => desiredRealtimeDayId;

  return stopAll;
}
