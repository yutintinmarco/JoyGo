import { db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import { collection, doc, getDoc, serverTimestamp, writeBatch } from "./firestore-observed-service.js";

function clean(value){ return String(value ?? "").trim(); }
async function requireUser(input=null){
  const user=input||getCurrentUser()||await waitForInitialAuth();
  if(!user?.uid){ const error=new Error("Google sign-in required"); error.code="auth-required"; throw error; }
  return user;
}
async function requireManager(tripId,user){
  const member=await getDoc(doc(db,"trips",tripId,"members",user.uid));
  const role=member.exists()?clean(member.data()?.role):"";
  if(role!=="owner"&&role!=="admin"){
    const error=new Error("Owner or Admin role required"); error.code="insufficient-role"; throw error;
  }
  return role;
}

export async function setGlobalTripLocked(tripIdInput, locked, { user:userInput=null } = {}){
  const tripId=clean(tripIdInput), user=await requireUser(userInput);
  if(!tripId){ const error=new Error("Missing tripId"); error.code="trip-not-found"; throw error; }
  await requireManager(tripId,user);
  const shouldLock=locked===true;
  const tripRef=doc(db,"trips",tripId);
  const snap=await getDoc(tripRef);
  if(!snap.exists()){ const error=new Error("Trip not found"); error.code="trip-not-found"; throw error; }
  const current=snap.data()?.globalLocked===true;
  if(current===shouldLock) return {tripId,globalLocked:shouldLock,unchanged:true};

  const batch=writeBatch(db);
  batch.set(tripRef,{
    globalLocked:shouldLock,
    globalLockedAt:shouldLock?serverTimestamp():null,
    globalLockedBy:shouldLock?user.uid:"",
    globalLockedByName:shouldLock?clean(user.displayName||user.email):"",
    globalUnlockedAt:shouldLock?null:serverTimestamp(),
    globalUnlockedBy:shouldLock?"":user.uid,
    globalUnlockedByName:shouldLock?"":clean(user.displayName||user.email),
    updatedAt:serverTimestamp(),
    updatedBy:user.uid
  },{merge:true});
  const logRef=doc(collection(db,"trips",tripId,"activityLogs"));
  batch.set(logRef,{
    type:shouldLock?"trip.global.lock":"trip.global.unlock",
    actionType:shouldLock?"trip.global.lock":"trip.global.unlock",
    category:"itinerary",
    title:shouldLock?"鎖定旅程":"解鎖旅程",
    summary:shouldLock?"旅程已設為全域唯讀。":"旅程已解除全域唯讀。",
    actorUid:user.uid,
    actorName:clean(user.displayName||user.email),
    actorEmail:clean(user.email).toLowerCase(),
    createdAt:serverTimestamp()
  });
  await batch.commit();
  return {tripId,globalLocked:shouldLock,unchanged:false};
}
