import { db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import { assertCloudOperationAvailable } from "./cloud-safety-service.js";
import {
  arrayRemove, arrayUnion, collection, doc, getDoc, getDocs, increment,
  onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, writeBatch
} from "./firestore-observed-service.js";

const ROLE_RANK=Object.freeze({viewer:1,member:2,admin:3,owner:4});
const VALID_ROLES=new Set(["owner","admin","member","viewer"]);
const ASSIGNABLE_ROLES=new Set(["admin","member","viewer"]);
function clean(value){return String(value??"").trim();}
function normalizeEmail(value){return clean(value).toLowerCase();}
function validEmail(value){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));}
function roleLabel(role){return({owner:"Owner",admin:"Admin",member:"Member",viewer:"Viewer"})[role]||role||"";}
function timestampMs(value){try{if(value?.toMillis)return value.toMillis();if(value?.toDate)return value.toDate().getTime();if(value?.seconds!=null)return Number(value.seconds)*1000;const d=new Date(value);return Number.isFinite(d.getTime())?d.getTime():0;}catch{return 0;}}
function normalizeMember(snap){const d=snap.data()||{};return{uid:snap.id,role:clean(d.role||"viewer"),status:clean(d.status||"active"),displayName:clean(d.displayName),email:normalizeEmail(d.email),photoURL:clean(d.photoURL),joinedAt:d.joinedAt||d.createdAt||null,inviteId:clean(d.inviteId)};}
function normalizeInvite(snap){const d=snap.data()||{};return{inviteId:snap.id,tripId:clean(d.tripId),tripTitle:clean(d.tripTitle),tripDateRange:clean(d.tripDateRange),tripIcon:clean(d.tripIcon),email:clean(d.email||d.emailLower),emailLower:normalizeEmail(d.emailLower||d.email),role:clean(d.role),status:clean(d.status||"pending"),invitedBy:clean(d.invitedBy),invitedByName:clean(d.invitedByName),createdAt:d.createdAt||null,acceptedAt:d.acceptedAt||null};}
async function requireUser(input=null){const user=input||getCurrentUser()||await waitForInitialAuth();if(!user?.uid){const e=new Error("Google sign-in required");e.code="auth-required";throw e;}return user;}
async function actorRole(tripId,user){const snap=await getDoc(doc(db,"trips",tripId,"members",user.uid));const role=snap.exists()?clean(snap.data()?.role):"";return VALID_ROLES.has(role)?role:"";}
function canAssign(actor,targetRole){if(actor==="owner")return ASSIGNABLE_ROLES.has(targetRole);if(actor==="admin")return targetRole==="member"||targetRole==="viewer";return false;}
function canManageTarget(actor,targetRole){if(actor==="owner")return targetRole!=="owner";if(actor==="admin")return targetRole==="member"||targetRole==="viewer";return false;}
function addActivity(batch,tripId,user,payload){const ref=doc(collection(db,"trips",tripId,"activityLogs"));batch.set(ref,{type:payload.actionType,actionType:payload.actionType,category:"member",title:payload.title,summary:payload.summary||"",actorUid:user.uid,actorName:clean(user.displayName),actorEmail:normalizeEmail(user.email),targetUid:clean(payload.targetUid),targetEmail:normalizeEmail(payload.targetEmail),role:clean(payload.role),previousRole:clean(payload.previousRole),createdAt:serverTimestamp()});}

export function subscribeTripMembers(tripIdInput,callback){
  const tripId=clean(tripIdInput);if(!tripId||typeof callback!=="function")return()=>{};
  callback({status:"loading",members:[]});
  return onSnapshot(collection(db,"trips",tripId,"members"),snap=>{
    const members=snap.docs.map(normalizeMember).sort((a,b)=>(ROLE_RANK[b.role]||0)-(ROLE_RANK[a.role]||0)||(a.displayName||a.email||a.uid).localeCompare(b.displayName||b.email||b.uid));
    callback({status:"ready",members});
  },error=>callback({status:error?.code==="permission-denied"?"permission-denied":"error",members:[],error}));
}
export function subscribeTripPendingInvites(tripIdInput,callback){
  const tripId=clean(tripIdInput);if(!tripId||typeof callback!=="function")return()=>{};
  callback({status:"loading",invites:[]});
  const q=query(collection(db,"tripInvites"),where("tripId","==",tripId));
  return onSnapshot(q,snap=>callback({status:"ready",invites:snap.docs.map(normalizeInvite).filter(x=>x.status==="pending").sort((a,b)=>timestampMs(b.createdAt)-timestampMs(a.createdAt))}),error=>callback({status:error?.code==="permission-denied"?"permission-denied":"error",invites:[],error}));
}
export function subscribeMyPendingInvites(userInput,callback){
  if(typeof callback!=="function")return()=>{};
  const email=normalizeEmail(userInput?.email);if(!email){callback({status:"signed-out",invites:[]});return()=>{};}
  callback({status:"loading",invites:[]});
  const q=query(collection(db,"tripInvites"),where("emailLower","==",email));
  return onSnapshot(q,snap=>callback({status:"ready",invites:snap.docs.map(normalizeInvite).filter(x=>x.status==="pending").sort((a,b)=>timestampMs(b.createdAt)-timestampMs(a.createdAt))}),error=>callback({status:error?.code==="permission-denied"?"permission-denied":"error",invites:[],error}));
}

