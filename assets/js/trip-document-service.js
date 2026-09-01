import { firebaseApp, auth } from './firebase-service.js';
import {
  getStorage,
  ref,
  uploadBytesResumable,
  deleteObject,
  getBlob,
  listAll
} from 'https://www.gstatic.com/firebasejs/11.8.0/firebase-storage.js';

const storage = getStorage(firebaseApp);
const stagedFiles = new Map();
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const PENDING_DOCUMENT_CLEANUP_KEY = 'travel_trip_document_cleanup_v1';
const ALLOWED_IMAGE_TYPES = /^image\/(jpeg|jpg|png|webp|heic|heif)$/i;
const ALLOWED_TYPES = new Set(['application/pdf']);

function clean(value){ return String(value ?? '').trim(); }
function clone(value){ return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value; }
function makeId(prefix='doc'){
  try { if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID().replace(/-/g,'').slice(0,18)}`; } catch (_) {}
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,10)}`;
}
function safeFileName(nameInput='file'){
  const raw=clean(nameInput)||'file';
  const parts=raw.split('.');
  const ext=parts.length>1?parts.pop().toLowerCase():'';
  const base=parts.join('.')||'file';
  const safeBase=base.normalize('NFKD').replace(/[^a-zA-Z0-9\u3400-\u9fff\-_ ]+/g,'').trim().replace(/\s+/g,'-').slice(0,80)||'file';
  const safeExt=ext.replace(/[^a-z0-9]+/g,'').slice(0,10);
  return safeExt?`${safeBase}.${safeExt}`:safeBase;
}
function documentPath(tripId, documentId, fileName){
  return `trips/${clean(tripId)}/documents/${clean(documentId)}/${safeFileName(fileName)}`;
}
function pendingCleanupRows(){
  try { const raw=JSON.parse(localStorage.getItem(PENDING_DOCUMENT_CLEANUP_KEY)||'[]'); return Array.isArray(raw)?raw:[]; } catch (_) { return []; }
}
function savePendingCleanupRows(rows=[]){
  try { const next=(Array.isArray(rows)?rows:[]).filter(row=>clean(row?.storagePath)); if(next.length)localStorage.setItem(PENDING_DOCUMENT_CLEANUP_KEY,JSON.stringify(next)); else localStorage.removeItem(PENDING_DOCUMENT_CLEANUP_KEY); } catch (_) {}
}
function queuePendingCleanup(descriptors=[]){
  const byPath=new Map(pendingCleanupRows().map(row=>[clean(row?.storagePath),row]));
  (Array.isArray(descriptors)?descriptors:[]).forEach(row=>{const path=clean(row?.storagePath);if(path)byPath.set(path,plainDescriptor(row));});
  savePendingCleanupRows([...byPath.values()]);
}
function assertFile(file){
  if (!(file instanceof Blob)) { const e=new Error('Document file is required'); e.code='invalid-document-file'; throw e; }
  const size=Number(file.size)||0;
  if(size<=0||size>MAX_DOCUMENT_BYTES){ const e=new Error('Document file is too large'); e.code='document-file-too-large'; e.maxBytes=MAX_DOCUMENT_BYTES; throw e; }
  const type=clean(file.type).toLowerCase();
  if(!ALLOWED_TYPES.has(type)&&!ALLOWED_IMAGE_TYPES.test(type)){ const e=new Error('Unsupported document file type'); e.code='document-file-type-unsupported'; throw e; }
}
function requireUser(userInput=null){
  const user=userInput||auth.currentUser||null;
  if(!user?.uid){ const e=new Error('Sign in is required'); e.code='auth-required'; throw e; }
  return user;
}
function plainDescriptor(row={}){
  return {
    documentId: clean(row.documentId),
    tripId: clean(row.tripId),
    ownerType: clean(row.ownerType),
    ownerId: clean(row.ownerId),
    dayId: clean(row.dayId),
    title: clean(row.title),
    fileName: clean(row.fileName),
    contentType: clean(row.contentType),
    byteSize: Number(row.byteSize)||0,
    storagePath: clean(row.storagePath),
    sortOrder: Number.isFinite(Number(row.sortOrder))?Number(row.sortOrder):0,
    uploadedAt: clean(row.uploadedAt),
    uploadedBy: clean(row.uploadedBy),
    editDraft: row.editDraft===true
  };
}

