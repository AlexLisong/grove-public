import {createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Agent, fetch as undiciFetch} from 'undici';
import ipaddr from 'ipaddr.js';

export function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), {status, code, expose:true});
}
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function constantEqual(a: string, b: string) {
  const aa = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(aa, bb);
}

function encryptionKey() {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw || !/^[a-f\d]{64}$/i.test(raw)) throw httpError(503, 'Secret storage is not configured.', 'ENCRYPTION_UNCONFIGURED');
  return Buffer.from(raw, 'hex');
}
export function encryptSecret(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function decryptSecret(text: string) {
  const [version, iv, tag, ciphertext] = text.split('.');
  if (version !== 'v1' || !iv || !tag || ciphertext === undefined) throw httpError(500, 'Invalid encrypted secret.', 'SECRET_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

export function isPublicAddress(value: string): boolean {
  try {
    const parsed = ipaddr.process(value);
    // ipaddr classifies private, loopback, link-local, CGNAT, multicast, reserved,
    // documentation, IPv4-mapped IPv6, transition and unique-local ranges.
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export async function validateRemoteUrl(raw: string): Promise<{url: URL; address: string; family: number}> {
  let url: URL;
  try { url = new URL(raw); } catch { throw httpError(400, 'Enter a valid HTTP or HTTPS URL.', 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) {
    throw httpError(400, 'Only public HTTP or HTTPS URLs on standard ports are supported.', 'UNSAFE_URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || /(^|\.)(localhost|local|internal|test|invalid)$/i.test(hostname)) throw httpError(400, 'Private network URLs are not allowed.', 'UNSAFE_URL');
  let dnsTimer:ReturnType<typeof setTimeout>|undefined;
  const addresses = isIP(hostname) ? [{address: hostname, family: isIP(hostname)}] : await Promise.race([
    lookup(hostname, {all:true,verbatim:true}).catch(() => {throw httpError(400,'The remote host could not be resolved.','URL_DNS');}),
    new Promise<never>((_resolve,reject) => {dnsTimer=setTimeout(() => reject(httpError(408,'The remote host lookup timed out.','REMOTE_TIMEOUT')),10_000);dnsTimer.unref();}),
  ]).finally(() => {if(dnsTimer) clearTimeout(dnsTimer);});
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw httpError(400, 'Private or reserved network URLs are not allowed.', 'UNSAFE_URL');
  url.hash = '';
  return {url, ...addresses[0]};
}

export interface SafeFetchInit extends RequestInit {maxBytes?: number; timeoutMs?: number; maxRedirects?: number}
export function assertSafeRedirect(from:string,to:string,headers:Headers,body?:BodyInit|null) {
  if(new URL(from).origin===new URL(to).origin) return;
  if(body!=null || [...headers.keys()].some(key=>/authorization|cookie|api.?key|token|secret|subscription-key/i.test(key))) throw httpError(502,'A credentialed provider request redirected to a different origin.','CREDENTIAL_REDIRECT');
}
export async function safeFetch(raw: string, init: SafeFetchInit = {}): Promise<Response> {
  const {maxBytes = 8 * 1024 * 1024, timeoutMs = 15_000, maxRedirects = 4, ...requestInit} = init;
  const deadline = AbortSignal.timeout(Math.min(timeoutMs, 60_000));
  const signal = requestInit.signal ? AbortSignal.any([deadline, requestInit.signal]) : deadline;
  let current = raw;
  let method = (requestInit.method || 'GET').toUpperCase();
  let body = requestInit.body;
  let headers = new Headers(requestInit.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', 'Grove/1.0 (user-requested content capture)');
  let initialOrigin:string;
  try {initialOrigin=new URL(raw).origin;} catch {throw httpError(400,'Enter a valid HTTP or HTTPS URL.','INVALID_URL');}
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const validated = await validateRemoteUrl(current);
    // Each request pins its already-validated DNS result; the HTTP client cannot
    // resolve a second address after the public-address check (DNS rebinding).
    const dispatcher = new Agent({connect: {
      timeout: Math.min(timeoutMs, 15_000),
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{address: validated.address, family: validated.family}] as any);
        else callback(null, validated.address, validated.family);
      },
    }});
    let response: Awaited<ReturnType<typeof undiciFetch>> | undefined;
    try {
      response = await undiciFetch(validated.url, {...requestInit, method, body: body as any, headers: Array.from(headers.entries()), signal, redirect: 'manual', dispatcher});
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw httpError(400, 'The remote redirect has no destination.', 'URL_REDIRECT');
        if (redirects === maxRedirects) throw httpError(400, 'Too many remote redirects.', 'URL_REDIRECT');
        current = new URL(location, validated.url).href;
        if (new URL(current).origin !== initialOrigin) {
          // A 307/308 can replay the original request body. OAuth forms and
          // connector payloads may contain credentials even without an
          // Authorization header, so never replay them to another origin.
          assertSafeRedirect(initialOrigin,current,headers,body);
          headers.delete('authorization'); headers.delete('cookie'); headers.delete('proxy-authorization');
        }
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {method = 'GET'; body = undefined; headers.delete('content-type'); headers.delete('content-length');}
        continue;
      }
      const length = Number(response.headers.get('content-length') || 0);
      if (length > maxBytes) {await response.body?.cancel(); throw httpError(413, 'Remote content is too large.', 'REMOTE_TOO_LARGE');}
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > maxBytes) {await response.body.cancel().catch(() => {}); throw httpError(413, 'Remote content is too large.', 'REMOTE_TOO_LARGE');}
        chunks.push(chunk);
      }
      const resultHeaders = new Headers(response.headers);
      resultHeaders.delete('content-encoding'); resultHeaders.delete('transfer-encoding'); resultHeaders.set('content-length', String(total));
      const result = new Response([204,205,304].includes(response.status) || method === 'HEAD' ? null : Buffer.concat(chunks), {status: response.status, statusText: response.statusText, headers: resultHeaders});
      Object.defineProperty(result, 'url', {value: validated.url.href});
      return result;
    } catch (error: any) {
      if (error.status) throw error;
      if (signal.aborted) throw httpError(408, 'The remote request timed out.', 'REMOTE_TIMEOUT');
      throw httpError(502, 'The remote page could not be fetched.', 'REMOTE_FETCH');
    } finally { await dispatcher.close(); }
  }
  throw httpError(400, 'Too many remote redirects.', 'URL_REDIRECT');
}
