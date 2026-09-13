/**
 * Beta invoice-email workflow. Sending only ever happens server-side: the
 * mail provider's API key lives in a Worker secret (env.RESEND_API_KEY) and
 * is never returned to the browser. Until that secret is configured this
 * capability is honestly reported as unavailable rather than pretending to
 * send - see getCapabilities/handleEmailInvoice below.
 */
import { Env } from '../index';
import { jsonResponse } from '../utils/response';
import { parseBoundedJson } from '../security/security';
import { buildInvoicePdf } from '../utils/pdf';
import { fetchInvoiceDetail } from './invoices';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getCapabilities(env: Env) {
  return jsonResponse({ email: Boolean(env.RESEND_API_KEY) });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export async function handleEmailInvoice(
  tenantId: string,
  companyId: string,
  id: string,
  request: Request,
  env: Env
): Promise<Response> {
  if (!env.RESEND_API_KEY) {
    return jsonResponse({
      error: 'Email is not configured for this workspace yet.',
      code: 'EMAIL_NOT_CONFIGURED'
    }, 503);
  }

  let body: { to?: unknown; subject?: unknown; message?: unknown };
  try {
    body = await parseBoundedJson(request, 16 * 1024);
  } catch {
    return jsonResponse({ error: 'Malformed JSON' }, 400);
  }

  const invoice = await fetchInvoiceDetail(tenantId, companyId, id, env);
  if (!invoice) return jsonResponse({ error: 'Invoice not found' }, 404);

  const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : invoice.customerEmail;
  if (!to || !EMAIL_RE.test(to)) {
    return jsonResponse({ error: 'A valid recipient email is required (no customer email is on file to default to)' }, 400);
  }

  const label = invoice.invoiceNumber || invoice.sageId;
  const subject = typeof body.subject === 'string' && body.subject.trim() ? body.subject.trim().slice(0, 200) : `Invoice ${label}${invoice.companyName ? ` from ${invoice.companyName}` : ''}`;
  const message = typeof body.message === 'string' ? body.message.slice(0, 5000) : `Please find attached invoice ${label}.`;

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await buildInvoicePdf(invoice);
  } catch (error) {
    console.error('Failed to build invoice PDF for email:', error);
    return jsonResponse({ error: 'Failed to generate the invoice PDF' }, 500);
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'SageBridge <invoices@sagebridge.app>',
        to: [to],
        subject,
        text: message,
        attachments: [{
          filename: `invoice-${label}.pdf`,
          content: bytesToBase64(pdfBytes)
        }]
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('Email provider rejected the send:', response.status, detail);
      return jsonResponse({
        error: 'The email provider rejected the send. Nothing was delivered.',
        code: 'EMAIL_SEND_FAILED'
      }, 502);
    }

    return jsonResponse({ sent: true, to });
  } catch (error) {
    console.error('Failed to reach email provider:', error);
    return jsonResponse({
      error: 'Could not reach the email provider. Nothing was delivered.',
      code: 'EMAIL_SEND_FAILED'
    }, 502);
  }
}
