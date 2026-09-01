/*
 * v7.9.4.2 · Phase 3A Local-First Media Performance + Crop Metadata
 *
 * This module deliberately has no UI dependency. It provides one canonical
 * Trip media namespace, client-side image compression, Storage upload/download,
 * a lightweight Firestore media registry and a best-effort IndexedDB blob cache.
 */

import { firebaseApp, db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import { assertCloudOperationAvailable } from "./cloud-safety-service.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc
} from "./firestore-observed-service.js";
import {
  clearTripMediaCache,
  getTripMediaCache,
  putTripMediaCache,
  removeTripMediaCache
} from "./trip-media-cache-service.js";
import {
  deleteObject,
  getBlob,
  getMetadata,
  getStorage,
  ref,
  uploadBytesResumable
} from "https://www.gstatic.com/firebasejs/11.8.0/firebase-storage.js";

export const TRIP_MEDIA_SCHEMA_VERSION = 1;
export const TRIP_MEDIA_OWNER_TYPES = Object.freeze({
  TRIP: "trip",
  ITEM: "item",
  SAVED_PLACE: "savedPlace"
});
export const TRIP_MEDIA_LIMITS = Object.freeze({
  sourceMaxBytes: 30 * 1024 * 1024,
  displayMaxDimension: 2048,
  thumbnailMaxDimension: 640,
  storageObjectMaxBytes: 6 * 1024 * 1024,
  downloadMaxBytes: 8 * 1024 * 1024,
  displayQuality: 0.82,
  thumbnailQuality: 0.76
});
export const TRIP_MEDIA_UPLOAD_PROFILES = Object.freeze({
  icon: Object.freeze({
    displayMaxDimension: 768,
    thumbnailMaxDimension: 256,
    displayQuality: 0.78,
    thumbnailQuality: 0.72,
    displayTargetBytes: 420 * 1024,
    thumbnailTargetBytes: 120 * 1024
  }),
  background: Object.freeze({
    displayMaxDimension: 2048,
    thumbnailMaxDimension: 640,
    displayQuality: 0.78,
    thumbnailQuality: 0.72,
    displayTargetBytes: 950 * 1024,
    thumbnailTargetBytes: 220 * 1024
  }),
  itinerary: Object.freeze({
    displayMaxDimension: 1600,
    thumbnailMaxDimension: 480,
    displayQuality: 0.78,
    thumbnailQuality: 0.72,
    displayTargetBytes: 800 * 1024,
    thumbnailTargetBytes: 180 * 1024
  }),
  savedPlace: Object.freeze({
    displayMaxDimension: 1600,
    thumbnailMaxDimension: 480,
    displayQuality: 0.78,
    thumbnailQuality: 0.72,
    displayTargetBytes: 800 * 1024,
    thumbnailTargetBytes: 180 * 1024
  })
});

const storage = getStorage(firebaseApp);
const OWNER_TYPES = new Set(Object.values(TRIP_MEDIA_OWNER_TYPES));


const BACKUP_REGISTRY_SNAPSHOT_MAX_AGE_MS = 90 * 1000;
const backupRegistrySnapshots = new Map();

function abortError(stage = "media-operation") {
  const error = new Error(`${stage} cancelled`);
  error.code = "operation-aborted";
  error.stage = stage;
  return error;
}
function timeoutError(stage = "media-operation", timeoutMs = 0) {
  const error = new Error(`${stage} timed out`);
  error.code = "media-operation-timeout";
  error.stage = stage;
  error.timeoutMs = timeoutMs;
  return error;
}
function throwIfAborted(signal, stage = "media-operation") {
  if (signal?.aborted) throw abortError(stage);
}
async function awaitWithTimeout(promise, { timeoutMs = 0, signal = null, stage = "media-operation", fallbackOnTimeout = undefined } = {}) {
  throwIfAborted(signal, stage);
  const timeout = Math.max(0, finiteNumber(timeoutMs));
  let timer = null;
  let abortHandler = null;
  try {
    const races = [Promise.resolve(promise)];
    if (timeout > 0) races.push(new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (fallbackOnTimeout !== undefined) resolve(fallbackOnTimeout);
        else reject(timeoutError(stage, timeout));
      }, timeout);
    }));
    if (signal) races.push(new Promise((_, reject) => {
      abortHandler = () => reject(abortError(stage));
      signal.addEventListener("abort", abortHandler, { once: true });
    }));
    return await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}
function sortedRegistryRecords(snapshot) {
  return snapshot.docs.map(registryRecordFromSnapshot).sort((a, b) => {
    const order = finiteNumber(a.sortOrder) - finiteNumber(b.sortOrder);
    return order || a.mediaId.localeCompare(b.mediaId);
  });
}
function invalidateBackupRegistrySnapshot(tripIdInput) {
  const tripId = clean(tripIdInput);
  if (tripId) backupRegistrySnapshots.delete(tripId);
}
function rememberBackupRegistrySnapshot(tripId, records) {
  backupRegistrySnapshots.set(tripId, {
    records: records.map(record => ({ ...record })),
    serverConfirmedAt: Date.now()
  });
}
function readFreshBackupRegistrySnapshot(tripId, maxAgeMs = BACKUP_REGISTRY_SNAPSHOT_MAX_AGE_MS) {
  const cached = backupRegistrySnapshots.get(tripId);
  if (!cached) return null;
  if (Date.now() - finiteNumber(cached.serverConfirmedAt) > Math.max(1000, finiteNumber(maxAgeMs, BACKUP_REGISTRY_SNAPSHOT_MAX_AGE_MS))) return null;
  return { records: cached.records.map(record => ({ ...record })), serverConfirmedAt: cached.serverConfirmedAt };
}

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function safeSegment(value, fallback = "media") {
  const text = clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  return text || fallback;
}
function nowMediaId() {
  try {
    if (globalThis.crypto?.randomUUID) return `med_${crypto.randomUUID().replace(/-/g, "")}`;
  } catch (error) {}
  const random = Math.random().toString(36).slice(2, 12);
  return `med_${Date.now().toString(36)}${random}`;
}
function errorWithCode(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}
function storageNotFound(error) {
  return clean(error?.code) === "storage/object-not-found";
}