export function normalizeBookingDocument(rowInput={}, index=0){
  const row=rowInput&&typeof rowInput==='object'?rowInput:{};
  const documentId=clean(row.documentId||row.id)||makeId('doc');
  const fileName=clean(row.fileName||row.name)||'document';
  const title=clean(row.title)||fileName.replace(/\.[^.]+$/,'');
  return plainDescriptor({
    ...row,
    documentId,
    fileName,
    title,
    sortOrder:Number.isFinite(Number(row.sortOrder))?Number(row.sortOrder):index
  });
}
export function normalizeBookingDocuments(rowsInput=[]){
  return (Array.isArray(rowsInput)?rowsInput:[]).map((row,index)=>normalizeBookingDocument(row,index))
    .filter(row=>row.documentId&&row.ownerType&&row.ownerId)
    .sort((a,b)=>(a.sortOrder-b.sortOrder)||a.documentId.localeCompare(b.documentId))
    .map((row,index)=>({...row,sortOrder:index}));
}

export async function stageTripDocumentFile({tripId:tripIdInput,ownerType='',ownerId='',dayId='',file,title='',sortOrder=0}={}){
  const tripId=clean(tripIdInput), type=clean(ownerType), id=clean(ownerId);
  if(!tripId||!type||!id){ const e=new Error('Invalid document target'); e.code='invalid-document-target'; throw e; }
  assertFile(file);
  const documentId=makeId('doc');
  const fileName=clean(file.name)||`document-${documentId}`;
  const descriptor=normalizeBookingDocument({
    documentId,tripId,ownerType:type,ownerId:id,dayId:clean(dayId),
    title:clean(title)||fileName.replace(/\.[^.]+$/,''),fileName,
    contentType:clean(file.type).toLowerCase(),byteSize:Number(file.size)||0,
    sortOrder,editDraft:true
  },sortOrder);
  stagedFiles.set(documentId,file);
  return descriptor;
}

export function hasStagedTripDocument(documentIdInput=''){ return stagedFiles.has(clean(documentIdInput)); }
export function discardStagedTripDocuments(descriptors=[]){
  (Array.isArray(descriptors)?descriptors:[]).forEach(row=>stagedFiles.delete(clean(row?.documentId)));
}

function uploadBlob(targetRef, blob, metadata={}){
  return new Promise((resolve,reject)=>{
    const task=uploadBytesResumable(targetRef,blob,metadata);
    task.on('state_changed',()=>{},reject,()=>resolve(task.snapshot));
  });
}

export async function uploadTripEditDocuments({tripId:tripIdInput,descriptors=[],user:userInput=null,onProgress=null}={}){
  const tripId=clean(tripIdInput),user=requireUser(userInput);
  try{await flushPendingTripDocumentCleanup({user});}catch(_){}
  if(!tripId){ const e=new Error('Missing tripId'); e.code='invalid-trip-id'; throw e; }
  const rows=(Array.isArray(descriptors)?descriptors:[]).filter(row=>row?.editDraft===true);
  const uploaded=[];
  for(let index=0;index<rows.length;index+=1){
    const row=normalizeBookingDocument(rows[index],index),file=stagedFiles.get(row.documentId);
    if(!file){ const e=new Error('Staged document bytes are missing'); e.code='document-staged-file-missing'; e.documentId=row.documentId; throw e; }
    assertFile(file);
    const storagePath=documentPath(tripId,row.documentId,row.fileName);
    if(typeof onProgress==='function')onProgress({completed:index,total:rows.length,documentId:row.documentId});
    try {
      await uploadBlob(ref(storage,storagePath),file,{contentType:row.contentType||file.type||'application/octet-stream',customMetadata:{tripId,documentId:row.documentId,ownerType:row.ownerType,ownerId:row.ownerId,uploadedBy:user.uid}});
    } catch (error) {
      error.uploadedDescriptors = uploaded.slice();
      throw error;
    }
    const finalized=plainDescriptor({...row,tripId,storagePath,byteSize:file.size,contentType:file.type||row.contentType,uploadedAt:new Date().toISOString(),uploadedBy:user.uid,editDraft:false});
    uploaded.push(finalized);
    stagedFiles.delete(row.documentId);
    if(typeof onProgress==='function')onProgress({completed:index+1,total:rows.length,documentId:row.documentId});
  }
  return uploaded;
}

