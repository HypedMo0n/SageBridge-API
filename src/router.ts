import type { Env } from './index';
import { jsonResponse } from './utils/response';
import { HttpError } from './security/security';
import { requireCompanyAccess, requireConnector, requireUser } from './security/access';
import { handleHealth } from './handlers/health';
import { handleGetCustomers,handleGetCustomer,handleCreateCustomer } from './handlers/customers';
import { handleGetInvoices,handleGetInvoice,handleCreateInvoice } from './handlers/invoices';
import { handleGetProducts } from './handlers/products';
import { handleCreateQuote } from './handlers/quotes';
import { handleSyncCustomers,handleSyncInvoices,handleSyncProducts,handleSyncQuotes,handleSyncInvoiceSummary } from './handlers/sync';
import { handleGetJob } from './handlers/jobs';
import { handleGetConnectorJobs,handleStartJob,handleJobResult } from './handlers/connector';
import { createCompany,createPairing,exchangePairing,handleBootstrap,handleCompanies,handleMe,handleOrganizations,heartbeat,listConnectors,provisioning,revokeConnector,startProvisioning,updateProvisioning } from './handlers/phase1';

const capture=(path:string,re:RegExp)=>path.match(re)?.[1];

async function routeRequest(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url), path=url.pathname, method=request.method;
    if(path==='/health'&&method==='GET') return handleHealth(env);
    if((path==='/connector/pairing/validate'||path==='/auth/pairing/exchange')&&method==='POST') return exchangePairing(request,env,request.headers.get('cf-connecting-ip')??'unknown');

    if(path.startsWith('/connector/')||path.startsWith('/sync/')) {
      const connector=await requireConnector(request,env);
      if(path==='/connector/heartbeat'&&method==='POST') return heartbeat(request,connector,env);
      if(path==='/connector/provisioning'&&method==='POST') return updateProvisioning(request,connector,env);
      if(path==='/connector/jobs'&&method==='GET') return handleGetConnectorJobs(connector.organizationId,connector.companyId,env,connector.connectorId);
      let id=capture(path,/^\/connector\/jobs\/([\w-]+)\/start$/);
      if(id&&method==='POST') return handleStartJob(id,connector.organizationId,connector.companyId,env,connector.connectorId);
      id=capture(path,/^\/connector\/jobs\/([\w-]+)\/result$/);
      if(id&&method==='POST') return handleJobResult(id,connector.organizationId,connector.companyId,request,env,connector.connectorId);
      if(path==='/sync/customers'&&method==='POST') return handleSyncCustomers(request,env,connector.organizationId,connector.companyId,connector.connectorId);
      if(path==='/sync/invoices'&&method==='POST') return handleSyncInvoices(request,env,connector.organizationId,connector.companyId,connector.connectorId);
      if(path==='/sync/products'&&method==='POST') return handleSyncProducts(request,env,connector.organizationId,connector.companyId,connector.connectorId);
      if(path==='/sync/quotes'&&method==='POST') return handleSyncQuotes(request,env,connector.organizationId,connector.companyId,connector.connectorId);
      if(path==='/sync/invoice-summary'&&method==='POST') return handleSyncInvoiceSummary(request,env,connector.organizationId,connector.companyId,connector.connectorId);
      return jsonResponse({error:'Not Found',code:'NOT_FOUND'},404);
    }

    const user=await requireUser(request,env);
    if(path==='/auth/bootstrap'&&method==='POST') return handleBootstrap(user,env);
    if(path==='/auth/me'&&method==='GET') return handleMe(user,env);
    if(path==='/api/organizations'&&method==='GET') return handleOrganizations(user,env);
    let id=capture(path,/^\/api\/organizations\/([\w-]+)\/companies$/);
    if(id&&method==='GET') return handleCompanies(user,id,env);
    if(id&&method==='POST') return createCompany(request,user,id,env);
    id=capture(path,/^\/api\/companies\/([\w-]+)\/pairing-codes$/);
    if(id&&method==='POST') return createPairing(request,user,id,env);
    id=capture(path,/^\/api\/companies\/([\w-]+)\/connectors$/);
    if(id&&method==='GET') return listConnectors(user,id,env);
    id=capture(path,/^\/api\/companies\/([\w-]+)\/provisioning$/);
    if(id&&method==='GET') return provisioning(user,id,env);
    if(id&&method==='POST') return startProvisioning(user,id,env);
    id=capture(path,/^\/(?:api\/)?connectors\/([\w-]+)\/revoke$/);
    if(id&&method==='POST') return revokeConnector(user,id,env);

    const company=request.headers.get('x-company-id');
    if(!company) throw new HttpError(400,'X-Company-Id is required','COMPANY_REQUIRED');
    const access=await requireCompanyAccess(user.userId,company,env), org=access.organization_id;
    if(path==='/api/customers'&&method==='GET') return handleGetCustomers(org,company,env);
    id=capture(path,/^\/api\/customers\/([\w-]+)$/);
    if(id&&method==='GET') return handleGetCustomer(org,company,id,env);
    if(path==='/api/customers'&&method==='POST') return handleCreateCustomer(org,company,request,env);
    if(path==='/api/invoices'&&method==='GET') return handleGetInvoices(org,company,env);
    id=capture(path,/^\/api\/invoices\/([\w-]+)$/);
    if(id&&method==='GET') return handleGetInvoice(org,company,id,env);
    if(path==='/api/invoices'&&method==='POST') return handleCreateInvoice(org,company,request,env);
    if(path==='/api/products'&&method==='GET') return handleGetProducts(org,company,env);
    if(path==='/api/quotes'&&method==='POST') return handleCreateQuote(org,company,request,env);
    id=capture(path,/^\/api\/jobs\/([\w-]+)$/);
    if(id&&method==='GET') return handleGetJob(id,org,company,env);
    return jsonResponse({error:'Not Found',code:'NOT_FOUND',path,method},404);
}

export async function handleRequest(request:Request,env:Env):Promise<Response>{
  try {
    return await routeRequest(request,env);
  } catch(error) {
    const e=error instanceof HttpError?error:new HttpError(500,'Internal Server Error','INTERNAL_ERROR');
    return jsonResponse({error:e.message,code:e.code},e.status);
  }
}
