import { db } from "./firebase-service.js";
import {
  doc,
  runTransaction,
  serverTimestamp
} from "./firestore-observed-service.js";
import { assertCloudOnline } from "./cloud-safety-service.js";

const LOCK_TTL_MS=12*60*1000;
function clean(v){return String(v??"").trim();}
function timestampMillis(value){
  try{
    if(typeof value?.toMillis==="function")return Number(value.toMillis())||0;
    if(value?.seconds!=null)return Number(value.seconds)*1000;
  }catch(error){}
  return 0;
}
function lockId(type){return`${clean(type)||"operation"}_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;}
function operationRef(tripId){return doc(db,"trips",tripId,"operations","current");}

export async function acquireTripOperation(tripIdInput,typeInput,user){
  assertCloudOnline("旅程更新");
  const tripId=clean(tripIdInput),type=clean(typeInput)||"operation";
  if(!tripId||!user?.uid)throw new Error("Missing trip operation context");
  const ref=operationRef(tripId);
  const operationId=lockId(type);
  const now=Date.now();

  // v7.7.4.5: the coordination lock lives in its own document. Import /
  // restore can now update trips/{tripId} freely without invalidating the
  // transaction that decides which device owns the operation lock.
  await runTransaction(db,async tx=>{
    const snap=await tx.get(ref);
    const data=snap.exists()?(snap.data()||{}):{};
    const existingId=clean(data.operationId);
    const existingStarted=timestampMillis(data.startedAt)||Number(data.startedAtMs)||0;
    const existingBy=clean(data.actorUid);
    const stale=!existingStarted||now-existingStarted>LOCK_TTL_MS;
    if(existingId&&!stale){
      const error=new Error("Another device is updating this Trip");
      error.code="trip-operation-busy";
      error.operation={
        operationId:existingId,
        type:clean(data.type),
        actorUid:existingBy,
        startedAtMs:existingStarted
      };
      throw error;
    }
    tx.set(ref,{
      operationId,
      type,
      actorUid:user.uid,
      startedAtMs:now,
      startedAt:serverTimestamp()
    });
  });
  return{tripId,type,operationId};
}

export async function releaseTripOperation(lock,user,{force=false}={}){
  if(!lock?.tripId||!lock?.operationId)return;
  const ref=operationRef(lock.tripId);
  try{
    await runTransaction(db,async tx=>{
      const snap=await tx.get(ref);
      if(!snap.exists())return;
      const data=snap.data()||{};
      if(!force&&clean(data.operationId)!==clean(lock.operationId))return;
      if(!force&&user?.uid&&clean(data.actorUid)!==clean(user.uid))return;
      tx.delete(ref);
    });
  }catch(error){
    console.warn("Unable to release trip operation lock",error);
  }
}