export async function createTripInvite(tripIdInput,emailInput,roleInput,{user:userInput=null}={}){
  const tripId=clean(tripIdInput),email=normalizeEmail(emailInput),role=clean(roleInput||"member").toLowerCase(),user=await requireUser(userInput);
  assertCloudOperationAvailable("邀請成員");
  if(!tripId){const e=new Error("Missing tripId");e.code="trip-not-found";throw e;}
  if(!validEmail(email)){const e=new Error("Invalid email");e.code="invalid-email";throw e;}
  const actor=await actorRole(tripId,user);if(!canAssign(actor,role)){const e=new Error("Insufficient role");e.code="insufficient-role";throw e;}
  const [tripSnap,membersSnap,invitesSnap]=await Promise.all([getDoc(doc(db,"trips",tripId)),getDocs(collection(db,"trips",tripId,"members")),getDocs(query(collection(db,"tripInvites"),where("tripId","==",tripId)))]);
  if(!tripSnap.exists()){const e=new Error("Trip not found");e.code="trip-not-found";throw e;}
  if(membersSnap.docs.some(s=>normalizeEmail(s.data()?.email)===email)){const e=new Error("Already member");e.code="already-member";throw e;}
  if(invitesSnap.docs.some(s=>{const d=s.data()||{};return normalizeEmail(d.emailLower||d.email)===email&&clean(d.status||"pending")==="pending";})){const e=new Error("Invite exists");e.code="invite-exists";throw e;}
  const trip=tripSnap.data()||{},inviteRef=doc(collection(db,"tripInvites")),batch=writeBatch(db);
  batch.set(inviteRef,{inviteId:inviteRef.id,tripId,tripTitle:clean(trip.title||trip.titleSmall||tripId),tripDateRange:clean(trip.dateRange),tripIcon:clean(trip.tripIcon),email,emailLower:email,role,status:"pending",invitedBy:user.uid,invitedByName:clean(user.displayName||user.email),createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
  addActivity(batch,tripId,user,{actionType:"trip.member.invite",title:"邀請旅程成員",summary:`邀請 ${email} 成為 ${roleLabel(role)}`,targetEmail:email,role});
  await batch.commit();return{inviteId:inviteRef.id,email,role,tripId};
}
export async function cancelTripInvite(inviteIdInput,{user:userInput=null}={}){
  const inviteId=clean(inviteIdInput),user=await requireUser(userInput),inviteRef=doc(db,"tripInvites",inviteId),inviteSnap=await getDoc(inviteRef);
  if(!inviteSnap.exists()){const e=new Error("Invite not found");e.code="invite-not-found";throw e;}
  const invite=normalizeInvite(inviteSnap),actor=await actorRole(invite.tripId,user);if(!canAssign(actor,invite.role)){const e=new Error("Insufficient role");e.code="insufficient-role";throw e;}
  const batch=writeBatch(db);batch.delete(inviteRef);addActivity(batch,invite.tripId,user,{actionType:"trip.member.cancel-invite",title:"取消旅程邀請",summary:`取消 ${invite.emailLower} 嘅 ${roleLabel(invite.role)} 邀請`,targetEmail:invite.emailLower,role:invite.role});await batch.commit();
}
export async function acceptTripInvite(inviteIdInput,{user:userInput=null}={}){
  const inviteId=clean(inviteIdInput),user=await requireUser(userInput);
  assertCloudOperationAvailable("加入旅程");
  const inviteRef=doc(db,"tripInvites",inviteId),inviteSnap=await getDoc(inviteRef);
  if(!inviteSnap.exists()){const e=new Error("Invite not found");e.code="invite-not-found";throw e;}
  const invite=normalizeInvite(inviteSnap);
  if(invite.status!=="pending"){const e=new Error("Invite no longer pending");e.code="invite-not-found";throw e;}
  if(normalizeEmail(user.email)!==invite.emailLower){const e=new Error("Email mismatch");e.code="invite-email-mismatch";throw e;}
  if(!ASSIGNABLE_ROLES.has(invite.role)){const e=new Error("Invalid invite role");e.code="insufficient-role";throw e;}

  // Phase 2F: do not read the private Trip parent before membership exists.
  // The pending invite authorises one atomic self-join in Security Rules.
  const tripRef=doc(db,"trips",invite.tripId),memberRef=doc(db,"trips",invite.tripId,"members",user.uid);
  const batch=writeBatch(db);
  batch.set(memberRef,{
    uid:user.uid,role:invite.role,status:"active",
    displayName:clean(user.displayName),email:normalizeEmail(user.email),photoURL:clean(user.photoURL),
    inviteId,invitedBy:invite.invitedBy,
    joinedAt:serverTimestamp(),createdAt:serverTimestamp(),updatedAt:serverTimestamp()
  });
  batch.update(tripRef,{
    memberUids:arrayUnion(user.uid),
    memberCount:increment(1),
    updatedBy:user.uid,
    updatedAt:serverTimestamp()
  });
  batch.update(inviteRef,{
    status:"accepted",acceptedBy:user.uid,acceptedAt:serverTimestamp(),updatedAt:serverTimestamp()
  });
  await batch.commit();

  try{
    await setDoc(doc(collection(db,"trips",invite.tripId,"activityLogs")),{
      type:"trip.member.accept",actionType:"trip.member.accept",category:"member",title:"加入旅程",
      summary:`${clean(user.displayName||user.email)} 以 ${roleLabel(invite.role)} 身份加入旅程`,
      actorUid:user.uid,actorName:clean(user.displayName),actorEmail:normalizeEmail(user.email),
      role:invite.role,createdAt:serverTimestamp()
    });
  }catch(error){console.warn("Trip joined; activity log skipped",error);}

  return{tripId:invite.tripId,tripTitle:invite.tripTitle,role:invite.role};
}

export async function declineTripInvite(inviteIdInput,{user:userInput=null}={}){
  const inviteId=clean(inviteIdInput),user=await requireUser(userInput),inviteRef=doc(db,"tripInvites",inviteId),inviteSnap=await getDoc(inviteRef);
  if(!inviteSnap.exists()){const e=new Error("Invite not found");e.code="invite-not-found";throw e;}
  const invite=normalizeInvite(inviteSnap);if(normalizeEmail(user.email)!==invite.emailLower){const e=new Error("Email mismatch");e.code="invite-email-mismatch";throw e;}
  await updateDoc(inviteRef,{status:"declined",declinedBy:user.uid,declinedAt:serverTimestamp(),updatedAt:serverTimestamp()});
}
export async function updateTripMemberRole(tripIdInput,targetUidInput,nextRoleInput,{user:userInput=null}={}){
  const tripId=clean(tripIdInput),targetUid=clean(targetUidInput),nextRole=clean(nextRoleInput).toLowerCase(),user=await requireUser(userInput),actor=await actorRole(tripId,user),targetRef=doc(db,"trips",tripId,"members",targetUid),targetSnap=await getDoc(targetRef);
  if(!targetSnap.exists()){const e=new Error("Member not found");e.code="member-not-found";throw e;}
  const target=normalizeMember(targetSnap);if(!canManageTarget(actor,target.role)||!canAssign(actor,nextRole)){const e=new Error("Insufficient role");e.code="insufficient-role";throw e;}if(target.role===nextRole)return;
  const batch=writeBatch(db);batch.update(targetRef,{role:nextRole,updatedBy:user.uid,updatedAt:serverTimestamp()});addActivity(batch,tripId,user,{actionType:"trip.member.role",title:"更改成員角色",summary:`${target.displayName||target.email||target.uid}：${roleLabel(target.role)} → ${roleLabel(nextRole)}`,targetUid,targetEmail:target.email,previousRole:target.role,role:nextRole});await batch.commit();
}
export async function removeTripMember(tripIdInput,targetUidInput,{user:userInput=null}={}){
  const tripId=clean(tripIdInput),targetUid=clean(targetUidInput),user=await requireUser(userInput),actor=await actorRole(tripId,user),targetRef=doc(db,"trips",tripId,"members",targetUid),targetSnap=await getDoc(targetRef);
  if(!targetSnap.exists()){const e=new Error("Member not found");e.code="member-not-found";throw e;}
  const target=normalizeMember(targetSnap);if(!canManageTarget(actor,target.role)){const e=new Error("Insufficient role");e.code="insufficient-role";throw e;}
  const batch=writeBatch(db);batch.delete(targetRef);batch.update(doc(db,"trips",tripId),{memberUids:arrayRemove(targetUid),memberCount:increment(-1),updatedBy:user.uid,updatedAt:serverTimestamp()});addActivity(batch,tripId,user,{actionType:"trip.member.remove",title:"移除旅程成員",summary:`移除 ${target.displayName||target.email||target.uid} 嘅 ${roleLabel(target.role)} 權限`,targetUid,targetEmail:target.email,previousRole:target.role});await batch.commit();
}
