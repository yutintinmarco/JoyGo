import { db } from "./firebase-service.js";
import { collection, getDocs, limit, orderBy, query } from "./firestore-observed-service.js";

function clean(value = "") { return String(value ?? "").trim(); }

export async function listTripActivityLogs(tripIdInput, { limitCount = 120 } = {}) {
  const tripId = clean(tripIdInput);
  if (!tripId) throw new Error("Missing tripId");
  const count = Math.max(1, Math.min(250, Number(limitCount) || 120));
  const q = query(collection(db, "trips", tripId, "activityLogs"), orderBy("createdAt", "desc"), limit(count));
  const snap = await getDocs(q);
  return snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
}
