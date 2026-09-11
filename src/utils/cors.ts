import type { Env } from '../index';

const BASE = {
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Company-Id',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
};

export function corsHeaders(request: Request, env: Env): Record<string,string> {
  const origin=request.headers.get('origin');
  if(!origin) return {...BASE};
  const allowed=(env.FRONTEND_ORIGINS??'').split(',').map(x=>x.trim()).filter(Boolean);
  return allowed.includes(origin) ? {...BASE,'Access-Control-Allow-Origin':origin} : {...BASE};
}

export function isAllowedOrigin(request: Request, env: Env) {
  const origin=request.headers.get('origin');
  return !origin || (env.FRONTEND_ORIGINS??'').split(',').map(x=>x.trim()).includes(origin);
}
