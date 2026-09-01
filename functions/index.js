"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

initializeApp();

const db = getFirestore();
const DELETE_REGION = "asia-east2";
const MAP_LINK_REGION = "asia-east2";
const DELETE_SCHEMA_VERSION = 1;
const OPERATION_TTL_MS = 12 * 60 * 1000;
const DELETE_LEASE_MS = 11 * 60 * 1000;
const STORAGE_PREFIX = tripId => `trips/${tripId}/`;
const KNOWN_TOP_LEVEL = new Set([
  "trips",
  "users",
  "tripInvites",
  "tripIds",
  "appAdmins",
  "authorizedTripCreators"
]);

function clean(value) {
  return String(value ?? "").trim();
}

function millis(value) {
  try {
    if (typeof value?.toMillis === "function") return Number(value.toMillis()) || 0;
    if (value?.seconds != null) return Number(value.seconds) * 1000;
  } catch (error) {}
  return 0;
}

function notFoundStorage(error) {
  const code = Number(error?.code || error?.statusCode || 0);
  return code === 404 || String(error?.message || "").toLowerCase().includes("not found");
}

async function deleteQueryRecursively(query) {
  const snapshot = await query.get();
  if (snapshot.empty) return 0;
  let count = 0;
  for (const docSnap of snapshot.docs) {
    await db.recursiveDelete(docSnap.ref);
    count += 1;
  }
  return count;
}

async function deleteTripChildrenPreservingMembers(tripRef) {
  const collections = await tripRef.listCollections();
  const deleted = [];
  let membersRef = null;
  for (const collectionRef of collections) {
    if (collectionRef.id === "members") {
      membersRef = collectionRef;
      continue;
    }
    await db.recursiveDelete(collectionRef);
    deleted.push(collectionRef.id);
  }
  return { deleted, membersRef };
}

async function deleteMembersLast(tripRef, membersRefInput = null) {
  const membersRef = membersRefInput || tripRef.collection("members");
  const probe = await membersRef.limit(1).get();
  if (probe.empty) return false;
  await db.recursiveDelete(membersRef);
  return true;
}

async function deleteKnownCrossReferences(tripId) {
  const report = { invites: 0, preferences: 0, genericTopLevel: 0, registry: false };

  report.invites = await deleteQueryRecursively(
    db.collection("tripInvites").where("tripId", "==", tripId)
  );

  report.preferences = await deleteQueryRecursively(
    db.collectionGroup("tripPreferences").where("tripId", "==", tripId)
  );

  const topLevelCollections = await db.listCollections();
  for (const collectionRef of topLevelCollections) {
    if (KNOWN_TOP_LEVEL.has(collectionRef.id)) continue;
    try {
      const matches = await collectionRef.where("tripId", "==", tripId).get();
      for (const docSnap of matches.docs) {
        await db.recursiveDelete(docSnap.ref);
        report.genericTopLevel += 1;
      }
    } catch (error) {
      // A future collection that explicitly disables indexing for tripId must be
      // registered in this cleanup contract instead of being silently ignored.
      logger.error("Generic Trip cross-reference cleanup failed", {
        tripId,
        collection: collectionRef.id,
        code: error?.code,
        message: error?.message
      });
      throw error;
    }
  }

  const registryRef = db.collection("tripIds").doc(tripId);
  if ((await registryRef.get()).exists) {
    await registryRef.delete();
    report.registry = true;
  }

  return report;
}

async function cleanupTripStorage(tripId) {
  const prefix = STORAGE_PREFIX(tripId);
  try {
    const bucket = getStorage().bucket();
    await bucket.deleteFiles({ prefix, force: true });
    const [remaining] = await bucket.getFiles({ prefix, maxResults: 1, autoPaginate: false });
    if (remaining.length) {
      const error = new Error("Trip media remains after Storage cleanup");
      error.code = "storage-verification-failed";
      throw error;
    }
    return { status: "verified-empty", prefix };
  } catch (error) {
    if (notFoundStorage(error)) {
      // Phase 3A may not have provisioned Storage yet. A missing bucket cannot
      // contain Trip media and is therefore equivalent to an empty prefix.
      return { status: "bucket-not-provisioned", prefix };
    }
    throw error;
  }
}

async function verifyNoTripChildren(tripRef) {
  const collections = await tripRef.listCollections();
  const remaining = [];
  for (const collectionRef of collections) {
    const snapshot = await collectionRef.limit(1).get();
    if (!snapshot.empty) remaining.push(collectionRef.id);
  }
  return remaining;
}

