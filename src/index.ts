/** SageBridge Cloudflare Worker entry point. */
import { handleRequest } from './router';
import { corsHeaders, isAllowedOrigin } from './utils/cors';

export interface Env {
  DB: D1Database;
  FIREBASE_PROJECT_ID: string;
  FRONTEND_ORIGINS?: string;
  ENVIRONMENT?: string;
  /** Human release label for this deploy target, e.g. "beta1-rc1". Set in wrangler.toml [vars] deliberately per environment - not a secret. */
  RELEASE?: string;
  /** API contract version (route/shape compatibility), e.g. "v1". Not tied to git history. */
  API_VERSION?: string;
  /** Highest migration this deployed code expects to already be applied, e.g. "0006". Bumped by hand alongside new migrations - see docs/BETA1_D1_SETUP.md. */
  SCHEMA_VERSION?: string;
  /**
   * Git commit SHA of the deployed build. Must be injected at deploy time
   * (e.g. `wrangler deploy --var BUILD_SHA:$(git rev-parse HEAD)`), never
   * hand-edited in wrangler.toml - a manually maintained value here would
   * silently go stale the next time someone deploys without updating it.
   * Absent (undefined) means "not injected this deploy" and must render as
   * "unknown", never a guessed or cached value.
   */
  BUILD_SHA?: string;
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
