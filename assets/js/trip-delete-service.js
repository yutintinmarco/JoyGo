import { firebaseApp } from "./firebase-service.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.8.0/firebase-functions.js";

const functions = getFunctions(firebaseApp, "asia-east2");
const permanentDeleteCallable = httpsCallable(functions, "permanentDeleteTrip", { timeout: 540000 });
const PENDING_DELETE_KEY_PREFIX = "travel_pending_trip_deletions_v1:";

function clean(value){ return String(value ?? "").trim(); }
function markerKey(uid){ return `${PENDING_DELETE_KEY_PREFIX}${clean(uid)}`; }
function readMarkerMap(uid){
  const safeUid=clean(uid);if(!safeUid)return {};
  try{
    const parsed=JSON.parse(localStorage.getItem(markerKey(safeUid))||"{}");
    return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};
  }catch(error){return {};}
}
function writeMarkerMap(uid,map){
  const safeUid=clean(uid);if(!safeUid)return;
  try{
    const entries=Object.entries(map||{}).filter(([tripId,value])=>clean(tripId)&&value&&typeof value==="object");
    if(!entries.length)localStorage.removeItem(markerKey(safeUid));
    else localStorage.setItem(markerKey(safeUid),JSON.stringify(Object.fromEntries(entries)));
  }catch(error){}
}

export function listPendingTripDeletions(uidInput){
  const uid=clean(uidInput);
  return Object.values(readMarkerMap(uid))
    .filter(item=>item&&clean(item.tripId))
    .sort((a,b)=>Number(a.startedAt||0)-Number(b.startedAt||0))
    .map(item=>({...item,tripId:clean(item.tripId),uid}));
}

export function rememberPendingTripDeletion(uidInput,tripIdInput,{title=""}={}){
  const uid=clean(uidInput),tripId=clean(tripIdInput);
  if(!uid||!tripId)return null;
  const map=readMarkerMap(uid);
  const previous=map[tripId]&&typeof map[tripId]==="object"?map[tripId]:{};
  const marker={
    tripId,
    title:clean(title||previous.title),
    startedAt:Number(previous.startedAt)||Date.now(),
    lastAttemptAt:Date.now()
  };
  map[tripId]=marker;writeMarkerMap(uid,map);return {...marker,uid};
}

export function clearPendingTripDeletion(uidInput,tripIdInput){
  const uid=clean(uidInput),tripId=clean(tripIdInput);
  if(!uid||!tripId)return;
  const map=readMarkerMap(uid);delete map[tripId];writeMarkerMap(uid,map);
}

function shouldClearMarkerForError(error){
  const code=clean(error?.code);
  return code==="invalid-trip-id"
    || code==="functions/invalid-argument"
    || code==="functions/unauthenticated"
    || code==="functions/permission-denied"
    || code==="trip-operation-busy";
}

export async function permanentDeleteTrip(tripIdInput,{user=null,title=""}={}){
  const tripId = clean(tripIdInput);
  if(!tripId){ const error = new Error("Missing tripId"); error.code = "invalid-trip-id"; throw error; }
  const uid=clean(user?.uid);
  if(uid)rememberPendingTripDeletion(uid,tripId,{title});
  try{
    const result = await permanentDeleteCallable({ tripId });
    const data = result?.data || {};
    if(data.verified !== true){
      const error = new Error("Permanent delete did not pass cleanup verification");
      error.code = "delete-verification-failed";
      error.details = data;
      throw error;
    }
    if(uid)clearPendingTripDeletion(uid,tripId);
    return data;
  }catch(error){
    const details = error?.details || error?.customData?.details || null;
    const detailCode = clean(details?.code);
    if(detailCode) error.code = detailCode;
    if(uid&&shouldClearMarkerForError(error))clearPendingTripDeletion(uid,tripId);
    throw error;
  }
}
