export const ENTITY_KINDS = ['item','board','space','table','creator','creator-list','brand','chat','custom-ai','draft','workflow-run','routine','automation','metric','voice','feed','notification'] as const;
export type EntityKind = typeof ENTITY_KINDS[number];
export type Role = 'owner'|'admin'|'editor'|'viewer';
export interface User {id:string;email:string;name:string}
export interface Workspace {id:string;name:string;role:Role;itemOnly?:boolean}
export interface Preferences {pinnedIds:string[];recentIds:string[];topics:string[];onboardingComplete:boolean;captureBoardId:string|null;library:{tab:'all'|'documents'|'highlights'|'reading'|'favorites'|'media';tag:string;view:'grid'|'list'|'graph';platform:string;source:string}}
export interface Entity {
  id:string; workspaceId:string; kind:EntityKind; title:string; content:string; data:Record<string,any>;
  tags:string[]; starred:boolean; archived:boolean; parentId:string|null; createdAt:string; updatedAt:string; version:number; deletedAt:string|null; createdBy?:string|null; visibility?:'workspace'|'private';
}
export type EntityInput = Partial<Pick<Entity,'title'|'content'|'data'|'tags'|'starred'|'archived'|'parentId'|'visibility'>> & {kind:EntityKind};
export interface Session {user:User;workspaces:Workspace[];workspace:Workspace;csrfToken:string}
export interface Citation {id:string;title:string;url?:string;excerpt?:string}
export interface ChatMessage {role:'user'|'assistant';content:string;citations?:Citation[];createdAt:string}
export interface WorkflowTemplate {id:string;title:string;description:string;icon:string;category:string;duration:string;inputs:string[];prompt:string;steps:string[]}
export interface ConnectorDefinition {id:string;name:string;category:'social'|'research'|'business'|'delivery';description:string;capabilities:string[];auth:'oauth'|'token'|'browser'|'none';docsUrl:string;fields?:{key:string;label:string;secret?:boolean;placeholder?:string}[]}
export interface Connection {id:string;provider:string;label:string;status:'connected'|'unconfigured'|'error'|'expired';capabilities:string[];configured:boolean;lastSyncAt?:string;error?:string;data?:Record<string,any>}
export interface Job {id:string;kind:string;status:'pending'|'running'|'completed'|'failed'|'cancelled';data:Record<string,any>;result?:Record<string,any>;error?:string;runAt:string;attempts:number;createdAt:string}
export type TableColumnType='text'|'number'|'select'|'multi-select'|'date'|'checkbox'|'url'|'relation'|'priority'|'created'|'platform'|'likes'|'views';
export interface TableColumn {id:string;name:string;type:TableColumnType;options?:string[];optionColors?:Record<string,string>;sourceColumnId?:string}
export interface TableRecurrence {frequency:'daily'|'weekday'|'weekly'|'monthly'|'yearly'|'custom';interval:number;unit?:'day'|'week'|'month'|'year';anchor:'scheduled'|'completion';dateColumnId:string;originDate?:string}
export interface TableCompletion {dateColumnId:string;previousDate:string;nextDate:string;previousDone:boolean;completedAt:string;previousRecurrence?:TableRecurrence}
export interface TableRow {id:string;cells:Record<string,any>;itemId?:string|null;relatedItemIds?:string[];createdAt?:string;recurrence?:TableRecurrence;lastCompletion?:TableCompletion}
export interface TableFilter {id:string;columnId:string;operator:'equals'|'contains'|'empty'|'not-empty'|'today'|'overdue'|'next-7-days'|'this-week'|'before'|'after';value?:string}
export type TableLayout='table'|'list'|'kanban'|'calendar'|'gallery';
export interface TableViewSettings {query:string;sortColumnId:string;sortDirection:'asc'|'desc';groupColumnId:string;dateColumnId:string;filters:TableFilter[];laneOrder:string[]}
export interface TableSavedView {id:string;name:string;layout:TableLayout;settings:TableViewSettings}
export interface TableData extends Record<string,any> {columns:TableColumn[];rows:TableRow[];removedRows:TableRow[];view:TableLayout;viewSettings:TableViewSettings;savedViews:TableSavedView[];activeViewId?:string;tableVersion?:number}
export interface BoardPlacement {id:string;x:number;y:number;width?:number;section?:string}
export interface DraftData {platforms:string[];variants:Record<string,string>;status:'draft'|'review'|'approved'|'scheduled'|'publishing'|'published'|'failed';scheduledAt?:string;connectionIds?:string[];mediaIds?:string[];firstComment?:string;receipts?:Record<string,any>[]}
