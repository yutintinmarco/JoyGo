/*
 * v7.9.1.0 · Phase 3A.2 Existing Media Integration
 *
 * Read-path bridge between the existing Travel WebApp renderers and the
 * Phase 3A Storage foundation. Existing static/remote media remains valid.
 * Storage-backed descriptors are resolved to short-lived Blob URLs via the
 * IndexedDB media cache without changing the existing UI grammar.
 */

import { getTripMediaBlob } from "./trip-media-service.js";

const objectUrls = new Map();
const inflight = new Map();
let bindToken = 0;
const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeTripMediaDescriptor(input, { tripId = "", sortOrder = 0 } = {}) {
  if (!input) return null;
  if (typeof input === "string") {
    const src = clean(input);
    if (!src) return null;
    return {
      source: src.startsWith("assets/") ? "static" : "remote",
      src,
      tripId: clean(tripId),
      sortOrder: finiteNumber(sortOrder)
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const storagePath = clean(input.storagePath);
  const src = clean(input.src || input.url || input.path);
  if (!storagePath && !src) return null;
  const descriptor = {
    ...input,
    tripId: clean(input.tripId || tripId),
    mediaId: clean(input.mediaId || input.imageId || input.id),
    source: clean(input.source) || (storagePath ? "storage" : (src.startsWith("assets/") ? "static" : "remote")),
    src,
    storagePath,
    thumbnailStoragePath: clean(input.thumbnailStoragePath),
    generation: clean(input.generation),
    thumbnailGeneration: clean(input.thumbnailGeneration),
    contentType: clean(input.contentType),
    thumbnailContentType: clean(input.thumbnailContentType),
    sortOrder: finiteNumber(input.sortOrder, sortOrder)
  };
  return descriptor;
}

export function mediaDescriptorFromRecord(record = {}) {
  return normalizeTripMediaDescriptor({
    ...record,
    source: "storage",
    imageId: clean(record.imageId || record.mediaId),
    mediaId: clean(record.mediaId || record.imageId)
  }, { tripId: clean(record.tripId), sortOrder: finiteNumber(record.sortOrder) });
}

function selectedVariant(descriptor, variantInput) {
  const variant = clean(variantInput) === "thumbnail" ? "thumbnail" : "display";
  if (variant === "thumbnail") {
    return {
      variant,
      storagePath: clean(descriptor.thumbnailStoragePath || descriptor.storagePath),
      generation: clean(descriptor.thumbnailGeneration || descriptor.generation)
    };
  }
  return {
    variant,
    storagePath: clean(descriptor.storagePath),
    generation: clean(descriptor.generation)
  };
}

function objectUrlKey(descriptor, variantInput) {
  const selected = selectedVariant(descriptor, variantInput);
  return `${selected.variant}|${selected.storagePath}|${selected.generation}`;
}

// Local-first uploads deliberately use the final immutable Storage path before
// Firebase assigns an object generation. When the same media later becomes
// canonical, generation changes from empty -> server value but the bytes and
// Storage path are identical. Reuse the already-visible Object URL instead of
// treating that metadata promotion as a new image load. This keeps the local
// preview on screen through queued -> uploaded -> attached handoff.
function compatibleObjectUrl(descriptor, variantInput) {
  const selected = selectedVariant(descriptor, variantInput);
  const mediaId = clean(descriptor?.mediaId);
  const tripId = clean(descriptor?.tripId);
  if (!selected.storagePath || !mediaId) return null;
  for (const record of objectUrls.values()) {
    if (clean(record.variant) !== selected.variant) continue;
    if (clean(record.storagePath) !== selected.storagePath) continue;
    if (clean(record.mediaId) !== mediaId) continue;
    if (tripId && clean(record.tripId) && clean(record.tripId) !== tripId) continue;
    return record;
  }
  return null;
}

export function invalidateTripMediaObjectUrl(input, {
  tripId = "",
  variant = "display",
  revoke = true
} = {}) {
  const descriptor = normalizeTripMediaDescriptor(input, { tripId });
  if (!descriptor?.storagePath) return 0;
  const selected = selectedVariant(descriptor, variant);
  const wantedMediaId = clean(descriptor.mediaId);
  const wantedTripId = clean(descriptor.tripId || tripId);
  const urlsToRevoke = new Set();
  let removed = 0;
  [...objectUrls.entries()].forEach(([key, record]) => {
    if (clean(record.variant) !== selected.variant) return;
    if (clean(record.storagePath) !== selected.storagePath) return;
    if (wantedMediaId && clean(record.mediaId) && clean(record.mediaId) !== wantedMediaId) return;
    if (wantedTripId && clean(record.tripId) && clean(record.tripId) !== wantedTripId) return;
    if (record.url) urlsToRevoke.add(record.url);
    objectUrls.delete(key);
    removed += 1;
  });
  if (revoke) urlsToRevoke.forEach(url => { try { URL.revokeObjectURL(url); } catch (error) {} });
  return removed;
}

export async function resolveTripMediaUrl(input, {
  tripId = "",
  variant = "display",
  useCache = true
} = {}) {
  const descriptor = normalizeTripMediaDescriptor(input, { tripId });
  if (!descriptor) return "";
  if (!descriptor.storagePath) return descriptor.src;

  const key = objectUrlKey(descriptor, variant);
  if (objectUrls.has(key)) return objectUrls.get(key).url;
  const compatible = compatibleObjectUrl(descriptor, variant);
  if (compatible?.url) {
    objectUrls.set(key, compatible);
    return compatible.url;
  }
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    const result = await getTripMediaBlob(descriptor, { variant, useCache });
    const url = URL.createObjectURL(result.blob);
    objectUrls.set(key, {
      url,
      tripId: clean(descriptor.tripId || tripId),
      mediaId: clean(descriptor.mediaId),
      storagePath: clean(result.storagePath),
      variant: clean(result.variant || selectedVariant(descriptor, variant).variant)
    });
    return url;
  })();
  inflight.set(key, task);
  try { return await task; }
  finally { inflight.delete(key); }
}

