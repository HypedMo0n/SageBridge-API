import { HttpError } from './security.ts';
export interface FirebaseClaims {iss:string;aud:string;sub:string;exp:number;iat:number;auth_time:number;email?:string;name?:string;email_verified?:boolean;[key:string]:unknown}
type FirebaseJwk=JsonWebKey&{kid?:string};
type Options={fetch?:typeof fetch;now?:()=>number;keysUrl?:string};
const cache=new Map<string,{until:number;keys:Record<string,JsonWebKey|string>}>();
const decode=(s:string)=>{try{return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))))}catch{throw new HttpError(401,'Malformed bearer token','INVALID_TOKEN')}};
function pemBytes(pem:string){const b64=pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');return Uint8Array.from(atob(b64),c=>c.charCodeAt(0))}
export async function verifyFirebaseJwt(jwt:string,projectId:string,options:Options={}):Promise<FirebaseClaims>{
 const pieces=jwt.split('.');if(pieces.length!==3)throw new HttpError(401,'Malformed bearer token','INVALID_TOKEN');
 const header=decode(pieces[0]) as {alg?:unknown;kid?:unknown};if(header.alg!=='RS256'||typeof header.kid!=='string'||!header.kid)throw new HttpError(401,'Invalid JWT header','INVALID_TOKEN');
 const now=(options.now?.()??Math.floor(Date.now()/1000));const url=options.keysUrl??'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';let entry=cache.get(url);
 if(!entry||entry.until<=now){const response=await (options.fetch??fetch)(url);if(!response.ok)throw new HttpError(503,'Identity key service unavailable','AUTH_KEYS_UNAVAILABLE');const payload=await response.json() as Record<string,JsonWebKey|string>|{keys:FirebaseJwk[]};const keys='keys' in payload&&Array.isArray(payload.keys)?Object.fromEntries(payload.keys.filter(k=>k.kid).map(k=>[String(k.kid),k])):payload as Record<string,JsonWebKey|string>;const maxAge=Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1]??300);entry={keys,until:now+Math.max(60,Math.min(maxAge,3600))};cache.set(url,entry)}
 const material=entry.keys[header.kid];if(!material)throw new HttpError(401,'Unknown JWT signing key','INVALID_TOKEN');
 const key=await crypto.subtle.importKey(typeof material==='string'?'spki':'jwk',typeof material==='string'?pemBytes(material):material,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 const signature=Uint8Array.from(atob(pieces[2].replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`));if(!valid)throw new HttpError(401,'Invalid JWT signature','INVALID_TOKEN');
 const c=decode(pieces[1]) as FirebaseClaims;const issuer=`https://securetoken.google.com/${projectId}`;
 if(c.iss!==issuer||c.aud!==projectId||typeof c.sub!=='string'||!c.sub||c.sub.length>128||!Number.isFinite(c.exp)||c.exp<=now||!Number.isFinite(c.iat)||c.iat>now+30||!Number.isFinite(c.auth_time)||c.auth_time>now+30)throw new HttpError(401,'Invalid Firebase token claims','INVALID_TOKEN');return c;
}
