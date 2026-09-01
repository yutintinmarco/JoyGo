/*
 * v7.9.2.2 · Phase 3A.3 Backup Export Escape Hatch / Main-thread Hardening
 *
 * Standard ZIP container using STORE entries (media is already compressed).
 * Package contract:
 *   manifest.json
 *   trip-data.json
 *   media/<mediaId>/display.<ext>
 *   media/<mediaId>/thumbnail.<ext>
 *
 * The embedded trip-data.json remains the existing travel-full-backup v1 data
 * contract. Package v1 adds verified media bytes without base64-in-JSON.
 */

import {
  deleteTripMedia,
  getTripMediaBlob,
  listTripMediaRecords,
  listTripMediaRecordsForBackup,
  restoreTripMediaRecord
} from "./trip-media-service.js";
import {
  deleteTripDocuments,
  getTripDocumentBlob,
  reconcileTripDocumentStorage,
  restoreTripDocumentRecord
} from "./trip-document-service.js";

export const FULL_BACKUP_PACKAGE_FORMAT = "travel-full-backup-package";
export const FULL_BACKUP_PACKAGE_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_STORE_METHOD = 0;
const MAX_PACKAGE_ENTRIES = 4096;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;

function clean(value) { return String(value ?? "").trim(); }
function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function safeArray(value) { return Array.isArray(value) ? value : []; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function errorWithCode(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}
function abortError(stage = "backup-package") {
  return errorWithCode(`${stage} cancelled`, "operation-aborted", { stage });
}
function throwIfAborted(signal, stage = "backup-package") {
  if (signal?.aborted) throw abortError(stage);
}
async function yieldToMainThread(signal, stage = "backup-package") {
  throwIfAborted(signal, stage);
  await new Promise(resolve => setTimeout(resolve, 0));
  throwIfAborted(signal, stage);
}
function extensionForMime(typeInput) {
  const type = clean(typeInput).toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/gif") return "gif";
  if (type === "image/heic") return "heic";
  if (type === "image/heif") return "heif";
  if (type === "application/pdf") return "pdf";
  return "bin";
}
function safeFileSegment(valueInput, fallback = "media") {
  const value = clean(valueInput).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return value || fallback;
}
function dosDateTime(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = Math.max(1, date.getMonth() + 1);
  const day = Math.max(1, date.getDate());
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
async function crc32Async(bytes, { signal = null, chunkBytes = 1024 * 1024 } = {}) {
  let crc = 0xffffffff;
  const chunk = Math.max(128 * 1024, finiteNumber(chunkBytes, 1024 * 1024));
  for (let start = 0; start < bytes.length; start += chunk) {
    throwIfAborted(signal, "zip-crc");
    const end = Math.min(bytes.length, start + chunk);
    for (let i = start; i < end; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    if (end < bytes.length) await yieldToMainThread(signal, "zip-crc");
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function sha256HexBytes(bytesInput) {
  if (!globalThis.crypto?.subtle) throw errorWithCode("SHA-256 is unavailable in this browser", "backup-integrity-unavailable");
  const bytes = bytesInput instanceof Uint8Array ? bytesInput : new Uint8Array(bytesInput);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function blobBytes(blob) {
  if (!(blob instanceof Blob)) throw errorWithCode("Backup package file is invalid", "backup-package-invalid-file");
  return new Uint8Array(await blob.arrayBuffer());
}
function writeUint16(view, offset, value) { view.setUint16(offset, value, true); }
function writeUint32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

async function normalizeZipEntry(entry, { signal = null } = {}) {
  const name = clean(entry?.name).replace(/^\/+/, "");
  if (!name || name.includes("../") || name.startsWith("../")) throw errorWithCode("Unsafe backup package path", "backup-package-path-invalid", { path: name });
  const nameBytes = encoder.encode(name);
  if (nameBytes.length > 65535) throw errorWithCode("Backup package path is too long", "backup-package-path-invalid", { path: name });

  // iOS PWA memory guard: keep exactly one byte representation per ZIP entry.
  // v7.9.2.0 converted Blob -> ArrayBuffer for CRC/SHA and then retained the
  // original Blob as well, so a second immediate export could overlap with the
  // first download handoff and push WebKit over its process memory budget.
  let bytes;
  let contentType = clean(entry?.contentType);
  if (entry?.bytes instanceof Uint8Array) {
    bytes = entry.bytes;
  } else if (entry?.bytes instanceof ArrayBuffer) {
    bytes = new Uint8Array(entry.bytes);
  } else if (entry?.blob instanceof Blob) {
    bytes = await blobBytes(entry.blob);
    if (!contentType) contentType = clean(entry.blob.type);
  } else if (typeof entry?.data === "string") {
    bytes = encoder.encode(entry.data);
  } else if (entry?.data instanceof Uint8Array) {
    bytes = entry.data;
  } else if (entry?.data instanceof ArrayBuffer) {
    bytes = new Uint8Array(entry.data);
  } else {
    bytes = encoder.encode(String(entry?.data ?? ""));
  }
  throwIfAborted(signal, "zip-entry");
  const hash = clean(entry?.sha256) || await sha256HexBytes(bytes);
  return {
    name,
    nameBytes,
    bytes,
    size: bytes.byteLength,
    crc: await crc32Async(bytes, { signal }),
    sha256: hash,
    contentType: contentType || "application/octet-stream"
  };
}

async function createStoreZip(entriesInput, { signal = null, onProgress = null } = {}) {
  const entries = [];
  const rawEntries = safeArray(entriesInput);
  for (let index = 0; index < rawEntries.length; index += 1) {
    throwIfAborted(signal, "zip-entry");
    if (typeof onProgress === "function") onProgress({ stage: "zip-entry", completed: index, total: rawEntries.length });
    entries.push(await normalizeZipEntry(rawEntries[index], { signal }));
    await yieldToMainThread(signal, "zip-entry");
  }
  if (!entries.length || entries.length > MAX_PACKAGE_ENTRIES) throw errorWithCode("Backup package entry count is invalid", "backup-package-invalid");
  let totalBytes = 0;
  entries.forEach(entry => { totalBytes += entry.size; });
  if (totalBytes > MAX_PACKAGE_BYTES) throw errorWithCode("Backup package is too large for this browser", "backup-package-too-large", { totalBytes });

  const now = dosDateTime();
  const parts = [];
  const central = [];
  let offset = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    throwIfAborted(signal, "zip-build");
    if (typeof onProgress === "function") onProgress({ stage: "zip-build", completed: index, total: entries.length });
    const local = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(local.buffer);
    writeUint32(view, 0, ZIP_LOCAL_SIGNATURE);
    writeUint16(view, 4, 20);
    writeUint16(view, 6, 0x0800); // UTF-8 names
    writeUint16(view, 8, ZIP_STORE_METHOD);
    writeUint16(view, 10, now.time);
    writeUint16(view, 12, now.date);
    writeUint32(view, 14, entry.crc);
    writeUint32(view, 18, entry.size);
    writeUint32(view, 22, entry.size);
    writeUint16(view, 26, entry.nameBytes.length);
    writeUint16(view, 28, 0);
    local.set(entry.nameBytes, 30);
    parts.push(local, entry.bytes);

    const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, ZIP_CENTRAL_SIGNATURE);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, ZIP_STORE_METHOD);
    writeUint16(centralView, 12, now.time);
    writeUint16(centralView, 14, now.date);
    writeUint32(centralView, 16, entry.crc);
    writeUint32(centralView, 20, entry.size);
    writeUint32(centralView, 24, entry.size);
    writeUint16(centralView, 28, entry.nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(entry.nameBytes, 46);
    central.push(centralHeader);
    offset += local.byteLength + entry.size;
    await yieldToMainThread(signal, "zip-build");
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, item) => sum + item.byteLength, 0);
  parts.push(...central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, ZIP_END_SIGNATURE);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, centralOffset);
  writeUint16(endView, 20, 0);
  parts.push(end);
  if (typeof onProgress === "function") onProgress({ stage: "zip-build", completed: entries.length, total: entries.length });
  throwIfAborted(signal, "zip-build");
  return new Blob(parts, { type: "application/zip" });
}

async function parseStoreZip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_PACKAGE_BYTES) throw errorWithCode("Backup ZIP is invalid or too large", "backup-package-invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map();
  let offset = 0;
  let count = 0;
  while (offset + 4 <= bytes.byteLength) {
    const signature = view.getUint32(offset, true);
    if (signature === ZIP_CENTRAL_SIGNATURE || signature === ZIP_END_SIGNATURE) break;
    if (signature !== ZIP_LOCAL_SIGNATURE || offset + 30 > bytes.byteLength) throw errorWithCode("Backup ZIP structure is invalid", "backup-package-invalid");
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const expectedCrc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if ((flags & 0x0008) !== 0 || method !== ZIP_STORE_METHOD || compressedSize !== uncompressedSize) {
      throw errorWithCode("This Backup ZIP uses an unsupported compression format", "backup-package-compression-unsupported");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.byteLength) throw errorWithCode("Backup ZIP entry is truncated", "backup-package-invalid");
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (!name || name.includes("../") || name.startsWith("/")) throw errorWithCode("Unsafe Backup ZIP path", "backup-package-path-invalid", { path: name });
    const content = bytes.subarray(dataStart, dataEnd);
    if (crc32(content) !== expectedCrc) throw errorWithCode("Backup ZIP CRC verification failed", "backup-package-integrity-mismatch", { path: name });
    files.set(name, content);
    count += 1;
    if (count > MAX_PACKAGE_ENTRIES) throw errorWithCode("Backup ZIP has too many files", "backup-package-invalid");
    offset = dataEnd;
  }
  return files;
}


function collectCanonicalMediaReferences(backupJsonInput, tripIdInput) {
  const tripId = clean(tripIdInput);
  const portable = backupJsonInput?.data?.portableTrip;
  const references = new Map();
  if (!tripId || !portable || typeof portable !== "object") return references;
  const prefix = `trips/${tripId}/media/`;

  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;

    const storagePath = clean(value.storagePath);
    const thumbnailStoragePath = clean(value.thumbnailStoragePath);
    const mediaId = clean(value.mediaId || value.imageId);
    const looksLikeStorageMedia = storagePath.startsWith(prefix) || thumbnailStoragePath.startsWith(prefix) || clean(value.source) === "storage";
    if (looksLikeStorageMedia) {
      if (!mediaId || !storagePath || !storagePath.startsWith(prefix)) {
        throw errorWithCode("Canonical Trip data contains an invalid media reference", "backup-media-reference-invalid", { mediaId, storagePath });
      }
      const existing = references.get(mediaId);
      if (existing && clean(existing.storagePath) !== storagePath) {
        throw errorWithCode("Canonical Trip data contains conflicting media references", "backup-media-reference-conflict", { mediaId, storagePath, existingStoragePath: clean(existing.storagePath) });
      }
      references.set(mediaId, {
        mediaId,
        storagePath,
        thumbnailStoragePath,
        ownerType: clean(value.ownerType),
        ownerId: clean(value.ownerId),
        slot: clean(value.slot)
      });
      return;
    }

    Object.values(value).forEach(visit);
  };

  visit(portable);
  return references;
}