async function verifyCrossReferences(tripId) {
  const [inviteSnap, prefSnap, registrySnap] = await Promise.all([
    db.collection("tripInvites").where("tripId", "==", tripId).limit(1).get(),
    db.collectionGroup("tripPreferences").where("tripId", "==", tripId).limit(1).get(),
    db.collection("tripIds").doc(tripId).get()
  ]);

  const generic = [];
  const topLevelCollections = await db.listCollections();
  for (const collectionRef of topLevelCollections) {
    if (KNOWN_TOP_LEVEL.has(collectionRef.id)) continue;
    const snapshot = await collectionRef.where("tripId", "==", tripId).limit(1).get();
    if (!snapshot.empty) generic.push(collectionRef.id);
  }

  return {
    invites: inviteSnap.size,
    preferences: prefSnap.size,
    registryExists: registrySnap.exists,
    genericTopLevel: generic
  };
}

async function verifyStorageEmpty(tripId) {
  const prefix = STORAGE_PREFIX(tripId);
  try {
    const bucket = getStorage().bucket();
    const [remaining] = await bucket.getFiles({ prefix, maxResults: 1, autoPaginate: false });
    return { empty: remaining.length === 0, status: remaining.length ? "objects-remain" : "verified-empty", prefix };
  } catch (error) {
    if (notFoundStorage(error)) return { empty: true, status: "bucket-not-provisioned", prefix };
    throw error;
  }
}

async function verifyCleanupBeforeRootDelete(tripId, tripRef) {
  const [childCollections, crossReferences, storage] = await Promise.all([
    verifyNoTripChildren(tripRef),
    verifyCrossReferences(tripId),
    verifyStorageEmpty(tripId)
  ]);

  const cleanState = childCollections.length === 0
    && crossReferences.invites === 0
    && crossReferences.preferences === 0
    && crossReferences.registryExists === false
    && crossReferences.genericTopLevel.length === 0
    && storage.empty === true;

  return { clean: cleanState, childCollections, crossReferences, storage };
}

async function claimDeletion(tripId, uid, tripRef) {
  const now = Date.now();
  return db.runTransaction(async tx => {
    const tripSnap = await tx.get(tripRef);
    if (!tripSnap.exists) return { missing: true, resumed: false, runId: "" };
    const trip = tripSnap.data() || {};

    if (trip.deletionState === "deleting") {
      if (clean(trip.deletionRequestedBy) !== uid) {
        throw new HttpsError("permission-denied", "Only the Owner who started deletion may resume it.");
      }
      const leaseExpiresAtMs = Number(trip.deletionLeaseExpiresAtMs) || 0;
      if (leaseExpiresAtMs > now) {
        throw new HttpsError("failed-precondition", "Permanent deletion is already running on another request.", {
          code: "delete-already-running",
          retryAfterMs: Math.max(1000, leaseExpiresAtMs - now)
        });
      }
      const runId = `delete_${now}_${Math.random().toString(36).slice(2, 9)}`;
      tx.set(tripRef, {
        deletionRunId: runId,
        deletionLastAttemptAt: FieldValue.serverTimestamp(),
        deletionLeaseExpiresAtMs: now + DELETE_LEASE_MS
      }, { merge: true });
      return { missing: false, resumed: true, runId };
    }

    const memberRef = tripRef.collection("members").doc(uid);
    const opRef = tripRef.collection("operations").doc("current");
    const memberSnap = await tx.get(memberRef);
    const opSnap = await tx.get(opRef);
    if (!memberSnap.exists || clean(memberSnap.data()?.role) !== "owner") {
      throw new HttpsError("permission-denied", "Only the Trip Owner may permanently delete this Trip.");
    }
    if (opSnap.exists) {
      const data = opSnap.data() || {};
      const started = millis(data.startedAt) || Number(data.startedAtMs) || 0;
      const stale = !started || now - started > OPERATION_TTL_MS;
      if (!stale) {
        throw new HttpsError("failed-precondition", "Another Import or Restore operation is still active.", {
          code: "trip-operation-busy",
          operationType: clean(data.type)
        });
      }
      tx.delete(opRef);
    }

    const runId = `delete_${now}_${Math.random().toString(36).slice(2, 9)}`;
    tx.set(tripRef, {
      deletionState: "deleting",
      deletionRunId: runId,
      deletionSchemaVersion: DELETE_SCHEMA_VERSION,
      deletionRequestedBy: uid,
      deletionRequestedAt: trip.deletionRequestedAt || FieldValue.serverTimestamp(),
      deletionLastAttemptAt: FieldValue.serverTimestamp(),
      deletionLeaseExpiresAtMs: now + DELETE_LEASE_MS
    }, { merge: true });
    return { missing: false, resumed: false, runId };
  });
}