async function requireUser(input = null) {
  const user = input || getCurrentUser() || await waitForInitialAuth();
  if (!user?.uid) throw errorWithCode("Google sign-in required", "auth-required");
  return user;
}

function normalizeOwner(ownerTypeInput, ownerIdInput, slotInput = "") {
  const ownerType = clean(ownerTypeInput);
  const ownerId = clean(ownerIdInput);
  const slot = clean(slotInput);
  if (!OWNER_TYPES.has(ownerType)) throw errorWithCode("Unsupported media owner type", "invalid-media-owner");
  if (ownerType !== TRIP_MEDIA_OWNER_TYPES.TRIP && !ownerId) {
    throw errorWithCode("Media owner id is required", "invalid-media-owner");
  }
  return { ownerType, ownerId, slot };
}

function folderForOwner({ ownerType, ownerId, slot }, mediaId) {
  if (ownerType === TRIP_MEDIA_OWNER_TYPES.TRIP) {
    return `trip/${safeSegment(slot || ownerId || "general", "general")}/${safeSegment(mediaId)}`;
  }
  if (ownerType === TRIP_MEDIA_OWNER_TYPES.ITEM) {
    return `items/${safeSegment(ownerId, "item")}/${safeSegment(mediaId)}`;
  }
  return `savedPlaces/${safeSegment(ownerId, "place")}/${safeSegment(mediaId)}`;
}

function extensionForMime(type) {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  return "webp";
}