function canonicalBackupRegistryRecords(recordsInput, references, tripId) {
  const allRecords = safeArray(recordsInput);
  if (!(references instanceof Map) || references.size === 0) {
    return { records: [], referencedCount: 0, orphanReadyCount: allRecords.filter(record => clean(record?.status) === "ready").length };
  }
  const registryById = new Map(allRecords.map(record => [clean(record?.mediaId), record]));
  const selected = [];
  for (const reference of references.values()) {
    const record = registryById.get(reference.mediaId);
    if (!record || clean(record.status) !== "ready") {
      throw errorWithCode("Canonical Trip media is not ready in the Media Registry", "backup-media-reference-missing", { mediaId: reference.mediaId, storagePath: reference.storagePath });
    }
    if (clean(record.storagePath) !== reference.storagePath) {
      throw errorWithCode("Canonical Trip media path does not match the Media Registry", "backup-media-reference-mismatch", { mediaId: reference.mediaId, storagePath: reference.storagePath, registryStoragePath: clean(record.storagePath) });
    }
    if (reference.thumbnailStoragePath && clean(record.thumbnailStoragePath) !== reference.thumbnailStoragePath) {
      throw errorWithCode("Canonical Trip thumbnail path does not match the Media Registry", "backup-media-reference-mismatch", { mediaId: reference.mediaId, thumbnailStoragePath: reference.thumbnailStoragePath, registryThumbnailStoragePath: clean(record.thumbnailStoragePath) });
    }
    selected.push(record);
  }
  const referencedIds = new Set(references.keys());
  const orphanReadyCount = allRecords.filter(record => clean(record?.status) === "ready" && !referencedIds.has(clean(record?.mediaId))).length;
  return { records: selected, referencedCount: selected.length, orphanReadyCount };
}

