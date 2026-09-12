/** SageBridge Cloudflare Worker entry point. */
import { handleRequest } from './router';
import { corsHeaders, isAllowedOrigin } from './utils/cors';

export interface Env {
  DB: D1Database;
  FIREBASE_PROJECT_ID: string;
  FRONTEND_ORIGINS?: string;
  ENVIRONMENT?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const cors=corsHeaders(request,env);
    if(request.method==='OPTIONS') {
      if(!isAllowedOrigin(request,env)) return new Response(null,{status:403,headers:cors});
      return new Response(null,{status:204,headers:cors});
    }
    try {
      const response=await handleRequest(request,env);
      const headers=new Headers(response.headers);
      Object.entries(cors).forEach(([key,value])=>headers.set(key,value));
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch(error) {
      console.error('Unhandled request failure',error);
      return new Response(JSON.stringify({error:'Internal Server Error',code:'INTERNAL_ERROR'}),{status:500,headers:{'Content-Type':'application/json',...cors}});
    }
  }
};
