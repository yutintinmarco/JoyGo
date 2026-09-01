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
import {
  TRIP_MEDIA_OWNER_TYPES,
  deleteTripMedia,
  uploadTripImage
} from "./trip-media-service.js";

const MANAGER_ROLES = new Set(["owner", "admin"]);
const FEATURE_KEYS = new Set(["savedPlaces", "expenses"]);

function clean(value) { return String(value ?? "").trim(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function normalizeHex(value) {
  const raw = clean(value).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(raw) ? raw : "";
}

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

function activityPayload({ user, type, title, summary, feature = "", color = "" }) {
  return {
    type,
    actionType: type,
    category: "itinerary",
    title,
    summary,
    actorUid: user.uid,
    actorName: clean(user.displayName),
    actorEmail: clean(user.email).toLowerCase(),
    feature,
    color,
    createdAt: serverTimestamp()
  };
}

export async function updateTripAccentColor(tripIdInput, colorInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const color = normalizeHex(colorInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("旅程主色設定");
  if (!tripId) {
    const error = new Error("Missing trip");
    error.code = "invalid-trip";
    throw error;
  }
  if (!color) {
    const error = new Error("Invalid colour");
    error.code = "invalid-colour";
    throw error;
  }
  await requireManager(tripId, user);
  const tripRef = doc(db, "trips", tripId);
  const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(tripRef, {
    accentColor: color,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(logRef, activityPayload({
    user,
    type: "trip.appearance.accent_updated",
    title: "更新旅程主色",
    summary: `旅程主色已更新為 ${color}`,
    color
  }));
  await batch.commit();
  return { tripId, color };
}

export async function updateFeatureColor(tripIdInput, featureInput, colorInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const feature = clean(featureInput);
  const color = normalizeHex(colorInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("功能顏色設定");
  if (!tripId || !FEATURE_KEYS.has(feature)) {
    const error = new Error("Invalid feature");
    error.code = "invalid-feature";
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
  const featureColors = generalData?.featureColors && typeof generalData.featureColors === "object"
    ? clone(generalData.featureColors)
    : {};
  featureColors[feature] = color;
  const label = feature === "savedPlaces" ? "收藏" : "支出";
  const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.set(generalRef, {
    featureColors,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
  batch.set(logRef, activityPayload({
    user,
    type: "trip.appearance.feature_color_updated",
    title: `更新${label}顏色`,
    summary: `${label}已改用自訂顏色 ${color}`,
    feature,
    color
  }));
  await batch.commit();
  return { tripId, feature, color, followsTrip: false };
}

export async function resetFeatureColor(tripIdInput, featureInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const feature = clean(featureInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("功能顏色設定");
  if (!tripId || !FEATURE_KEYS.has(feature)) {
    const error = new Error("Invalid feature");
    error.code = "invalid-feature";
    throw error;
  }
  await requireManager(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const generalData = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const featureColors = generalData?.featureColors && typeof generalData.featureColors === "object"
    ? clone(generalData.featureColors)
    : {};
  delete featureColors[feature];
  const label = feature === "savedPlaces" ? "收藏" : "支出";
  const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.set(generalRef, {
    featureColors,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
  batch.set(logRef, activityPayload({
    user,
    type: "trip.appearance.feature_color_updated",
    title: `更新${label}顏色`,
    summary: `${label}已恢復跟隨旅程主色`,
    feature,
    color: ""
  }));
  await batch.commit();
  return { tripId, feature, color: "", followsTrip: true };
}


function mediaDescriptorFromUploadRecord(record = {}) {
  const mediaId = clean(record.mediaId || record.imageId);
  const descriptor = {
    imageId: mediaId,
    mediaId,
    mediaSchemaVersion: Number(record.mediaSchemaVersion) || 1,
    source: "storage",
    tripId: clean(record.tripId),
    storagePath: clean(record.storagePath),
    thumbnailStoragePath: clean(record.thumbnailStoragePath),
    contentType: clean(record.contentType),
    byteSize: Number(record.byteSize) || 0,
    width: Number(record.width) || 0,
    height: Number(record.height) || 0,
    generation: clean(record.generation),
    thumbnailContentType: clean(record.thumbnailContentType),
    thumbnailByteSize: Number(record.thumbnailByteSize) || 0,
    thumbnailWidth: Number(record.thumbnailWidth) || 0,
    thumbnailHeight: Number(record.thumbnailHeight) || 0,
    thumbnailGeneration: clean(record.thumbnailGeneration),
    sortOrder: 0
  };
  return Object.fromEntries(Object.entries(descriptor).filter(([, value]) => value !== "" && value !== 0 && value != null));
}

function mediaRecordForDelete(descriptor, tripId) {
  if (!descriptor || typeof descriptor !== "object") return null;
  const mediaId = clean(descriptor.mediaId || descriptor.imageId || descriptor.id);
  const storagePath = clean(descriptor.storagePath);
  if (!mediaId || !storagePath) return null;
  return {
    ...clone(descriptor),
    tripId: clean(descriptor.tripId || tripId),
    mediaId,
    storagePath,
    thumbnailStoragePath: clean(descriptor.thumbnailStoragePath)
  };
}

async function requireEditableTrip(tripId, user) {
  await requireManager(tripId, user);
  const tripRef = doc(db, "trips", tripId);
  const tripSnap = await getDoc(tripRef);
  if (!tripSnap.exists()) {
    const error = new Error("Trip not found");
    error.code = "not-found";
    throw error;
  }
  const trip = tripSnap.data() || {};
  if (trip.deletionState === "deleting") {
    const error = new Error("Trip deletion is in progress");
    error.code = "trip-deleting";
    throw error;
  }
  if (trip.globalLocked === true) {
    const error = new Error("Trip is globally locked");
    error.code = "trip-global-locked";
    throw error;
  }
  return { tripRef, trip };
}

async function cleanupPreviousTripIcon(descriptor, tripId, user) {
  const record = mediaRecordForDelete(descriptor, tripId);
  if (!record) return { attempted: false, cleaned: true };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deleteTripMedia(record, { user });
      return { attempted: true, cleaned: true };
    } catch (error) {
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 650));
      else return { attempted: true, cleaned: false, error };
    }
  }
  return { attempted: true, cleaned: false };
}

export async function updateTripIconImage(tripIdInput, file, {
  user: userInput = null,
  onProgress = null
} = {}) {
  const tripId = clean(tripIdInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("旅程圖示上載");
  if (!tripId) {
    const error = new Error("Missing trip");
    error.code = "invalid-trip";
    throw error;
  }
  if (!(file instanceof Blob)) {
    const error = new Error("Image file is required");
    error.code = "invalid-media-file";
    throw error;
  }

  const { tripRef, trip } = await requireEditableTrip(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const general = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const previous = clone(trip.tripIconMedia || general.tripIconMedia || null);

  let uploadedRecord = null;
  try {
    uploadedRecord = await uploadTripImage({
      tripId,
      ownerType: TRIP_MEDIA_OWNER_TYPES.TRIP,
      ownerId: "",
      slot: "icon",
      file,
      user,
      onProgress
    });
    const descriptor = mediaDescriptorFromUploadRecord(uploadedRecord);
    const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
    const batch = writeBatch(db);
    batch.update(tripRef, {
      tripIconMedia: descriptor,
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    });
    batch.set(generalRef, {
      tripIconMedia: descriptor,
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    batch.set(logRef, activityPayload({
      user,
      type: "trip.media.icon_updated",
      title: "更新旅程圖示",
      summary: "旅程圖示已更新至 Firebase Storage"
    }));
    await batch.commit();

    const previousMediaId = clean(previous?.mediaId || previous?.imageId);
    const nextMediaId = clean(descriptor.mediaId || descriptor.imageId);
    const cleanup = previousMediaId && previousMediaId !== nextMediaId
      ? await cleanupPreviousTripIcon(previous, tripId, user)
      : { attempted: false, cleaned: true };
    return { tripId, descriptor, cleanup };
  } catch (error) {
    if (uploadedRecord) {
      try { await deleteTripMedia(uploadedRecord, { user }); }
      catch (cleanupError) { console.warn("Unable to roll back unattached Trip icon media", cleanupError); }
    }
    throw error;
  }
}

export async function removeTripIconImage(tripIdInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("旅程圖示移除");
  if (!tripId) {
    const error = new Error("Missing trip");
    error.code = "invalid-trip";
    throw error;
  }

  const { tripRef, trip } = await requireEditableTrip(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const general = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const previous = clone(trip.tripIconMedia || general.tripIconMedia || null);
  if (!mediaRecordForDelete(previous, tripId)) return { tripId, removed: false, cleanup: { attempted: false, cleaned: true } };

  const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(tripRef, {
    tripIconMedia: null,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(generalRef, {
    tripIconMedia: null,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
  batch.set(logRef, activityPayload({
    user,
    type: "trip.media.icon_removed",
    title: "移除旅程圖示",
    summary: "已恢復旅程原有圖示"
  }));
  await batch.commit();

  const cleanup = await cleanupPreviousTripIcon(previous, tripId, user);
  return { tripId, removed: true, cleanup };
}


export async function updateTripBackgroundImage(tripIdInput, file, {
  user: userInput = null,
  onProgress = null
} = {}) {
  const tripId = clean(tripIdInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("旅程背景上載");
  if (!tripId) {
    const error = new Error("Missing trip");
    error.code = "invalid-trip";
    throw error;
  }
  if (!(file instanceof Blob)) {
    const error = new Error("Image file is required");
    error.code = "invalid-media-file";
    throw error;
  }

  const { tripRef, trip } = await requireEditableTrip(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const general = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const previous = clone(trip.backgroundImageMedia || general.backgroundImageMedia || null);

  let uploadedRecord = null;
  try {
    uploadedRecord = await uploadTripImage({
      tripId,
      ownerType: TRIP_MEDIA_OWNER_TYPES.TRIP,
      ownerId: "",
      slot: "background",
      file,
      user,
      onProgress
    });
    const descriptor = mediaDescriptorFromUploadRecord(uploadedRecord);
    const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
    const batch = writeBatch(db);
    batch.update(tripRef, {
      backgroundImageMedia: descriptor,
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    });
    batch.set(generalRef, {
      backgroundImageMedia: descriptor,
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    }, { merge: true });
    batch.set(logRef, activityPayload({
      user,
      type: "trip.media.background_updated",
      title: "更新旅程背景",
      summary: "旅程背景已更新至 Firebase Storage"
    }));
    await batch.commit();

    const previousMediaId = clean(previous?.mediaId || previous?.imageId);
    const nextMediaId = clean(descriptor.mediaId || descriptor.imageId);
    const cleanup = previousMediaId && previousMediaId !== nextMediaId
      ? await cleanupPreviousTripIcon(previous, tripId, user)
      : { attempted: false, cleaned: true };
    return { tripId, descriptor, cleanup };
  } catch (error) {
    if (uploadedRecord) {
      try { await deleteTripMedia(uploadedRecord, { user }); }
      catch (cleanupError) { console.warn("Unable to roll back unattached Trip background media", cleanupError); }
    }
    throw error;
  }
}

export async function removeTripBackgroundImage(tripIdInput, { user: userInput = null } = {}) {
  const tripId = clean(tripIdInput);
  const user = await requireUser(userInput);
  assertCloudOperationAvailable("旅程背景移除");
  if (!tripId) {
    const error = new Error("Missing trip");
    error.code = "invalid-trip";
    throw error;
  }

  const { tripRef, trip } = await requireEditableTrip(tripId, user);
  const generalRef = doc(db, "trips", tripId, "settings", "general");
  const generalSnap = await getDoc(generalRef);
  const general = generalSnap.exists() ? (generalSnap.data() || {}) : {};
  const previous = clone(trip.backgroundImageMedia || general.backgroundImageMedia || null);
  if (!mediaRecordForDelete(previous, tripId)) {
    return { tripId, removed: false, cleanup: { attempted: false, cleaned: true } };
  }

  const logRef = doc(collection(db, "trips", tripId, "activityLogs"));
  const batch = writeBatch(db);
  batch.update(tripRef, {
    backgroundImageMedia: null,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  });
  batch.set(generalRef, {
    backgroundImageMedia: null,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
  batch.set(logRef, activityPayload({
    user,
    type: "trip.media.background_removed",
    title: "移除旅程背景",
    summary: "已恢復旅程原有背景"
  }));
  await batch.commit();

  const cleanup = await cleanupPreviousTripIcon(previous, tripId, user);
  return { tripId, removed: true, cleanup };
}