function portableMediaRecord(record = {}) {
  return {
    mediaSchemaVersion: Math.max(1, finiteNumber(record.mediaSchemaVersion, 1)),
    mediaId: clean(record.mediaId),
    tripId: clean(record.tripId),
    ownerType: clean(record.ownerType),
    ownerId: clean(record.ownerId),
    slot: clean(record.slot),
    status: "ready",
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
    sourceHeight: finiteNumber(record.sourceHeight)
  };
}

export async function collectTripMediaForBackup(tripIdInput, { backupJson = null, onProgress = null, signal = null, registryTimeoutMs = 12000, mediaTimeoutMs = 20000 } = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) throw errorWithCode("Missing tripId", "invalid-trip-id");
  throwIfAborted(signal, "media-registry");
  if (typeof onProgress === "function") onProgress({ stage: "registry-read", completed: 0, total: 0 });
  const registry = await listTripMediaRecordsForBackup(tripId, { timeoutMs: registryTimeoutMs, signal, allowLastConfirmedFallback: true });
  const references = backupJson ? collectCanonicalMediaReferences(backupJson, tripId) : null;
  const selection = references
    ? canonicalBackupRegistryRecords(registry.records, references, tripId)
    : { records: safeArray(registry.records).filter(record => clean(record.status) === "ready"), referencedCount: 0, orphanReadyCount: 0 };
  const records = selection.records;
  if (typeof onProgress === "function") onProgress({ stage: "registry-ready", completed: 0, total: records.length, source: clean(registry.source), stale: registry.stale === true, referencedCount: selection.referencedCount, orphanReadyCount: selection.orphanReadyCount });
  const collected = [];
  let totalBytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = portableMediaRecord(records[index]);
    if (!record.mediaId || !record.storagePath || !record.storagePath.startsWith(`trips/${tripId}/media/`)) {
      throw errorWithCode("Media registry contains an invalid Storage path", "backup-media-invalid", { mediaId: record.mediaId });
    }
    if (typeof onProgress === "function") onProgress({ stage: "media-download", completed: index, total: records.length, mediaId: record.mediaId });
    throwIfAborted(signal, "media-download");
    const display = await getTripMediaBlob(record, { variant: "display", useCache: true, signal, downloadTimeoutMs: mediaTimeoutMs });
    const thumbnail = record.thumbnailStoragePath
      ? await getTripMediaBlob(record, { variant: "thumbnail", useCache: true, signal, downloadTimeoutMs: mediaTimeoutMs })
      : null;
    throwIfAborted(signal, "media-package");
    const displayBytes = await blobBytes(display.blob);
    const thumbnailBytes = thumbnail ? await blobBytes(thumbnail.blob) : null;
    const base = `media/${safeFileSegment(record.mediaId)}`;
    const displayPackagePath = `${base}/display.${extensionForMime(record.contentType || display.blob.type)}`;
    const thumbnailPackagePath = thumbnail
      ? `${base}/thumbnail.${extensionForMime(record.thumbnailContentType || thumbnail.blob.type)}`
      : "";
    const displaySha256 = await sha256HexBytes(displayBytes);
    const thumbnailSha256 = thumbnailBytes ? await sha256HexBytes(thumbnailBytes) : "";
    totalBytes += displayBytes.byteLength + (thumbnailBytes?.byteLength || 0);
    collected.push({
      record,
      // Retain the bytes already read for SHA instead of keeping the Blob and
      // reading the same media a second time while ZIP headers are built.
      display: { bytes: displayBytes, packagePath: displayPackagePath, sha256: displaySha256, byteSize: displayBytes.byteLength, contentType: clean(record.contentType || display.blob.type) },
      thumbnail: thumbnailBytes ? { bytes: thumbnailBytes, packagePath: thumbnailPackagePath, sha256: thumbnailSha256, byteSize: thumbnailBytes.byteLength, contentType: clean(record.thumbnailContentType || thumbnail.blob.type) } : null
    });
    if (typeof onProgress === "function") onProgress({ stage: "media-download", completed: index + 1, total: records.length, mediaId: record.mediaId });
    await yieldToMainThread(signal, "media-package");
  }
  if (typeof onProgress === "function") onProgress({ stage: "media-download", completed: records.length, total: records.length });
  return {
    tripId,
    records: collected,
    mediaCount: collected.length,
    totalBytes,
    registrySource: clean(registry.source),
    registryStale: registry.stale === true,
    referencedMediaCount: selection.referencedCount || collected.length,
    orphanReadyCount: selection.orphanReadyCount || 0
  };
}