async function expireDeletionLease(tripRef, runId, errorCode = "") {
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(tripRef);
      if (!snap.exists) return;
      const data = snap.data() || {};
      if (clean(data.deletionRunId) !== clean(runId)) return;
      tx.set(tripRef, {
        deletionLeaseExpiresAtMs: 0,
        deletionLastError: clean(errorCode || "unknown"),
        deletionLastAttemptAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });
  } catch (leaseError) {}
}


const GOOGLE_MAPS_SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);
const GOOGLE_MAPS_REDIRECT_HOSTS = new Set([
  "google.com", "www.google.com", "maps.google.com",
  "google.co.jp", "www.google.co.jp", "maps.google.co.jp",
  "google.com.hk", "www.google.com.hk", "maps.google.com.hk"
]);
const GOOGLE_MAPS_REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function normalizedHost(value) {
  return clean(value).toLowerCase().replace(/\.$/, "");
}

function parseGoogleMapsRedirectUrl(value, { initial = false } = {}) {
  let url;
  try { url = new URL(clean(value)); }
  catch (error) { throw new HttpsError("invalid-argument", "Invalid Google Maps URL."); }
  const host = normalizedHost(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new HttpsError("invalid-argument", "Only secure Google Maps URLs are supported.");
  }
  if (initial ? !GOOGLE_MAPS_SHORT_HOSTS.has(host) : !(GOOGLE_MAPS_SHORT_HOSTS.has(host) || GOOGLE_MAPS_REDIRECT_HOSTS.has(host))) {
    throw new HttpsError("invalid-argument", "Unsupported Google Maps URL host.");
  }
  return url;
}

function finalGoogleMapsUrlAllowed(url) {
  const host = normalizedHost(url?.hostname);
  if (!GOOGLE_MAPS_REDIRECT_HOSTS.has(host)) return false;
  if (host.startsWith("maps.")) return true;
  return String(url?.pathname || "").startsWith("/maps");
}

async function followGoogleMapsShortLink(inputUrl) {
  let current = parseGoogleMapsRedirectUrl(inputUrl, { initial: true });
  const maxRedirects = 6;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "TravelWebApp/1.0 (+Google Maps short-link resolver)",
          "accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
        }
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new HttpsError("deadline-exceeded", "Google Maps short link timed out.", { code: "maps-short-link-timeout" });
      }
      throw new HttpsError("unavailable", "Google Maps short link could not be opened.", { code: "maps-short-link-unavailable" });
    } finally {
      clearTimeout(timer);
    }

    if (GOOGLE_MAPS_REDIRECT_CODES.has(Number(response.status))) {
      const location = clean(response.headers.get("location"));
      try { await response.body?.cancel?.(); } catch (error) {}
      if (!location) {
        throw new HttpsError("failed-precondition", "Google Maps redirect did not include a destination.", { code: "maps-short-link-invalid-redirect" });
      }
      const next = new URL(location, current);
      parseGoogleMapsRedirectUrl(next.toString());
      current = next;
      continue;
    }

    try { await response.body?.cancel?.(); } catch (error) {}
    if (response.ok && finalGoogleMapsUrlAllowed(current)) {
      return { url: current.toString(), redirectCount: hop };
    }
    throw new HttpsError("failed-precondition", "Google Maps short link did not resolve to a supported Maps page.", {
      code: "maps-short-link-unresolved",
      status: Number(response.status) || 0
    });
  }
  throw new HttpsError("failed-precondition", "Google Maps short link redirected too many times.", { code: "maps-short-link-too-many-redirects" });
}

exports.resolveGoogleMapsShortLink = onCall({
  region: MAP_LINK_REGION,
  timeoutSeconds: 20,
  memory: "256MiB",
  maxInstances: 4
}, async request => {
  const uid = clean(request.auth?.uid);
  if (!uid) throw new HttpsError("unauthenticated", "Google sign-in required.");

  const inputUrl = clean(request.data?.url);
  if (!inputUrl || inputUrl.length > 1200) {
    throw new HttpsError("invalid-argument", "Invalid Google Maps short link.");
  }

  const result = await followGoogleMapsShortLink(inputUrl);
  logger.info("Google Maps short link resolved", { uid, redirectCount: result.redirectCount });
  return { url: result.url, redirectCount: result.redirectCount };
});