export function bindTripMediaImage(img, input, {
  tripId = "",
  variant = "display",
  fallbackSrc = ""
} = {}) {
  if (!(img instanceof HTMLImageElement)) return () => {};
  const descriptor = normalizeTripMediaDescriptor(input, { tripId });
  const token = String(++bindToken);
  img.dataset.tripMediaBindToken = token;
  const fallback = clean(fallbackSrc || descriptor?.src);
  if (fallback) img.src = fallback;
  else if (descriptor?.storagePath && !clean(img.getAttribute("src"))) img.src = TRANSPARENT_PIXEL;
  if (!descriptor?.storagePath) return () => {};

  let disposed = false;
  let retryTimer = 0;
  let retryCount = 0;
  let appliedUrl = "";
  const maxRetries = 2;

  const stillCurrent = () => !disposed && img.dataset.tripMediaBindToken === token;
  const scheduleRetry = (delay = 180, { invalidate = false } = {}) => {
    if (!stillCurrent() || retryCount >= maxRetries) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = 0;
      if (!stillCurrent()) return;
      retryCount += 1;
      if (invalidate) invalidateTripMediaObjectUrl(descriptor, { tripId, variant, revoke: true });
      resolve();
    }, Math.max(60, delay));
  };
  const resolve = () => {
    if (!stillCurrent()) return;
    resolveTripMediaUrl(descriptor, { tripId, variant }).then(url => {
      if (!url || !stillCurrent()) return;
      appliedUrl = url;
      img.src = url;
      img.dataset.tripMediaResolved = "true";
    }).catch(error => {
      if (!stillCurrent()) return;
      img.dataset.tripMediaResolved = "false";
      console.warn("Trip media image resolve", error);
      scheduleRetry(260 * (retryCount + 1), { invalidate: retryCount > 0 });
    });
  };
  const onImageError = () => {
    if (!stillCurrent()) return;
    const current = clean(img.currentSrc || img.src);
    // A stale Blob URL can survive in a continuity cache even after Safari has
    // invalidated the underlying resource. Rebuild the URL from IndexedDB first
    // instead of leaving the image permanently broken until page refresh.
    if (current && (current === appliedUrl || current.startsWith("blob:"))) {
      img.dataset.tripMediaResolved = "false";
      invalidateTripMediaObjectUrl(descriptor, { tripId, variant, revoke: true });
      if (fallback && fallback !== current) img.src = fallback;
      else img.src = TRANSPARENT_PIXEL;
      scheduleRetry(90, { invalidate: false });
    }
  };
  img.addEventListener("error", onImageError);
  resolve();
  return () => {
    disposed = true;
    if (retryTimer) clearTimeout(retryTimer);
    img.removeEventListener("error", onImageError);
    if (img.dataset.tripMediaBindToken === token) delete img.dataset.tripMediaBindToken;
  };
}

export async function resolveTripMediaCssUrl(input, options = {}) {
  return resolveTripMediaUrl(input, { ...options, variant: options.variant || "display" });
}

export function releaseTripMediaObjectUrls({ tripId = "", keepStoragePaths = [] } = {}) {
  const wantedTripId = clean(tripId);
  const keep = new Set((Array.isArray(keepStoragePaths) ? keepStoragePaths : []).map(clean).filter(Boolean));
  let released = 0;
  [...objectUrls.entries()].forEach(([key, record]) => {
    if (wantedTripId && clean(record.tripId) !== wantedTripId) return;
    if (keep.has(clean(record.storagePath))) return;
    try { URL.revokeObjectURL(record.url); } catch (error) {}
    objectUrls.delete(key);
    released += 1;
  });
  return released;
}

export function releaseAllTripMediaObjectUrls() {
  let released = 0;
  [...objectUrls.values()].forEach(record => {
    try { URL.revokeObjectURL(record.url); } catch (error) {}
    released += 1;
  });
  objectUrls.clear();
  return released;
}