export function mediaManifestFromCollected(collectedInput) {
  return safeArray(collectedInput?.records).map(item => ({
    ...clone(item.record),
    generation: "",
    thumbnailGeneration: "",
    packageFiles: {
      display: {
        path: clean(item.display?.packagePath),
        sha256: clean(item.display?.sha256),
        byteSize: finiteNumber(item.display?.byteSize),
        contentType: clean(item.display?.contentType)
      },
      thumbnail: item.thumbnail ? {
        path: clean(item.thumbnail.packagePath),
        sha256: clean(item.thumbnail.sha256),
        byteSize: finiteNumber(item.thumbnail.byteSize),
        contentType: clean(item.thumbnail.contentType)
      } : null
    }
  }));
}


function backupDocumentRecords(backupJsonInput, tripIdInput = "") {
  const tripId = clean(tripIdInput || backupJsonInput?.tripId);
  const rows = safeArray(backupJsonInput?.data?.portableTrip?.meta?.bookingDocuments);
  return rows.filter(row => clean(row?.documentId) && clean(row?.storagePath).startsWith(`trips/${tripId}/documents/`));
}

export async function collectTripDocumentsForBackup(tripIdInput, { backupJson = null, onProgress = null, signal = null } = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) throw errorWithCode("Missing tripId", "invalid-trip-id");
  const records = backupDocumentRecords(backupJson || {}, tripId);
  const collected = [];
  let totalBytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    throwIfAborted(signal, "document-download");
    const record = clone(records[index]) || {};
    if (typeof onProgress === "function") onProgress({ stage: "document-download", completed: index, total: records.length, documentId: clean(record.documentId) });
    const blob = await getTripDocumentBlob(record);
    const bytes = await blobBytes(blob);
    const path = `documents/${safeFileSegment(record.documentId, "document")}/${safeFileSegment(record.fileName || `document.${extensionForMime(record.contentType || blob.type)}`, "document")}`;
    const sha256 = await sha256HexBytes(bytes);
    totalBytes += bytes.byteLength;
    collected.push({
      record: { ...record, tripId, contentType: clean(record.contentType || blob.type), byteSize: bytes.byteLength },
      file: { bytes, packagePath: path, sha256, byteSize: bytes.byteLength, contentType: clean(record.contentType || blob.type) }
    });
    if (typeof onProgress === "function") onProgress({ stage: "document-download", completed: index + 1, total: records.length, documentId: clean(record.documentId) });
    await yieldToMainThread(signal, "document-package");
  }
  return { tripId, records: collected, documentCount: collected.length, totalBytes };
}