exports.permanentDeleteTrip = onCall({
  region: DELETE_REGION,
  timeoutSeconds: 540,
  memory: "512MiB",
  maxInstances: 4
}, async request => {
  const uid = clean(request.auth?.uid);
  if (!uid) throw new HttpsError("unauthenticated", "Google sign-in required.");

  const tripId = clean(request.data?.tripId);
  if (!tripId || tripId.includes("/") || tripId.length > 160) {
    throw new HttpsError("invalid-argument", "Invalid Trip ID.");
  }

  const tripRef = db.collection("trips").doc(tripId);
  const claim = await claimDeletion(tripId, uid, tripRef);
  if (claim.missing) {
    // Idempotent success. This also covers a client whose first call completed
    // server-side but lost the response before the PWA received it. Firestore
    // can retain subcollections below a missing parent, so verify those too.
    const [remainingChildren, verification, storage] = await Promise.all([
      verifyNoTripChildren(tripRef),
      verifyCrossReferences(tripId),
      verifyStorageEmpty(tripId)
    ]);
    const verified = remainingChildren.length === 0
      && verification.invites === 0
      && verification.preferences === 0
      && verification.registryExists === false
      && verification.genericTopLevel.length === 0
      && storage.empty;
    if (!verified) {
      throw new HttpsError("failed-precondition", "Trip root is gone but cleanup verification found remaining references.", {
        code: "delete-verification-failed",
        stage: "post-root-verification",
        remainingChildren,
        verification,
        storage
      });
    }
    return { tripId, status: "already-deleted", verified: true, deletionSchemaVersion: DELETE_SCHEMA_VERSION };
  }

  const runId = claim.runId;
  const ownership = { resumed: claim.resumed };
  logger.info("Permanent Trip deletion started", { tripId, uid, runId, resumed: ownership.resumed });

  let deletionStage = "trip-child-cleanup";
  try {
    // Keep the membership collection until the final child-cleanup stage. This
    // preserves the Owner's normal catalogue/access path for as much of an
    // interrupted deletion as possible. If interruption happens after members
    // are removed, the client-side pending-delete marker can still resume the
    // callable because deletionRequestedBy remains on the Trip root.
    const childCleanup = await deleteTripChildrenPreservingMembers(tripRef);
    const deletedChildCollections = [...childCleanup.deleted];

    deletionStage = "storage-cleanup";
    const storageCleanup = await cleanupTripStorage(tripId);
    deletionStage = "cross-reference-cleanup";
    const crossReferenceCleanup = await deleteKnownCrossReferences(tripId);

    deletionStage = "member-cleanup";
    const membersDeleted = await deleteMembersLast(tripRef, childCleanup.membersRef);
    if (membersDeleted) deletedChildCollections.push("members");

    deletionStage = "pre-root-verification";
    const verification = await verifyCleanupBeforeRootDelete(tripId, tripRef);

    if (!verification.clean) {
      await tripRef.set({
        deletionState: "deleting",
        deletionLastError: "cleanup-verification-failed",
        deletionLastAttemptAt: FieldValue.serverTimestamp()
      }, { merge: true });
      throw new HttpsError("failed-precondition", "Cleanup verification failed. The Trip root has been preserved so deletion can be resumed.", {
        code: "delete-verification-failed",
        verification
      });
    }

    // Critical invariant: the Trip root is deleted LAST, only after every known
    // Firestore cross-reference and Storage prefix verifies empty.
    deletionStage = "root-delete";
    await tripRef.delete();
    deletionStage = "root-verification";
    const rootAfterDelete = await tripRef.get();
    if (rootAfterDelete.exists) {
      throw new HttpsError("internal", "Trip root still exists after final delete.", { code: "root-delete-verification-failed" });
    }

    deletionStage = "post-root-verification";
    const postChildren = await verifyNoTripChildren(tripRef);
    if (postChildren.length) {
      throw new HttpsError("failed-precondition", "Nested Trip data remains after root delete.", {
        code: "delete-verification-failed",
        remainingCollections: postChildren
      });
    }

    logger.info("Permanent Trip deletion verified", { tripId, uid, runId });
    return {
      tripId,
      status: "deleted",
      verified: true,
      resumed: ownership.resumed,
      deletionSchemaVersion: DELETE_SCHEMA_VERSION,
      deletedChildCollections,
      storage: storageCleanup,
      crossReferences: crossReferenceCleanup
    };
  } catch (error) {
    logger.error("Permanent Trip deletion interrupted", {
      tripId,
      uid,
      runId,
      stage: deletionStage,
      code: error?.code,
      message: error?.message
    });
    await expireDeletionLease(tripRef, runId, error?.code || error?.message || "unknown");
    if (error instanceof HttpsError) {
      throw new HttpsError(error.code, error.message, {
        ...(error.details && typeof error.details === "object" ? error.details : {}),
        stage: deletionStage
      });
    }
    throw new HttpsError("internal", "Permanent deletion was interrupted. The Trip root was preserved when still present and cleanup can be resumed.", {
      code: "delete-interrupted",
      stage: deletionStage,
      causeCode: clean(error?.code || "")
    });
  }
});
