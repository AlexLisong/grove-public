# Grove implementation contract

2026-09-05. Independent implementation informed by Eden public documentation and signed-in UI. Never seed copied account content or fabricate connector results.

## HTTP
JSON `/api`; same origin. Success object shapes below; errors `{error:string,code?:string,details?:unknown}`. Session cookie HttpOnly, SameSite Lax, secure in prod. Mutations require `X-CSRF-Token` from GET `/api/auth/me`; bearer tokens use explicit scopes. `X-Workspace-Id` chooses a workspace after membership check. All dates ISO UTC, IDs UUID. Entity types in `shared/types.ts`.

- GET `/auth/config` → `{registrationRequiresCode:true}`.
- POST `/auth/register` `{name,email,password,code}` → Session; POST `/auth/login` `{email,password}` → Session. Logout POST. GET `/auth/me` → Session.
- GET `/workspaces`; POST `/workspaces` `{name}`; PATCH `/workspaces/:id` `{name}`; members GET, invite POST `{email,role}` returns manual shareable invitation URL (no email sent); accept POST `/invitations/accept` `{token}`.
- GET `/entities?kind=&q=&tag=&parentId=&starred=&archived=&trash=` → `{entities:Entity[]}` (limit2000). GET `/entities/:id` → `{entity}`. POST `/entities` EntityInput → `{entity}`. PATCH `/entities/:id` partial plus optional `version` optimistic check → `{entity}`. DELETE soft-deletes; POST `/:id/restore`; GET `/:id/history`; POST `/:id/history/:version/restore`. Data nested updates replace `data`, client sends full merged object. Backend MUST prevent clients assigning server-controlled fields (draft publish receipts/status, run results) through generic CRUD.
- POST `/entities/:id/duplicate` → `{entity}`. POST `/entities/:id/share` `{enabled,allowDuplicate}` → `{url,token}`. GET `/public/:token` → public board/item, referenced entities only; POST `/public/:token/duplicate` requires auth. GET/POST `/entities/:id/comments` `{content}`; DELETE `/comments/:id` own/owner only.
- POST `/uploads` multipart file → `{entity}`; GET `/files/:id` authorized stream. POST `/capture` `{url,title?,content?,tags?}` → `{entity}`. POST `/imports` multipart file + format auto|markdown|csv|json|enex|html → `{entities,count}`. GET `/export?format=json|markdown` → attachment. No arbitrary unbounded remote fetch.

## Root-owned service endpoints
- GET `/catalog` → `{workflows:WorkflowTemplate[],connectors:ConnectorDefinition[],ai:{configured,model,images,transcription}}`.
- POST `/ai/chat` `{chatId?,message,sourceIds?,customAiId?,mode?}` → `{entity,message:ChatMessage}`. POST `/ai/generate` `{action,input,sourceIds?,platform?,customAiId?}` → `{text,citations}`. POST `/ai/image` `{prompt,size?}` → `{entity}`. POST `/ai/transcribe/:id` → `{entity}`. AI availability errors are explicit503.
- POST `/workflows/:id/run` `{input,sourceIds?,customAiId?}` → `{job,entity}`; GET `/jobs` → `{jobs}`; GET `/jobs/:id` → `{job}`. Runs persist outputs as documents and workflow-run data. Routines CRUD entities; root worker schedules based data `{workflowId,input,sourceIds,cron,timezone,enabled,nextRunAt}`.
- GET `/connections` → `{connections}`; POST `/connections/:provider` `{label,credentials:{...},config:{...}}` stores encrypted values + verifies via provider; DELETE `/connections/:id`; POST `/:id/sync`; GET `/oauth/:provider/start?workspaceId=` → redirect only if provider configured. Root implements provider activation docs and actual adapters.
- POST `/discover/search` `{query,platform?,mode?,minOutlier?,maxFollowers?}` → `{entities,source,warnings}` from connected/API/imported data. POST `/discover/import` `{posts:[...]}` explicit metrics CSV/JSON ingestion with provenance and no generated metrics.
- GET `/analytics?from=&to=` → `{totals,series,platforms,topPosts,hasData}`. POST `/analytics/import` `{metrics:[...]}`; POST `/analytics/sync`.
- POST `/drafts/:id/transition` `{status:'review'|'approved'|'draft'|'scheduled',scheduledAt?,connectionIds?}` → `{entity}`. POST `/drafts/:id/publish` → `{job}` explicit user action only. Worker must never publish unapproved draft. POST `/drafts/:id/variants` `{platforms}` generates saved variants.
- POST `/automations/:id/test` `{event:{...}}` simulation only → `{matched,actions}`. GET/POST `/webhooks/:provider` validated subscription/signature handles real opted-in automation delivery.
- GET `/tokens`; POST `/tokens` `{name,scopes}` → `{token,id}` once; DELETE `/tokens/:id`. Root `/mcp` JSON-RPC streamable HTTP with bearer scoped tokens and tool catalog. OAuth metadata/consent planned for remote-client interoperability.