export function documentManifestFromCollected(collectedInput) {
  return safeArray(collectedInput?.records).map(item => ({
    ...clone(item.record),
    packageFile: {
      path: clean(item.file?.packagePath),
      sha256: clean(item.file?.sha256),
      byteSize: finiteNumber(item.file?.byteSize),
      contentType: clean(item.file?.contentType)
    }
  }));
}

export async function buildFullBackupPackage(backupJsonInput, collectedInput, { filename = "travel-full-backup.zip", onProgress = null, signal = null } = {}) {
  // Read-only during packaging; avoid cloning a potentially large Full Backup
  // object just before JSON.stringify, which doubled peak memory on iOS.
  throwIfAborted(signal, "backup-json");
  const backupJson = backupJsonInput || {};
  const backupText = JSON.stringify(backupJson, null, 2);
  const backupBytes = encoder.encode(backupText);
  const backupSha256 = await sha256HexBytes(backupBytes);
  const collected = safeArray(collectedInput?.records);
  const documentCollected = safeArray(collectedInput?.documentRecords);
  const mediaFiles = [];
  const documentFiles = [];
  const entries = [];
  for (const item of collected) {
    for (const variant of [item.display, item.thumbnail].filter(Boolean)) {
      mediaFiles.push({
        mediaId: clean(item.record?.mediaId),
        variant: variant === item.display ? "display" : "thumbnail",
        path: clean(variant.packagePath),
        sha256: clean(variant.sha256),
        byteSize: finiteNumber(variant.byteSize),
        contentType: clean(variant.contentType)
      });
      entries.push({ name: variant.packagePath, bytes: variant.bytes, sha256: variant.sha256, contentType: variant.contentType });
    }
  }

  for (const item of documentCollected) {
    const file = item?.file;
    if (!file?.bytes || !clean(file.packagePath)) continue;
    documentFiles.push({
      documentId: clean(item.record?.documentId),
      path: clean(file.packagePath),
      sha256: clean(file.sha256),
      byteSize: finiteNumber(file.byteSize),
      contentType: clean(file.contentType)
    });
    entries.push({ name: file.packagePath, bytes: file.bytes, sha256: file.sha256, contentType: file.contentType });
  }
  const manifest = {
    packageFormat: FULL_BACKUP_PACKAGE_FORMAT,
    packageVersion: FULL_BACKUP_PACKAGE_VERSION,
    tripId: clean(backupJson.tripId),
    createdAt: new Date().toISOString(),
    backupFile: "trip-data.json",
    backupSha256,
    mediaCount: collected.length,
    mediaFileCount: mediaFiles.length,
    mediaBytes: mediaFiles.reduce((sum, item) => sum + finiteNumber(item.byteSize), 0),
    documentCount: documentCollected.length,
    documentFileCount: documentFiles.length,
    documentBytes: documentFiles.reduce((sum, item) => sum + finiteNumber(item.byteSize), 0),
    orphanReadySkipped: Math.max(0, finiteNumber(collectedInput?.orphanReadyCount)),
    mediaFiles,
    documentFiles
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  if (typeof onProgress === "function") onProgress({ stage: "zip-start", completed: 0, total: entries.length + 2 });
  const zip = await createStoreZip([
    { name: "manifest.json", data: manifestText, contentType: "application/json" },
    { name: "trip-data.json", data: backupText, sha256: backupSha256, contentType: "application/json" },
    ...entries
  ], { signal, onProgress });
  return { blob: zip, filename, manifest, backupJson };
}

export async function parseFullBackupFile(file) {
  if (!(file instanceof Blob)) throw errorWithCode("Backup file is invalid", "backup-invalid");
  const name = clean(file.name).toLowerCase();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = name.endsWith(".zip") || (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b);
  if (!isZip) {
    let raw;
    try { raw = JSON.parse(await file.text()); }
    catch (error) { throw errorWithCode("Backup JSON is invalid", "backup-invalid-json"); }
    return { raw, package: null, kind: "json", filename: clean(file.name) };
  }

  const files = await parseStoreZip(file);
  const manifestBytes = files.get("manifest.json");
  const backupBytes = files.get("trip-data.json");
  if (!manifestBytes || !backupBytes) throw errorWithCode("Backup package is missing manifest.json or trip-data.json", "backup-package-invalid");
  let manifest;
  let raw;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
    raw = JSON.parse(decoder.decode(backupBytes));
  } catch (error) {
    throw errorWithCode("Backup package JSON is invalid", "backup-package-invalid-json");
  }
  if (clean(manifest.packageFormat) !== FULL_BACKUP_PACKAGE_FORMAT || finiteNumber(manifest.packageVersion) !== FULL_BACKUP_PACKAGE_VERSION) {
    throw errorWithCode("Unsupported Backup package format", "backup-package-unsupported", { packageFormat: clean(manifest.packageFormat), packageVersion: finiteNumber(manifest.packageVersion) });
  }
  const backupHash = await sha256HexBytes(backupBytes);
  if (backupHash !== clean(manifest.backupSha256).toLowerCase()) throw errorWithCode("Backup package data integrity verification failed", "backup-package-integrity-mismatch", { path: "trip-data.json" });
  for (const item of safeArray(manifest.mediaFiles)) {
    const path = clean(item.path);
    const bytes = files.get(path);
    if (!path || !bytes) throw errorWithCode("Backup package media file is missing", "backup-package-media-missing", { path });
    if (bytes.byteLength !== finiteNumber(item.byteSize)) throw errorWithCode("Backup package media size verification failed", "backup-package-integrity-mismatch", { path });
    const hash = await sha256HexBytes(bytes);
    if (hash !== clean(item.sha256).toLowerCase()) throw errorWithCode("Backup package media integrity verification failed", "backup-package-integrity-mismatch", { path });
  }
  for (const item of safeArray(manifest.documentFiles)) {
    const path = clean(item.path);
    const bytes = files.get(path);
    if (!path || !bytes) throw errorWithCode("Backup package document file is missing", "backup-package-document-missing", { path });
    if (bytes.byteLength !== finiteNumber(item.byteSize)) throw errorWithCode("Backup package document size verification failed", "backup-package-integrity-mismatch", { path });
    const hash = await sha256HexBytes(bytes);
    if (hash !== clean(item.sha256).toLowerCase()) throw errorWithCode("Backup package document integrity verification failed", "backup-package-integrity-mismatch", { path });
  }
  return { raw, package: { manifest, files }, kind: "package", filename: clean(file.name) };
}

