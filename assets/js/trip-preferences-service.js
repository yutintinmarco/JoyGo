import { db } from "./firebase-service.js";
import { getCurrentUser, waitForInitialAuth } from "./auth-service.js";
import { doc, serverTimestamp, setDoc } from "./firestore-observed-service.js";

function clean(value){ return String(value ?? "").trim(); }
async function requireUser(input=null){
  const user=input||getCurrentUser()||await waitForInitialAuth();
  if(!user?.uid){ const error=new Error("Google sign-in required"); error.code="auth-required"; throw error; }
  return user;
}

export async function setPersonalTripArchived(tripIdInput, archived, { user:userInput=null } = {}){
  const tripId=clean(tripIdInput), user=await requireUser(userInput);
  if(!tripId){ const error=new Error("Missing tripId"); error.code="trip-not-found"; throw error; }
  const shouldArchive=archived===true;
  await setDoc(doc(db,"users",user.uid,"tripPreferences",tripId),{
    tripId,
    archived:shouldArchive,
    archivedAt:shouldArchive?serverTimestamp():null,
    updatedAt:serverTimestamp()
  },{merge:true});
  return {tripId,archived:shouldArchive};
}