export async function deleteTripDocuments({descriptors=[],user:userInput=null}={}){
  requireUser(userInput);
  let deleted=0,queued=0;
  for(const row of Array.isArray(descriptors)?descriptors:[]){
    const path=clean(row?.storagePath);
    if(!path)continue;
    try{await deleteObject(ref(storage,path));deleted+=1;}catch(error){
      const code=clean(error?.code);
      if(code==='storage/object-not-found'){deleted+=1;continue;}
      queuePendingCleanup([row]);queued+=1;
    }
  }
  return {deleted,queued};
}

export async function flushPendingTripDocumentCleanup({user:userInput=null}={}){
  requireUser(userInput);
  const rows=pendingCleanupRows();if(!rows.length)return {deleted:0,remaining:0};
  const remaining=[];let deleted=0;
  for(const row of rows){
    const path=clean(row?.storagePath);if(!path)continue;
    try{await deleteObject(ref(storage,path));deleted+=1;}catch(error){const code=clean(error?.code);if(code==='storage/object-not-found')deleted+=1;else remaining.push(row);}
  }
  savePendingCleanupRows(remaining);
  return {deleted,remaining:remaining.length};
}

export async function getTripDocumentBlob(descriptorInput={}){
  const row=normalizeBookingDocument(descriptorInput);
  const path=clean(row.storagePath);
  if(!path){ const staged=stagedFiles.get(row.documentId); if(staged)return staged; const e=new Error('Document Storage path is missing'); e.code='document-path-missing'; throw e; }
  return getBlob(ref(storage,path),MAX_DOCUMENT_BYTES);
}

export async function restoreTripDocumentRecord(recordInput={},blob,{tripId:tripIdInput='',user:userInput=null}={}){
  const user=requireUser(userInput),tripId=clean(tripIdInput||recordInput?.tripId),row=normalizeBookingDocument({...recordInput,tripId});
  if(!tripId||!row.documentId){ const e=new Error('Invalid backup document record'); e.code='backup-document-invalid'; throw e; }
  assertFile(blob);
  const storagePath=documentPath(tripId,row.documentId,row.fileName);
  await uploadBlob(ref(storage,storagePath),blob,{contentType:row.contentType||blob.type||'application/octet-stream',customMetadata:{tripId,documentId:row.documentId,ownerType:row.ownerType,ownerId:row.ownerId,uploadedBy:user.uid}});
  return plainDescriptor({...row,tripId,storagePath,contentType:row.contentType||blob.type,byteSize:blob.size,uploadedAt:row.uploadedAt||new Date().toISOString(),uploadedBy:row.uploadedBy||user.uid,editDraft:false});
}

export async function reconcileTripDocumentStorage({tripId:tripIdInput,wantedPaths=[],user:userInput=null}={}){
  const tripId=clean(tripIdInput); requireUser(userInput);
  if(!tripId)return {removed:0};
  const wanted=new Set((Array.isArray(wantedPaths)?wantedPaths:[]).map(clean).filter(Boolean));
  const root=ref(storage,`trips/${tripId}/documents`); let removed=0;
  try{
    const first=await listAll(root);
    const itemRefs=[...(first.items||[])];
    for(const prefix of first.prefixes||[]){ const nested=await listAll(prefix); itemRefs.push(...(nested.items||[])); }
    for(const itemRef of itemRefs){ const path=clean(itemRef.fullPath); if(!path||wanted.has(path))continue; await deleteObject(itemRef); removed+=1; }
  }catch(error){
    const code=clean(error?.code); if(code!=='storage/object-not-found')throw error;
  }
  return {removed};
}

export const BOOKING_DOCUMENT_MAX_BYTES = MAX_DOCUMENT_BYTES;