function mediaManifestRecords(backupJson) {
  return safeArray(backupJson?.mediaManifest).filter(record => clean(record?.mediaId) && clean(record?.storagePath));
}

export async function restoreFullBackupPackageMedia(backupJsonInput, packageInput, {
  user = null,
  onProgress = null,
  reconcile = true
} = {}) {
  const backupJson = clone(backupJsonInput) || {};
  const tripId = clean(backupJson.tripId);
  if (!tripId) throw errorWithCode("Backup Trip ID is missing", "backup-invalid");
  const packageFiles = packageInput?.files instanceof Map ? packageInput.files : null;
  if (!packageFiles) {
    if (backupJson.mediaIncluded === true && mediaManifestRecords(backupJson).length) throw errorWithCode("Media Backup package is required", "backup-package-required");
    return { tripId, restored: 0, removed: 0, mediaRecords: [] };
  }
  const targetRecords = mediaManifestRecords(backupJson);
  const currentRecords = await listTripMediaRecords(tripId);
  const currentById = new Map(currentRecords.map(record => [clean(record.mediaId), record]));
  const restoredRecords = [];
  const createdIds = [];
  try {
    for (let index = 0; index < targetRecords.length; index += 1) {
      const record = targetRecords[index];
      const displayInfo = record?.packageFiles?.display || null;
      const thumbInfo = record?.packageFiles?.thumbnail || null;
      const displayBytes = packageFiles.get(clean(displayInfo?.path));
      const thumbnailBytes = thumbInfo ? packageFiles.get(clean(thumbInfo.path)) : null;
      if (!displayBytes) throw errorWithCode("Backup media display file is missing", "backup-package-media-missing", { mediaId: record.mediaId });
      if (thumbInfo && !thumbnailBytes) throw errorWithCode("Backup media thumbnail file is missing", "backup-package-media-missing", { mediaId: record.mediaId });
      if (typeof onProgress === "function") onProgress({ stage: "media-restore", completed: index, total: targetRecords.length, mediaId: record.mediaId });
      const restored = await restoreTripMediaRecord(record, {
        displayBlob: new Blob([displayBytes], { type: clean(displayInfo?.contentType || record.contentType || "image/webp") }),
        thumbnailBlob: thumbnailBytes ? new Blob([thumbnailBytes], { type: clean(thumbInfo?.contentType || record.thumbnailContentType || "image/webp") }) : null,
        user
      });
      restoredRecords.push(restored);
      if (!currentById.has(clean(record.mediaId))) createdIds.push(clean(record.mediaId));
    }
  } catch (error) {
    for (const mediaId of createdIds.reverse()) {
      const record = restoredRecords.find(item => clean(item.mediaId) === mediaId);
      if (!record) continue;
      try { await deleteTripMedia(record, { user }); } catch (cleanupError) { console.warn("Unable to rollback restored media", mediaId, cleanupError); }
    }
    throw error;
  }

  let removed = 0;
  if (reconcile) {
    const wanted = new Set(targetRecords.map(record => clean(record.mediaId)));
    for (const current of currentRecords) {
      if (wanted.has(clean(current.mediaId))) continue;
      await deleteTripMedia(current, { user });
      removed += 1;
    }
  }
  if (typeof onProgress === "function") onProgress({ stage: "media-restore", completed: targetRecords.length, total: targetRecords.length });
  return { tripId, restored: restoredRecords.length, removed, mediaRecords: restoredRecords };
}


