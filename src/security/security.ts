export class HttpError extends Error { status:number;code:string;constructor(status:number,message:string,code='BAD_REQUEST'){super(message);this.status=status;this.code=code} }
const te=new TextEncoder();
export function bytesToHex(bytes:ArrayBuffer){return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function hashSecret(secret:string):Promise<string>{return bytesToHex(await crypto.subtle.digest('SHA-256',te.encode(secret)))}
export function randomSecret(bytes=32):string{const b=new Uint8Array(bytes);crypto.getRandomValues(b);return btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
export async function parseBoundedJson<T=unknown>(request:Request,maxBytes=64*1024):Promise<T>{
 const length=request.headers.get('content-length'); if(length&&Number(length)>maxBytes) throw new HttpError(413,'Request body too large','PAYLOAD_TOO_LARGE');
 const buf=await request.arrayBuffer();if(buf.byteLength>maxBytes)throw new HttpError(413,'Request body too large','PAYLOAD_TOO_LARGE');
 try{return JSON.parse(new TextDecoder().decode(buf)) as T}catch{throw new HttpError(400,'Malformed JSON','INVALID_JSON')}
}
export const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function requiredString(v:unknown,name:string,max=200){if(typeof v!=='string'||!v.trim()||v.length>max)throw new HttpError(400,`${name} must be a non-empty string of at most ${max} characters`);return v.trim()}
export function validatePairingCode(v:unknown):v is string{return typeof v==='string'&&/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(v)}
export function connectorIsStale(lastSeen:string|null,seconds=120,now=Date.now()){
 const parsed=lastSeen&&/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(lastSeen)
   ? Date.parse(lastSeen.replace(' ','T')+'Z')
   : lastSeen?Date.parse(lastSeen):NaN;
 return !lastSeen||!Number.isFinite(parsed)||now-parsed>seconds*1000;
}
export function bearer(request:Request){const h=request.headers.get('authorization');const m=h?.match(/^Bearer ([^\s]+)$/);return m?.[1]}
