import { db } from "./firebase-service.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  where
} from "./firestore-observed-service.js";

function clean(value) { return String(value ?? "").trim(); }
function plainTitle(value) { return clean(value).replace(/<[^>]*>/g, "").trim(); }
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (!value || typeof value !== "object") return value;
  const out = {};
  Object.entries(value).forEach(([key, next]) => {
    if (next == null || ["string", "number", "boolean"].includes(typeof next)) out[key] = next;
    else if (Array.isArray(next) || typeof next === "object") out[key] = clonePlain(next);
  });
  return out;
}

function localIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function effectiveTripStatus(storedStatus, startDate, endDate) {
  const stored = clean(storedStatus).toLowerCase();
  if (stored === "draft") return "draft";
  // Legacy Expense Lock used root status="locked" / "open". Phase 2G.2 no
  // longer treats those values as Trip lifecycle status; date status remains
  // independent from both Expense Lock and Global Trip Lock.
  const normalizedStored = ["locked", "open"].includes(stored) ? "" : stored;
  const start = clean(startDate);
  const end = clean(endDate);
  const today = localIsoDate();
  if (start && today < start) return "upcoming";
  if (end && today > end) return "completed";
  if ((start && today >= start) || (end && today <= end)) return "active";
  return normalizedStored || "upcoming";
}

function normalizeTripDoc(snapshot) {
  const data = snapshot.data() || {};
  return {
    tripId: snapshot.id,
    schemaVersion: Number(data.schemaVersion) || 0,
    revision: Number(data.revision) || 0,
    title: plainTitle(data.title || data.titleSmall || snapshot.id),
    titleSmall: clean(data.titleSmall),
    dateRange: clean(data.dateRange),
    startDate: clean(data.startDate),
    endDate: clean(data.endDate),
    status: effectiveTripStatus(data.status, data.startDate, data.endDate),
    legacyArchived: data.archived === true,
    archived: data.archived === true,
    archivedAt: data.archivedAt || null,
    archivedBy: clean(data.archivedBy),
    archiveSource: data.archived === true ? "legacy-trip" : "default",
    globalLocked: data.globalLocked === true,
    globalLockedAt: data.globalLockedAt || null,
    globalLockedBy: clean(data.globalLockedBy),
    globalLockedByName: clean(data.globalLockedByName),
    importState: clean(data.importState || "ready"),
    coverImage: clean(data.coverImage),
    tripIcon: clean(data.tripIcon),
    backgroundImage: clean(data.backgroundImage),
    tripIconMedia: clonePlain(data.tripIconMedia || null) || null,
    backgroundImageMedia: clonePlain(data.backgroundImageMedia || null) || null,
    coverImageMedia: clonePlain(data.coverImageMedia || null) || null,
    updatedAt: data.updatedAt || null,
    createdBy: clean(data.createdBy),
    memberCount: Number(data.memberCount) || 0,
    role: null
  };
}

function normalizePreference(snapshot){
  const data=snapshot.data()||{};
  return {
    tripId: clean(data.tripId || snapshot.id),
    archived: data.archived === true,
    hasArchivedValue: typeof data.archived === "boolean",
    archivedAt: data.archivedAt || null,
    updatedAt: data.updatedAt || null
  };
}

async function attachRoles(trips, uid) {
  if (!uid || !trips.length) return trips;
  return Promise.all(trips.map(async trip => {
    try {
      const member = await getDoc(doc(db, "trips", trip.tripId, "members", uid));
      const role = member.exists() ? clean(member.data()?.role) : null;
      return { ...trip, role: role || null };
    } catch (error) {
      return { ...trip, role: null };
    }
  }));
}

function mergePreferences(trips, preferenceMap){
  return trips.map(trip=>{
    const pref=preferenceMap.get(trip.tripId);
    if(pref?.hasArchivedValue){
      return {
        ...trip,
        archived: pref.archived === true,
        archivedAt: pref.archivedAt || null,
        archivedBy: "",
        archiveSource: "personal"
      };
    }
    return {...trip};
  });
}

export function subscribeUserTrips(user, callback) {
  if (typeof callback !== "function") return () => {};
  const uid = clean(user?.uid);
  if (!uid) {
    callback({ status: "signed-out", trips: [], error: null });
    return () => {};
  }

  callback({ status: "loading", trips: [], error: null });

  // Phase 2G.2 Personal Archive: Trip membership and archive preference are
  // separate concepts. One membership query loads the user's accessible Trips;
  // a single user-scoped preference listener overlays archived state locally.
  const tripsQuery = query(collection(db, "trips"), where("memberUids", "array-contains", uid));
  const preferencesRef = collection(db, "users", uid, "tripPreferences");

  let stopped=false;
  let tripRunId=0;
  let baseTrips=null;
  let preferenceMap=new Map();
  let tripReady=false;
  let preferencesReady=false;
  let tripFromCache=false;
  let preferenceFromCache=false;
  let tripServerConfirmed=false;
  let preferenceServerConfirmed=false;
  let tripError=null;
  let preferenceError=null;

  function publish(){
    if(stopped) return;
    if(tripError || preferenceError){
      const error=tripError||preferenceError;
      callback({status:error?.code==="permission-denied"?"rules-pending":(error?.code==="failed-precondition"?"index-required":"error"),trips:[],error,fromCache:false,serverConfirmed:false});
      return;
    }
    if(!tripReady || !preferencesReady || !baseTrips){
      callback({status:"loading",trips:[],error:null,fromCache:tripFromCache||preferenceFromCache,serverConfirmed:false});
      return;
    }
    const trips=mergePreferences(baseTrips,preferenceMap);
    callback({
      status:"ready",
      trips,
      error:null,
      fromCache:tripFromCache||preferenceFromCache,
      serverConfirmed:tripServerConfirmed&&preferenceServerConfirmed
    });
  }

  const stopTrips=onSnapshot(tripsQuery,{includeMetadataChanges:true},snapshot=>{
    const thisRun=++tripRunId;
    tripReady=true;
    tripFromCache=snapshot.metadata?.fromCache===true;
    if(!tripFromCache) tripServerConfirmed=true;

    let contentChanged=baseTrips===null;
    if(!contentChanged){
      try{ contentChanged=snapshot.docChanges({includeMetadataChanges:false}).length>0; }
      catch(error){ contentChanged=true; }
    }
    if(!contentChanged){ publish(); return; }

    const base=snapshot.docs.map(normalizeTripDoc);
    attachRoles(base,uid).then(trips=>{
      if(stopped || thisRun!==tripRunId) return;
      trips.sort((a,b)=>{
        const ad=a.startDate||"9999-99-99",bd=b.startDate||"9999-99-99";
        return ad.localeCompare(bd)||a.title.localeCompare(b.title);
      });
      baseTrips=trips.map(trip=>({...trip}));
      publish();
    });
  },error=>{ tripError=error; tripReady=true; publish(); });

  const stopPreferences=onSnapshot(preferencesRef,{includeMetadataChanges:true},snapshot=>{
    preferencesReady=true;
    preferenceFromCache=snapshot.metadata?.fromCache===true;
    if(!preferenceFromCache) preferenceServerConfirmed=true;
    preferenceMap=new Map(snapshot.docs.map(snap=>{ const pref=normalizePreference(snap); return [pref.tripId,pref]; }));
    publish();
  },error=>{ preferenceError=error; preferencesReady=true; publish(); });

  return ()=>{
    stopped=true;
    try{stopTrips();}catch(error){}
    try{stopPreferences();}catch(error){}
  };
}