function documentManifestRecords(backupJson) {
  return safeArray(backupJson?.documentManifest).filter(record => clean(record?.documentId) && clean(record?.storagePath));
}

export async function restoreFullBackupPackageDocuments(backupJsonInput, packageInput, {
  user = null,
  onProgress = null,
  reconcile = true
} = {}) {
  const backupJson = clone(backupJsonInput) || {};
  const tripId = clean(backupJson.tripId);
  if (!tripId) throw errorWithCode("Backup Trip ID is missing", "backup-invalid");
  const packageFiles = packageInput?.files instanceof Map ? packageInput.files : null;
  const targetRecords = documentManifestRecords(backupJson);
  if (!packageFiles) {
    if (backupJson.documentIncluded === true && targetRecords.length) throw errorWithCode("Booking Document Backup package is required", "backup-package-required");
    return { tripId, restored: 0, removed: 0, documentRecords: [] };
  }
  const restored = [];
  const created = [];
  try {
    for (let index = 0; index < targetRecords.length; index += 1) {
      const record = targetRecords[index];
      const info = record?.packageFile || null;
      const bytes = packageFiles.get(clean(info?.path));
      if (!bytes) throw errorWithCode("Backup document file is missing", "backup-package-document-missing", { documentId: clean(record.documentId) });
      if (typeof onProgress === "function") onProgress({ stage: "document-restore", completed: index, total: targetRecords.length, documentId: clean(record.documentId) });
      const row = await restoreTripDocumentRecord(record, new Blob([bytes], { type: clean(info?.contentType || record.contentType || "application/octet-stream") }), { tripId, user });
      restored.push(row); created.push(row);
    }
  } catch (error) {
    try { await deleteTripDocuments({ descriptors: created, user }); } catch (_) {}
    throw error;
  }
  let removed = 0;
  if (reconcile) {
    const result = await reconcileTripDocumentStorage({ tripId, wantedPaths: restored.map(row => clean(row.storagePath)), user });
    removed = finiteNumber(result?.removed);
  }
  if (typeof onProgress === "function") onProgress({ stage: "document-restore", completed: targetRecords.length, total: targetRecords.length });
  return { tripId, restored: restored.length, removed, documentRecords: restored };
}