function outputMimePreference(sourceType) {
  const type = clean(sourceType).toLowerCase();
  if (type === "image/png") return "image/webp";
  return "image/webp";
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw(context, width, height) { context.drawImage(bitmap, 0, 0, width, height); },
        close() { try { bitmap.close(); } catch (error) {} }
      };
    } catch (error) {
      try {
        const bitmap = await createImageBitmap(blob);
        return {
          width: bitmap.width,
          height: bitmap.height,
          draw(context, width, height) { context.drawImage(bitmap, 0, 0, width, height); },
          close() { try { bitmap.close(); } catch (closeError) {} }
        };
      } catch (fallbackError) {}
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const node = new Image();
      node.onload = () => resolve(node);
      node.onerror = () => reject(errorWithCode("Unable to decode image", "media-decode-failed"));
      node.src = objectUrl;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw(context, width, height) { context.drawImage(image, 0, 0, width, height); },
      close() { URL.revokeObjectURL(objectUrl); }
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function targetSize(width, height, maxDimension) {
  const longest = Math.max(width, height);
  if (!longest || longest <= maxDimension) return { width, height };
  const ratio = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

async function renderVariant(decoded, { maxDimension, quality, preferredType, targetBytes = 0 }) {
  const dimensions = targetSize(decoded.width, decoded.height, maxDimension);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw errorWithCode("Canvas unavailable", "media-compression-unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, dimensions.width, dimensions.height);
  decoded.draw(context, dimensions.width, dimensions.height);

  let contentType = preferredType || "image/webp";
  const initialQuality = Math.max(0.55, Math.min(0.92, finiteNumber(quality, 0.78)));
  const qualitySteps = [...new Set([initialQuality, Math.max(0.62, initialQuality - 0.08), 0.60].map(value => Number(value.toFixed(2))))];
  let blob = null;
  for (const attemptQuality of qualitySteps) {
    blob = await canvasToBlob(canvas, contentType, attemptQuality);
    if (!blob && contentType !== "image/jpeg") {
      contentType = "image/jpeg";
      blob = await canvasToBlob(canvas, contentType, Math.min(0.82, attemptQuality + 0.02));
    }
    if (!blob) continue;
    if (!targetBytes || blob.size <= targetBytes) break;
  }
  if (!blob) throw errorWithCode("Unable to encode image", "media-compression-failed");
  return {
    blob,
    width: dimensions.width,
    height: dimensions.height,
    contentType: clean(blob.type || contentType)
  };
}
export async function prepareTripImageVariants(sourceBlob, options = {}) {
  if (!(sourceBlob instanceof Blob)) throw errorWithCode("Image file is required", "invalid-media-file");
  const sourceBytes = finiteNumber(sourceBlob.size);
  if (sourceBytes <= 0 || sourceBytes > TRIP_MEDIA_LIMITS.sourceMaxBytes) {
    throw errorWithCode("Image file is too large", "media-source-too-large", { sourceBytes });
  }
  const sourceType = clean(sourceBlob.type).toLowerCase();
  if (!sourceType.startsWith("image/")) {
    throw errorWithCode("Only image files are supported", "unsupported-media-type", { contentType: sourceType });
  }

  const decoded = await decodeImage(sourceBlob);
  try {
    if (!decoded.width || !decoded.height) throw errorWithCode("Image dimensions are invalid", "media-decode-failed");
    const preferredType = outputMimePreference(sourceType);
    const [display, thumbnail] = await Promise.all([
      renderVariant(decoded, {
        maxDimension: finiteNumber(options.displayMaxDimension, TRIP_MEDIA_LIMITS.displayMaxDimension),
        quality: finiteNumber(options.displayQuality, TRIP_MEDIA_LIMITS.displayQuality),
        targetBytes: finiteNumber(options.displayTargetBytes),
        preferredType
      }),
      renderVariant(decoded, {
        maxDimension: finiteNumber(options.thumbnailMaxDimension, TRIP_MEDIA_LIMITS.thumbnailMaxDimension),
        quality: finiteNumber(options.thumbnailQuality, TRIP_MEDIA_LIMITS.thumbnailQuality),
        targetBytes: finiteNumber(options.thumbnailTargetBytes),
        preferredType
      })
    ]);
    if (display.blob.size > TRIP_MEDIA_LIMITS.storageObjectMaxBytes || thumbnail.blob.size > TRIP_MEDIA_LIMITS.storageObjectMaxBytes) {
      throw errorWithCode("Compressed image still exceeds Storage limit", "media-compressed-too-large", {
        displayBytes: display.blob.size,
        thumbnailBytes: thumbnail.blob.size
      });
    }
    return {
      source: {
        contentType: sourceType,
        byteSize: sourceBytes,
        width: decoded.width,
        height: decoded.height
      },
      display,
      thumbnail
    };
  } finally {
    decoded.close();
  }
}

function uploadBlob(storagePath, blob, metadata, onProgress = null) {
  return new Promise((resolve, reject) => {
    const objectRef = ref(storage, storagePath);
    const task = uploadBytesResumable(objectRef, blob, metadata);
    task.on("state_changed", snapshot => {
      if (typeof onProgress !== "function") return;
      const fraction = snapshot.totalBytes > 0 ? snapshot.bytesTransferred / snapshot.totalBytes : 0;
      onProgress({
        storagePath,
        fraction,
        bytesTransferred: snapshot.bytesTransferred,
        totalBytes: snapshot.totalBytes
      });
    }, reject, () => {
      // UploadTaskSnapshot already carries FullMetadata. Avoid an additional
      // getMetadata() round trip for every object after a successful upload.
      resolve(task.snapshot.metadata || {});
    });
  });
}
async function bestEffortDelete(storagePath) {
  const path = clean(storagePath);
  if (!path) return;
  try {
    await deleteObject(ref(storage, path));
  } catch (error) {
    if (!storageNotFound(error)) console.warn("Unable to clean partial Trip media upload", path, error);
  }
}

function registryRecordFromSnapshot(snapshot) {
  const data = snapshot?.data?.() || {};
  return {
    ...data,
    mediaId: clean(data.mediaId || snapshot?.id),
    tripId: clean(data.tripId),
    ownerType: clean(data.ownerType),
    ownerId: clean(data.ownerId),
    slot: clean(data.slot),
    storagePath: clean(data.storagePath),
    thumbnailStoragePath: clean(data.thumbnailStoragePath),
    generation: clean(data.generation),
    thumbnailGeneration: clean(data.thumbnailGeneration)
  };
}

function mediaUploadProfile(owner, slotInput = "") {
  const slot = clean(slotInput || owner?.slot).toLowerCase();
  if (owner?.ownerType === TRIP_MEDIA_OWNER_TYPES.TRIP && slot === "icon") return TRIP_MEDIA_UPLOAD_PROFILES.icon;
  if (owner?.ownerType === TRIP_MEDIA_OWNER_TYPES.TRIP && slot === "background") return TRIP_MEDIA_UPLOAD_PROFILES.background;
  if (owner?.ownerType === TRIP_MEDIA_OWNER_TYPES.SAVED_PLACE) return TRIP_MEDIA_UPLOAD_PROFILES.savedPlace;
  return TRIP_MEDIA_UPLOAD_PROFILES.itinerary;
}

function plainMediaRecordForLocal({ tripId, owner, mediaId, variants, displayPath, thumbnailPath }) {
  return {
    mediaSchemaVersion: TRIP_MEDIA_SCHEMA_VERSION,
    mediaId,
    imageId: mediaId,
    tripId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    slot: owner.slot,
    status: "local-pending",
    storagePath: displayPath,
    thumbnailStoragePath: thumbnailPath,
    contentType: variants.display.contentType,
    byteSize: variants.display.blob.size,
    width: variants.display.width,
    height: variants.display.height,
    thumbnailContentType: variants.thumbnail.contentType,
    thumbnailByteSize: variants.thumbnail.blob.size,
    thumbnailWidth: variants.thumbnail.width,
    thumbnailHeight: variants.thumbnail.height,
    sourceContentType: variants.source.contentType,
    sourceByteSize: variants.source.byteSize,
    sourceWidth: variants.source.width,
    sourceHeight: variants.source.height
  };
}

export async function prepareTripImageLocalAsset({
  tripId: tripIdInput,
  ownerType: ownerTypeInput,
  ownerId: ownerIdInput = "",
  slot: slotInput = "",
  file,
  mediaId: mediaIdInput = ""
} = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) throw errorWithCode("Missing tripId", "invalid-trip-id");
  const owner = normalizeOwner(ownerTypeInput, ownerIdInput, slotInput);
  const mediaId = safeSegment(mediaIdInput || nowMediaId(), nowMediaId());
  const profile = mediaUploadProfile(owner, slotInput);
  const variants = await prepareTripImageVariants(file, profile);
  const folder = folderForOwner(owner, mediaId);
  const displayPath = `trips/${tripId}/media/${folder}/display.${extensionForMime(variants.display.contentType)}`;
  const thumbnailPath = `trips/${tripId}/media/${folder}/thumb.${extensionForMime(variants.thumbnail.contentType)}`;
  const record = plainMediaRecordForLocal({ tripId, owner, mediaId, variants, displayPath, thumbnailPath });
  const cached = await Promise.all([
    putTripMediaCache(displayPath, variants.display.blob, { contentType: record.contentType, tripId, mediaId, variant: "display" }),
    putTripMediaCache(thumbnailPath, variants.thumbnail.blob, { contentType: record.thumbnailContentType, tripId, mediaId, variant: "thumbnail" })
  ]);
  if (!cached.every(Boolean)) {
    await Promise.allSettled([removeTripMediaCache(displayPath), removeTripMediaCache(thumbnailPath)]);
    throw errorWithCode("Unable to save image locally", "media-local-cache-unavailable");
  }
  return { record, profile };
}

function combinedUploadProgress(onProgress, { start = 0.12, end = 0.82, displayBytes = 0, thumbnailBytes = 0 } = {}) {
  if (typeof onProgress !== "function") return () => {};
  const totals = { display: Math.max(1, finiteNumber(displayBytes)), thumbnail: Math.max(1, finiteNumber(thumbnailBytes)) };
  const fractions = { display: 0, thumbnail: 0 };
  return (variant, info = {}) => {
    fractions[variant] = Math.max(0, Math.min(1, finiteNumber(info.fraction)));
    const total = totals.display + totals.thumbnail;
    const done = fractions.display * totals.display + fractions.thumbnail * totals.thumbnail;
    onProgress({
      stage: "upload",
      variant,
      storagePath: clean(info.storagePath),
      progress: start + (end - start) * (done / total),
      bytesTransferred: finiteNumber(info.bytesTransferred),
      totalBytes: finiteNumber(info.totalBytes)
    });
  };
}

function cloudPendingRecordFromLocal(record, user) {
  return {
    mediaSchemaVersion: Math.max(1, finiteNumber(record.mediaSchemaVersion, TRIP_MEDIA_SCHEMA_VERSION)),
    mediaId: clean(record.mediaId),
    tripId: clean(record.tripId),
    ownerType: clean(record.ownerType),
    ownerId: clean(record.ownerId),
    slot: clean(record.slot),
    status: "uploading",
    caption: clean(record.caption),
    sortOrder: finiteNumber(record.sortOrder),
    storagePath: clean(record.storagePath),
    thumbnailStoragePath: clean(record.thumbnailStoragePath),
    contentType: clean(record.contentType),
    byteSize: finiteNumber(record.byteSize),
    width: finiteNumber(record.width),
    height: finiteNumber(record.height),
    thumbnailContentType: clean(record.thumbnailContentType),
    thumbnailByteSize: finiteNumber(record.thumbnailByteSize),
    thumbnailWidth: finiteNumber(record.thumbnailWidth),
    thumbnailHeight: finiteNumber(record.thumbnailHeight),
    sourceContentType: clean(record.sourceContentType),
    sourceByteSize: finiteNumber(record.sourceByteSize),
    sourceWidth: finiteNumber(record.sourceWidth),
    sourceHeight: finiteNumber(record.sourceHeight),
    ...(record.crop && typeof record.crop === "object" ? { crop: { ...record.crop } } : {}),
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  };
}

export async function uploadPreparedTripImage(recordInput, {
  user: userInput = null,
  onProgress = null,
  resume = false
} = {}) {
  assertCloudOperationAvailable("旅程相片背景同步");
  const record = { ...(recordInput || {}) };
  const tripId = clean(record.tripId);
  const mediaId = clean(record.mediaId || record.imageId);
  if (!tripId || !mediaId) throw errorWithCode("Invalid local media record", "invalid-media-record");
  const owner = normalizeOwner(record.ownerType, record.ownerId, record.slot);
  const user = await requireUser(userInput);
  const displayPath = clean(record.storagePath);
  const thumbnailPath = clean(record.thumbnailStoragePath);
  if (!displayPath || !thumbnailPath || !displayPath.startsWith(`trips/${tripId}/media/`) || !thumbnailPath.startsWith(`trips/${tripId}/media/`)) {
    throw errorWithCode("Invalid local media paths", "invalid-media-record");
  }
  const [displayCache, thumbnailCache] = await Promise.all([
    getTripMediaCache(displayPath),
    getTripMediaCache(thumbnailPath)
  ]);
  if (!(displayCache?.blob instanceof Blob) || !(thumbnailCache?.blob instanceof Blob)) {
    throw errorWithCode("Pending media bytes are no longer available on this device", "media-local-cache-missing");
  }

  invalidateBackupRegistrySnapshot(tripId);
  const registryRef = doc(db, "trips", tripId, "media", mediaId);
  let existing = null;
  if (resume) {
    try {
      const snapshot = await getDoc(registryRef);
      if (snapshot.exists()) existing = registryRecordFromSnapshot(snapshot);
    } catch (error) {}
  }
  if (existing?.status === "ready" && clean(existing.storagePath) === displayPath && clean(existing.thumbnailStoragePath) === thumbnailPath) {
    return { ...record, ...existing, status: "ready" };
  }

  const pendingRecord = cloudPendingRecordFromLocal(record, user);
  if (existing) {
    const { createdAt, createdBy, ...resumeFields } = pendingRecord;
    await setDoc(registryRef, resumeFields, { merge: true });
  } else {
    await setDoc(registryRef, pendingRecord);
  }

  const commonMetadata = {
    cacheControl: "private,max-age=31536000,immutable",
    customMetadata: {
      tripId,
      mediaId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      slot: owner.slot,
      uploadedBy: user.uid,
      mediaSchemaVersion: String(TRIP_MEDIA_SCHEMA_VERSION)
    }
  };
  const progress = combinedUploadProgress(onProgress, {
    displayBytes: displayCache.blob.size,
    thumbnailBytes: thumbnailCache.blob.size
  });
  const [displayMetadata, thumbnailMetadata] = await Promise.all([
    uploadBlob(displayPath, displayCache.blob, {
      ...commonMetadata,
      contentType: clean(record.contentType || displayCache.blob.type),
      customMetadata: { ...commonMetadata.customMetadata, variant: "display" }
    }, info => progress("display", info)),
    uploadBlob(thumbnailPath, thumbnailCache.blob, {
      ...commonMetadata,
      contentType: clean(record.thumbnailContentType || thumbnailCache.blob.type),
      customMetadata: { ...commonMetadata.customMetadata, variant: "thumbnail" }
    }, info => progress("thumbnail", info))
  ]);

  const readyFields = {
    status: "ready",
    generation: clean(displayMetadata.generation),
    md5Hash: clean(displayMetadata.md5Hash),
    thumbnailGeneration: clean(thumbnailMetadata.generation),
    thumbnailMd5Hash: clean(thumbnailMetadata.md5Hash),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  };
  if (typeof onProgress === "function") onProgress({ stage: "registry-ready", progress: 0.90, mediaId });
  await setDoc(registryRef, readyFields, { merge: true });
  await Promise.all([
    putTripMediaCache(displayPath, displayCache.blob, { generation: readyFields.generation, contentType: record.contentType, tripId, mediaId, variant: "display" }),
    putTripMediaCache(thumbnailPath, thumbnailCache.blob, { generation: readyFields.thumbnailGeneration, contentType: record.thumbnailContentType, tripId, mediaId, variant: "thumbnail" })
  ]);
  if (typeof onProgress === "function") onProgress({ stage: "ready", progress: 1, mediaId });
  return { ...record, ...readyFields, status: "ready" };
}

export async function uploadTripImage({
  tripId: tripIdInput,
  ownerType: ownerTypeInput,
  ownerId: ownerIdInput = "",
  slot: slotInput = "",
  file,
  mediaId: mediaIdInput = "",
  caption = "",
  sortOrder = 0,
  user: userInput = null,
  onProgress = null
} = {}) {
  assertCloudOperationAvailable("旅程相片上載");
  const tripId = clean(tripIdInput);
  if (!tripId) throw errorWithCode("Missing tripId", "invalid-trip-id");
  const owner = normalizeOwner(ownerTypeInput, ownerIdInput, slotInput);
  const user = await requireUser(userInput);
  const mediaId = safeSegment(mediaIdInput || nowMediaId(), nowMediaId());
  const variants = await prepareTripImageVariants(file, mediaUploadProfile(owner, slotInput));
  const folder = folderForOwner(owner, mediaId);
  const displayPath = `trips/${tripId}/media/${folder}/display.${extensionForMime(variants.display.contentType)}`;
  const thumbnailPath = `trips/${tripId}/media/${folder}/thumb.${extensionForMime(variants.thumbnail.contentType)}`;
  const uploadedPaths = [displayPath, thumbnailPath];
  invalidateBackupRegistrySnapshot(tripId);
  const registryRef = doc(db, "trips", tripId, "media", mediaId);
  let registryCreated = false;

  const commonMetadata = {
    cacheControl: "private,max-age=31536000,immutable",
    customMetadata: {
      tripId,
      mediaId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      slot: owner.slot,
      uploadedBy: user.uid,
      mediaSchemaVersion: String(TRIP_MEDIA_SCHEMA_VERSION)
    }
  };

  const pendingRecord = {
    mediaSchemaVersion: TRIP_MEDIA_SCHEMA_VERSION,
    mediaId,
    tripId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    slot: owner.slot,
    status: "uploading",
    caption: clean(caption),
    sortOrder: finiteNumber(sortOrder),
    storagePath: displayPath,
    thumbnailStoragePath: thumbnailPath,
    contentType: variants.display.contentType,
    byteSize: variants.display.blob.size,
    width: variants.display.width,
    height: variants.display.height,
    thumbnailContentType: variants.thumbnail.contentType,
    thumbnailByteSize: variants.thumbnail.blob.size,
    thumbnailWidth: variants.thumbnail.width,
    thumbnailHeight: variants.thumbnail.height,
    sourceContentType: variants.source.contentType,
    sourceByteSize: variants.source.byteSize,
    sourceWidth: variants.source.width,
    sourceHeight: variants.source.height,
    createdBy: user.uid,
    createdAt: serverTimestamp(),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  };

  try {
    if (typeof onProgress === "function") onProgress({ stage: "registry-pending", progress: 0.08, mediaId });
    await setDoc(registryRef, pendingRecord);
    registryCreated = true;

    const uploadProgress = combinedUploadProgress(onProgress, {
      start: 0.10,
      end: 0.86,
      displayBytes: variants.display.blob.size,
      thumbnailBytes: variants.thumbnail.blob.size
    });
    const [displayMetadata, thumbnailMetadata] = await Promise.all([
      uploadBlob(displayPath, variants.display.blob, {
        ...commonMetadata,
        contentType: variants.display.contentType,
        customMetadata: { ...commonMetadata.customMetadata, variant: "display" }
      }, info => uploadProgress("display", info)),
      uploadBlob(thumbnailPath, variants.thumbnail.blob, {
        ...commonMetadata,
        contentType: variants.thumbnail.contentType,
        customMetadata: { ...commonMetadata.customMetadata, variant: "thumbnail" }
      }, info => uploadProgress("thumbnail", info))
    ]);

    const readyFields = {
      status: "ready",
      generation: clean(displayMetadata.generation),
      md5Hash: clean(displayMetadata.md5Hash),
      thumbnailGeneration: clean(thumbnailMetadata.generation),
      thumbnailMd5Hash: clean(thumbnailMetadata.md5Hash),
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    };

    if (typeof onProgress === "function") onProgress({ stage: "registry-ready", progress: 0.90, mediaId });
    await setDoc(registryRef, readyFields, { merge: true });
    const record = { ...pendingRecord, ...readyFields, status: "ready" };
    await Promise.all([
      putTripMediaCache(displayPath, variants.display.blob, {
        generation: readyFields.generation,
        contentType: pendingRecord.contentType,
        tripId,
        mediaId,
        variant: "display"
      }),
      putTripMediaCache(thumbnailPath, variants.thumbnail.blob, {
        generation: readyFields.thumbnailGeneration,
        contentType: pendingRecord.thumbnailContentType,
        tripId,
        mediaId,
        variant: "thumbnail"
      })
    ]);
    if (typeof onProgress === "function") onProgress({ stage: "ready", progress: 1, mediaId });
    return record;
  } catch (error) {
    await Promise.allSettled(uploadedPaths.map(bestEffortDelete));
    if (registryCreated) {
      try { await deleteDoc(registryRef); } catch (registryError) {
        console.warn("Stale uploading media registry retained for later repair", mediaId, registryError);
      }
    }
    throw error;
  }
}


export async function restoreTripMediaRecord(recordInput, {
  displayBlob,
  thumbnailBlob = null,
  user: userInput = null,
  onProgress = null
} = {}) {
  assertCloudOperationAvailable("旅程相片還原");
  const record = { ...(recordInput || {}) };
  const tripId = clean(record.tripId);
  const mediaId = clean(record.mediaId);
  const owner = normalizeOwner(record.ownerType, record.ownerId, record.slot);
  const displayPath = clean(record.storagePath);
  const thumbnailPath = clean(record.thumbnailStoragePath);
  if (!tripId || !mediaId || !displayPath || !displayPath.startsWith(`trips/${tripId}/media/`)) {
    throw errorWithCode("Invalid media restore record", "invalid-media-record");
  }
  if (!(displayBlob instanceof Blob) || displayBlob.size <= 0 || displayBlob.size > TRIP_MEDIA_LIMITS.storageObjectMaxBytes || !clean(displayBlob.type).startsWith("image/")) {
    throw errorWithCode("Invalid display media blob", "invalid-media-file");
  }
  if (thumbnailPath && (!(thumbnailBlob instanceof Blob) || thumbnailBlob.size <= 0 || thumbnailBlob.size > TRIP_MEDIA_LIMITS.storageObjectMaxBytes || !clean(thumbnailBlob.type).startsWith("image/"))) {
    throw errorWithCode("Invalid thumbnail media blob", "invalid-media-file");
  }
  if (thumbnailBlob && !thumbnailPath) {
    throw errorWithCode("Thumbnail Storage path is missing", "invalid-media-record");
  }
  if (thumbnailPath && !thumbnailPath.startsWith(`trips/${tripId}/media/`)) {
    throw errorWithCode("Invalid thumbnail Storage path", "invalid-media-record");
  }

  const user = await requireUser(userInput);
  invalidateBackupRegistrySnapshot(tripId);
  const registryRef = doc(db, "trips", tripId, "media", mediaId);
  const existingSnap = await getDoc(registryRef);
  const existing = existingSnap.exists() ? existingSnap.data() || {} : null;
  const commonMetadata = {
    cacheControl: "private,max-age=31536000,immutable",
    customMetadata: {
      tripId,
      mediaId,
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      slot: owner.slot,
      uploadedBy: user.uid,
      restoredFromBackup: "true",
      mediaSchemaVersion: String(TRIP_MEDIA_SCHEMA_VERSION)
    }
  };

  const pending = {
    mediaSchemaVersion: Math.max(1, finiteNumber(record.mediaSchemaVersion, TRIP_MEDIA_SCHEMA_VERSION)),
    mediaId,
    tripId,
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    slot: owner.slot,
    status: "uploading",
    caption: clean(record.caption),
    sortOrder: finiteNumber(record.sortOrder),
    storagePath: displayPath,
    thumbnailStoragePath: thumbnailPath,
    contentType: clean(record.contentType || displayBlob.type),
    byteSize: finiteNumber(record.byteSize || displayBlob.size),
    width: finiteNumber(record.width),
    height: finiteNumber(record.height),
    thumbnailContentType: clean(record.thumbnailContentType || thumbnailBlob?.type),
    thumbnailByteSize: finiteNumber(record.thumbnailByteSize || thumbnailBlob?.size),
    thumbnailWidth: finiteNumber(record.thumbnailWidth),
    thumbnailHeight: finiteNumber(record.thumbnailHeight),
    sourceContentType: clean(record.sourceContentType),
    sourceByteSize: finiteNumber(record.sourceByteSize),
    sourceWidth: finiteNumber(record.sourceWidth),
    sourceHeight: finiteNumber(record.sourceHeight),
    createdBy: existing ? clean(existing.createdBy || user.uid) : user.uid,
    createdAt: existing?.createdAt || serverTimestamp(),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  };
  await setDoc(registryRef, pending, { merge: false });
  try {
    if (typeof onProgress === "function") onProgress({ stage: "media-restore-display", progress: 0.12, mediaId });
    const restoreProgress = combinedUploadProgress(onProgress, {
      start: 0.12,
      end: 0.84,
      displayBytes: displayBlob.size,
      thumbnailBytes: thumbnailBlob?.size || 0
    });
    const displayPromise = uploadBlob(displayPath, displayBlob, {
      ...commonMetadata,
      contentType: clean(record.contentType || displayBlob.type),
      customMetadata: { ...commonMetadata.customMetadata, variant: "display" }
    }, info => restoreProgress("display", info));
    const thumbnailPromise = thumbnailBlob && thumbnailPath
      ? uploadBlob(thumbnailPath, thumbnailBlob, {
          ...commonMetadata,
          contentType: clean(record.thumbnailContentType || thumbnailBlob.type),
          customMetadata: { ...commonMetadata.customMetadata, variant: "thumbnail" }
        }, info => restoreProgress("thumbnail", info))
      : Promise.resolve(null);
    const [displayMetadata, thumbnailMetadata] = await Promise.all([displayPromise, thumbnailPromise]);
    const ready = {
      status: "ready",
      generation: clean(displayMetadata.generation),
      md5Hash: clean(displayMetadata.md5Hash),
      thumbnailGeneration: clean(thumbnailMetadata?.generation),
      thumbnailMd5Hash: clean(thumbnailMetadata?.md5Hash),
      restoredBy: user.uid,
      restoredAt: serverTimestamp(),
      updatedBy: user.uid,
      updatedAt: serverTimestamp()
    };
    await setDoc(registryRef, ready, { merge: true });
    const output = { ...pending, ...ready, status: "ready" };
    await Promise.all([
      putTripMediaCache(displayPath, displayBlob, { generation: ready.generation, contentType: pending.contentType, tripId, mediaId, variant: "display" }),
      thumbnailBlob && thumbnailPath
        ? putTripMediaCache(thumbnailPath, thumbnailBlob, { generation: ready.thumbnailGeneration, contentType: pending.thumbnailContentType, tripId, mediaId, variant: "thumbnail" })
        : Promise.resolve(false)
    ]);
    if (typeof onProgress === "function") onProgress({ stage: "media-restore-ready", progress: 1, mediaId });
    return output;
  } catch (error) {
    if (!existing) {
      await Promise.allSettled([bestEffortDelete(displayPath), thumbnailPath ? bestEffortDelete(thumbnailPath) : Promise.resolve()]);
      try { await deleteDoc(registryRef); } catch (registryError) {}
    } else {
      try { await setDoc(registryRef, existing, { merge: false }); } catch (registryError) {}
    }
    throw error;
  }
}

export async function getTripMediaRecord(tripIdInput, mediaIdInput) {
  const tripId = clean(tripIdInput);
  const mediaId = clean(mediaIdInput);
  if (!tripId || !mediaId) return null;
  const snapshot = await getDoc(doc(db, "trips", tripId, "media", mediaId));
  return snapshot.exists() ? registryRecordFromSnapshot(snapshot) : null;
}

export async function listTripMediaRecords(tripIdInput) {
  const tripId = clean(tripIdInput);
  if (!tripId) return [];
  const snapshot = await getDocs(collection(db, "trips", tripId, "media"));
  const records = sortedRegistryRecords(snapshot);
  if (snapshot?.metadata?.fromCache !== true) rememberBackupRegistrySnapshot(tripId, records);
  return records;
}

export async function listTripMediaRecordsForBackup(tripIdInput, {
  timeoutMs = 12000,
  signal = null,
  maxCachedAgeMs = BACKUP_REGISTRY_SNAPSHOT_MAX_AGE_MS,
  allowLastConfirmedFallback = true,
  maxFallbackAgeMs = 5 * 60 * 1000
} = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) return { records: [], source: "empty", serverConfirmedAt: 0, stale: false };
  throwIfAborted(signal, "media-registry");

  const fresh = readFreshBackupRegistrySnapshot(tripId, maxCachedAgeMs);
  if (fresh) {
    return { records: fresh.records, source: "session-server-confirmed", serverConfirmedAt: fresh.serverConfirmedAt, stale: false };
  }
  const prior = backupRegistrySnapshots.get(tripId) || null;
  const reference = collection(db, "trips", tripId, "media");

  return await new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer = null;
    let abortHandler = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      try { unsubscribe(); } catch (error) {}
      callback(value);
    };
    const fallbackOrReject = error => {
      const priorAge = prior ? Date.now() - finiteNumber(prior.serverConfirmedAt) : Number.POSITIVE_INFINITY;
      if (allowLastConfirmedFallback && prior?.records && priorAge <= Math.max(1000, finiteNumber(maxFallbackAgeMs, 5 * 60 * 1000))) {
        finish(resolve, {
          records: prior.records.map(record => ({ ...record })),
          source: "last-server-confirmed",
          serverConfirmedAt: finiteNumber(prior.serverConfirmedAt),
          stale: true,
          fallbackReason: clean(error?.code || error?.message)
        });
        return;
      }
      finish(reject, error);
    };

    timer = setTimeout(() => fallbackOrReject(timeoutError("media-registry", timeoutMs)), Math.max(1000, finiteNumber(timeoutMs, 12000)));
    if (signal) {
      abortHandler = () => finish(reject, abortError("media-registry"));
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    try {
      unsubscribe = onSnapshot(reference, { includeMetadataChanges: true }, snapshot => {
        if (snapshot?.metadata?.fromCache === true || snapshot?.metadata?.hasPendingWrites === true) return;
        const records = sortedRegistryRecords(snapshot);
        rememberBackupRegistrySnapshot(tripId, records);
        finish(resolve, { records, source: "server", serverConfirmedAt: Date.now(), stale: false });
      }, error => fallbackOrReject(error));
    } catch (error) {
      fallbackOrReject(error);
    }
  });
}

