import type {ArticleSite} from '../shared/articles.js';

/** Installation-owned destinations; never infer them from a client request. */
export function parseArticleSites(value:string|undefined):readonly ArticleSite[] {
  if(!value) return [];
  const entries:unknown=JSON.parse(value);
  if(!Array.isArray(entries) || entries.length>20) throw new Error('WEBSITE_PUBLISHING_SITES must be an array of at most 20 destinations.');
  const ids=new Set<string>(),domains=new Set<string>();
  return entries.map((entry:unknown)=>{
    if(!entry || typeof entry!=='object') throw new Error('Invalid publishing destination.');
    const {id,name,domain}=entry as Record<string,unknown>;
    if(typeof id!=='string' || !/^[a-z][a-z0-9_]{0,39}$/.test(id) || ids.has(id)) throw new Error('Publishing IDs must be unique lowercase identifiers.');
    if(typeof name!=='string' || !name.trim() || name.length>100) throw new Error('Publishing names must contain 1–100 characters.');
    if(typeof domain!=='string' || domain.length>253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) || domains.has(domain)) throw new Error('Publishing domains must be unique lowercase DNS names without a scheme or path.');
    ids.add(id);domains.add(domain);
    return {id,name:name.trim(),domain};
  });
}