## Backend exports (agent-owned server/core)
- `db.ts`: `pool` pg.Pool, `query<T>(text,params?) → Promise<T[]>`, `migrate()`, `closeDb()`.
- `auth.ts`: `requireAuth` Express middleware; `requireEditor` middleware; `req.auth: {userId,workspaceId,role,sessionId?,scopes?:string[]}`; `authRouter` mounted `/api`. `assertAccess(workspaceId,userId)` if useful. `csrfProtection` global middleware; skips login/register, provider signed webhooks, bearer API calls only.
- `entities.ts`: `entityRouter` mounted `/api`; `listEntities(workspaceId,filters?)`, `getEntity(workspaceId,id,includeDeleted?)`, `createEntity(workspaceId,input)`, `updateEntity(workspaceId,id,patch)`, `deleteEntity(workspaceId,id)` async return mapped Entities. Internal functions trusted root services can change server-controlled fields; router validates user changes. `filters` object optional kind/q/tag/parentId/starred/archived/trash.
- `files.ts`: `fileRouter` mounted `/api`; `saveFile(workspaceId,{buffer,name,mime}) → Promise<Entity>`, `readFile(workspaceId,id) → Promise<{buffer:Buffer,mime:string,name:string}>`.
- `security.ts`: `safeFetch(url,init?) → Promise<Response>` public http(s) only, every redirect/IP checked and pinned, timeout,size cap; `encryptSecret(text)`, `decryptSecret(text)` AES-GCM; `httpError(status,message,code?)` Error with status.
- `jobs.ts`: `enqueue(workspaceId,kind,data,runAt?,dedupeKey?) → Job`; `claimJob() → Job & {workspaceId:string}|null` uses SKIP LOCKED and lease; `finishJob(id,result)`, `failJob(id,error)`, `jobRouter` mounted `/api`. No auto retries for uncertain publishing results.
- migrations include tables for users,sessions,workspaces,memberships,entities,entity_history,comments,shares,invitations,files,jobs,connections,api_tokens. Root may add migrations for provider/oauth state.
- connections schema `id uuid,workspace_id uuid,provider text,label text,credentials text encrypted,data jsonb,status text,created_at timestamptz,updated_at timestamptz`; tokens `id uuid,workspace_id uuid,user_id uuid,name text,token_hash text,scopes jsonb,created_at timestamptz,last_used_at timestamptz`.
- root owns server/index.ts, catalog.ts, ai.ts, integrations.ts, publishing.ts, worker.ts, mcp.ts and tests for these. Agent owns server/core/** plus tests/core.test.ts. Frontend agent owns src/**, index.html, public/**.

## Security constraints
Tenant isolation on all reads/writes/files/search/MCP/jobs. SQL parameters. Zod/input limits. Rate-limited login+AI. No public open signup without private invite code. No leaked connector credentials. URL imports defend SSRF and redirects. Preview markdown sanitized (no rawHTML). Explicit draft approval, unique job dedupe, uncertain sends require human retry. File size/type bounds. Only server job writes success receipts. No secrets in git/browser JS. No live social posting during tests.


## Personal workspace preferences

`GET /api/preferences` returns `{preferences}` scoped to the current account and workspace. `PATCH /api/preferences` merges topics, onboarding completion, capture destination and partial library filters. `POST /api/preferences/items/:id` accepts `{action: "pin" | "unpin" | "open"}` and validates current item access. Mutation routes require `workspace:write` for API tokens; signed-in viewers and item guests may manage their personal UI preferences. Pins and history never change shared entity data.

Capture and multipart uploads accept optional `parentId`, enforced before saving and on the new entity. Their contents inherit the destination's access boundary.

See [durable workflows](workflows.md) for saved setup, structured output and deep research contracts.

## Editor, reader and table release

`GET /api/reader/:id/state` and `PATCH /api/reader/:id/state` address personal state for the authenticated user in the selected workspace. State fields are `progress` (0–1), `chapter` (zero-based), `scrollTop`, `rate` (0.5–3), `voice`, `highlightColor` and `notes` (up to100,000 characters). Partial writes merge atomically. The source must remain readable; session viewers/item guests can save their own state. API tokens need `workspace:read` and, for PATCH, `workspace:write`. Saving state does not edit the source entity.

`GET /api/entities/:id/backlinks` returns currently readable incoming links. `data.entityLinks` stores document mention/table UUIDs; `data.editorJSON` stores the structured document. Unsupported rich blocks use `{type:"rawMarkdown",attrs:{markdown:"..."}}` and preserve their source. New reference IDs require access; retained unavailable IDs remain disabled placeholders. Public copies flatten original workspace references into authored labels and do not import private linked content.

Multipart `POST /api/uploads` accepts optional `visibility: private|workspace` in addition to a destination `parentId`. Voice capture explicitly uploads privately, then invokes the existing authenticated `/api/ai/transcribe/:id` route. Retrying transcription reuses the uploaded item. Transcript insertion never sends a chat automatically.

Tables retain `columns` and `rows`, with optional `tableVersion:2`, row item/relation IDs, recurrence, named views and view settings. Supported property types are text, number, select, multi-select, date, checkbox, URL, relation, priority, created, platform, likes and views. Computed values are derived from readable linked entities. API/MCP validation rejects malformed stored cells and newly inaccessible references. MCP partial row updates merge supplied cells; use `null` to clear a value. Removing columns cleans their dependent cells/settings. Public table representations omit removed rows, completion history, orphan cells, relation IDs and stored computed fields.

Browser document/table drafts use workspace/user/item-scoped recovery storage and optimistic versions. A newer server version requires an explicit recovery choice; unavailable browser storage is reported. These recovery records are local drafts, not an offline synchronization engine.