function mediaVariant(record, variantInput) {
  const variant = clean(variantInput) === "thumbnail" ? "thumbnail" : "display";
  if (variant === "thumbnail") {
    return {
      variant,
      storagePath: clean(record?.thumbnailStoragePath || record?.storagePath),
      generation: clean(record?.thumbnailGeneration || record?.generation),
      contentType: clean(record?.thumbnailContentType || record?.contentType),
      byteSize: finiteNumber(record?.thumbnailByteSize || record?.byteSize)
    };
  }
  return {
    variant,
    storagePath: clean(record?.storagePath),
    generation: clean(record?.generation),
    contentType: clean(record?.contentType),
    byteSize: finiteNumber(record?.byteSize)
  };
}

export async function getTripMediaBlob(record, {
  variant = "display",
  useCache = true,
  signal = null,
  cacheTimeoutMs = 1800,
  downloadTimeoutMs = 20000
} = {}) {
  const selected = mediaVariant(record || {}, variant);
  if (!selected.storagePath) throw errorWithCode("Missing media storage path", "invalid-media-record");
  throwIfAborted(signal, "media-download");
  if (useCache) {
    const cached = await awaitWithTimeout(
      getTripMediaCache(selected.storagePath, { generation: selected.generation }),
      { timeoutMs: cacheTimeoutMs, signal, stage: "media-cache", fallbackOnTimeout: null }
    ).catch(error => {
      if (error?.code === "operation-aborted") throw error;
      console.warn("Trip media cache read skipped", selected.storagePath, error);
      return null;
    });
    if (cached?.blob) return { ...selected, blob: cached.blob, fromCache: true };
  }
  const blob = await awaitWithTimeout(
    getBlob(ref(storage, selected.storagePath), TRIP_MEDIA_LIMITS.downloadMaxBytes),
    { timeoutMs: downloadTimeoutMs, signal, stage: "media-download" }
  );
  throwIfAborted(signal, "media-download");
  if (useCache) {
    // Cache writes are best-effort. Never keep a user-facing media read waiting
    // on IndexedDB after the authoritative Storage bytes have arrived.
    void putTripMediaCache(selected.storagePath, blob, {
      generation: selected.generation,
      contentType: selected.contentType || blob.type,
      tripId: clean(record?.tripId),
      mediaId: clean(record?.mediaId),
      variant: selected.variant
    }).catch(() => {});
  }
  return { ...selected, blob, fromCache: false };
}

