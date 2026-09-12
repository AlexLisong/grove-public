import type {Entity} from './types.js';

export type ArticleLocale = 'en'|'zh';
export interface ArticleSite {id:string; name:string; domain:string}
export interface WebsiteArticleMetadata {
  locale:ArticleLocale; slug:string; excerpt:string; category:string; featured:boolean;
  coverImage?:string; siteIds:string[]; date?:string;
}
export interface ArticleSnapshot extends Omit<WebsiteArticleMetadata,'date'> {
  title:string; content:string; tags:string[]; date:string;
}
export interface ArticlePublication {
  siteId:string; locale:ArticleLocale; slug:string; url:string;
  status:'published'|'unpublished'; revision:number; sourceVersion:number; updatedAt:string;
}
export interface ArticleListEntry {entity:Entity; publications:ArticlePublication[]}
export interface ArticleApproval {
  id:string; sourceVersion:number; snapshot:ArticleSnapshot; snapshotHash:string;
  destinations:{siteId:string; url:string}[]; expectedRevisions:Record<string,number>; approvedAt:string;
}
export interface ArticleApproveRequest {version:number}
export interface ArticlePublishRequest {version:number; approvalId:string}
export interface ArticleUnpublishRequest {
  version:number; siteIds:string[];
  /** Use a fresh UUID for each deliberate unpublish; reuse it only for retries. */
  operationId?:string;
  /** Revisions shown in the confirmation dialog; stale destinations return 409. */
  expectedRevisions?:Record<string,number>;
}
export interface ArticleListResponse {articles:ArticleListEntry[]}
export interface ArticleSitesResponse {sites:ArticleSite[]}
export interface ArticleApproveResponse {approval:ArticleApproval}
export interface ArticlePublishResponse {publications:ArticlePublication[]}
export type ArticleUnpublishResponse = ArticlePublishResponse;
