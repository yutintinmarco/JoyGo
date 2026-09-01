const listeners=new Set();
let activeOperation=null;
let online=typeof navigator==="undefined"?true:navigator.onLine!==false;

function snapshot(){
  return {
    online,
    operation:activeOperation?{...activeOperation}:null
  };
}
function notify(){
  const state=snapshot();
  try{
    window.__cloudSafetyState=state;
    window.dispatchEvent(new CustomEvent("app-cloud-safety",{detail:state}));
  }catch(error){}
  listeners.forEach(fn=>{try{fn(state);}catch(error){}});
}
function setOnline(next){
  const value=next!==false;
  if(online===value)return;
  online=value;
  notify();
}
if(typeof window!=="undefined"){
  window.addEventListener("online",()=>setOnline(true),{passive:true});
  window.addEventListener("offline",()=>setOnline(false),{passive:true});
}
export function isCloudOnline(){return online;}
export function assertCloudOnline(label="雲端操作"){
  if(online)return true;
  const error=new Error(`${label} requires an internet connection`);
  error.code="offline";
  throw error;
}
export function assertCloudOperationAvailable(label="雲端操作"){
  assertCloudOnline(label);
  if(!activeOperation)return true;
  const error=new Error(`${activeOperation.type||"operation"} is already running`);
  error.code="operation-busy";
  error.operation={...activeOperation};
  throw error;
}
export function beginCloudOperation({type="cloud",tripId="",label=""}={}){
  assertCloudOperationAvailable(label||type);
  const token=`${type}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  activeOperation={token,type:String(type||"cloud"),tripId:String(tripId||""),label:String(label||""),startedAt:Date.now()};
  notify();
  return token;
}
export function endCloudOperation(token){
  if(!activeOperation)return;
  if(token&&activeOperation.token!==token)return;
  activeOperation=null;
  notify();
}
export function getCloudSafetyState(){return snapshot();}
export function subscribeCloudSafety(callback){
  if(typeof callback!=="function")return()=>{};
  listeners.add(callback);
  callback(snapshot());
  return()=>listeners.delete(callback);
}