export async function verifyTripMediaRecord(record) {
  const displayPath = clean(record?.storagePath);
  const thumbnailPath = clean(record?.thumbnailStoragePath);
  if (!displayPath) return { verified: false, display: null, thumbnail: null, reason: "missing-storage-path" };
  const [display, thumbnail] = await Promise.all([
    getMetadata(ref(storage, displayPath)).catch(error => storageNotFound(error) ? null : Promise.reject(error)),
    thumbnailPath
      ? getMetadata(ref(storage, thumbnailPath)).catch(error => storageNotFound(error) ? null : Promise.reject(error))
      : Promise.resolve(null)
  ]);
  return {
    verified: Boolean(display && (!thumbnailPath || thumbnail)),
    display,
    thumbnail,
    reason: display ? (thumbnailPath && !thumbnail ? "thumbnail-missing" : "") : "display-missing"
  };
}

export async function deleteTripMedia(record, { user: userInput = null } = {}) {
  assertCloudOperationAvailable("旅程相片刪除");
  const tripId = clean(record?.tripId);
  const mediaId = clean(record?.mediaId);
  if (!tripId || !mediaId) throw errorWithCode("Invalid media record", "invalid-media-record");
  await requireUser(userInput);
  const paths = [...new Set([
    clean(record?.storagePath),
    clean(record?.thumbnailStoragePath)
  ].filter(Boolean))];

  for (const path of paths) {
    try {
      await deleteObject(ref(storage, path));
    } catch (error) {
      if (!storageNotFound(error)) throw error;
    }
    await removeTripMediaCache(path);
  }
  await deleteDoc(doc(db, "trips", tripId, "media", mediaId));
  invalidateBackupRegistrySnapshot(tripId);
  return { tripId, mediaId, deleted: true };
}

export async function cleanupStaleTripMediaUploads(tripIdInput, {
  user: userInput = null,
  olderThanMs = 30 * 60 * 1000
} = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) return { tripId: "", inspected: 0, cleaned: 0, failed: [] };
  const user = await requireUser(userInput);
  const records = await listTripMediaRecords(tripId);
  const threshold = Date.now() - Math.max(5 * 60 * 1000, finiteNumber(olderThanMs, 30 * 60 * 1000));
  const stale = records.filter(record => {
    if (clean(record?.status) !== "uploading") return false;
    const createdAt = typeof record?.createdAt?.toMillis === "function"
      ? record.createdAt.toMillis()
      : finiteNumber(record?.createdAt?.seconds) * 1000;
    return createdAt > 0 && createdAt <= threshold;
  });
  let cleaned = 0;
  const failed = [];
  for (const record of stale) {
    try {
      await deleteTripMedia(record, { user });
      cleaned += 1;
    } catch (error) {
      failed.push({ mediaId: clean(record?.mediaId), code: clean(error?.code), message: clean(error?.message) });
    }
  }
  return { tripId, inspected: stale.length, cleaned, failed };
}

export async function clearCachedTripMedia(tripIdInput) {
  return clearTripMediaCache({ tripId: clean(tripIdInput) });
}

export function tripMediaStoragePrefix(tripIdInput) {
  const tripId = clean(tripIdInput);
  return tripId ? `trips/${tripId}/media/` : "";
}
