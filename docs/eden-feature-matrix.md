# Eden public feature inventory and implementation contract
Captured 2026-09-05 from official public pages. This is behavioral research, not a claim that any clone is implemented or that Eden’s internals have been inspected. The app’s authenticated UI is being inspected separately by the root agent. No public skill was installed or executed.
Coverage: 187 cached official page URLs (some anchors/duplicates), 106 feature acceptance entries across 18 groups, and 74 publicly named MCP tools. Sources/data: `/tmp/eden-public-pages.json`, `/tmp/eden-help-clean.txt`, `/tmp/eden-llms-full.txt`, `/tmp/eden-openapi.json`, `/tmp/eden-features.json`.
## What “all features” means
Eden is a creator knowledge workspace plus social/ad research corpus, AI orchestration, multi-platform publisher, analytics warehouse, business integrations and account/device bridges. The five `/workflows/` cards are only one layer. A working UI or a prompt library does not establish full parity. A parity claim needs each acceptance row below exercised with real data and real credentials, or explicitly marked pending.
Public evidence is broad but does not expose production schemas, moderation, retry policies, provider contracts, licensed corpora, exact creator-baseline windows, account security implementation, or every paid UI state. Acceptance criteria below are proposed observable equivalents; implementation choices and provider dependencies are inferred where named.
## Implementation boundaries that matter immediately
- **Corpus is the hardest dependency.** Eden claims 3M+ indexed social posts across seven platforms and 100K+ ads. Public creator data does not imply an unrestricted commercial API. A new service needs authorized data access, storage/refresh jobs, deduplication, identity resolution, metrics history and semantic indexing. Sample content may demonstrate UI but must be labelled sample.
- **Publishing has eight destinations:** X, Threads, YouTube Shorts, Instagram, TikTok, LinkedIn, Facebook Pages and Substack. Research lists seven: X, Threads, YouTube, Instagram, TikTok, LinkedIn and Substack. Some pages incorrectly say six while naming seven.
- **Substack cannot be implemented as a normal server-only publisher.** Its documented Eden bridge uses the user’s signed-in extension/desktop/mobile session. Text notes/articles hand off to native scheduler; threads/image notes need live browser at slot. A web-only Azure app cannot truthfully claim this works without a companion bridge or a separately supported integration.
- **Instagram Saves also needs a local companion.** It reads selected collections from signed-in user device, not a server token. User’s Instagram password/session stays local.
- **Meta Ads and Canva business connectors are explicitly “coming soon.”** Do not count those as available Eden parity requirements. Ad research from transparency data is already advertised separately. Windows is also coming soon; iOS/Android are beta.
- **Evidence quality is part of the workflow.** No fabricated posts, creators, baseline metrics, saved items or publishing results. Syncing metrics are unknown, not zero. Own content performance never substitutes for market evidence.
- **Public API metadata is incomplete and internally inconsistent.** `/openapi.json` says `toolCount: 71` but lists 74 names/tools. It defines MCP/auth/health HTTP routes, not the per-tool input schemas; those require MCP `tools/list` from an authorized connection.
## Dependency register
Codes in the matrix refer to these implementation requirements. Except explicitly documented platform/account constraints, the infrastructure/provider selection is an implementation inference. Existing user subscriptions/API keys must be inventoried by the root; this research does not claim any are available.
| Code | Needed capability / account | Constraint or observable requirement |
|---|---|---|
| DB | Durable tenant-scoped database | Items, boards, canvas, chats, sharing, jobs, billing ledger, analytics. SQLite local-only is not sufficient for multi-instance service without an appropriate durable design. |
| AUTH | Identity/session and app OAuth | User signup/login, invite access, RBAC, safe share tokens and MCP read/write consent. |
| BLOB | Private object storage | User uploads, original files, derived previews, permitted saved creatives, export archives; signed expiring URLs. Azure Blob is a natural deployment option. |
| JOBS | Durable job queue and scheduler | Ingest, sync, media, routines, analytics, export, notifications and publisher; retries, idempotency, timezone, concurrency and status. |
| LLM / EMBEDDINGS | Paid model and embedding APIs | Grounded generation, tool calls, semantic search, voice, entity extraction. Azure OpenAI or other configured provider; tokens are not supplied by a Codex subscription. |
| SOCIAL_CORPUS | Authorized social data access for seven networks | Research, handles, identity linking, historical metrics, transcripts, format taxonomy, baseline calculation and large index. Eden does not publicly disclose every upstream vendor. |
| AD_CORPUS | Authorized Meta Ad Library / TikTok top-ads access | Advertiser resolution, creative variants, run history and permitted archiving. Running duration is a proxy for continued spend, not verified profit or conversions. |
| SOCIAL_PUBLISH | Developer apps or multi-network publishing provider | Each platform’s OAuth scopes, app approval/quota and eligible account; IG Business/Creator, FB Page, YouTube Shorts (long-form explicitly unsupported). |
| SOCIAL_ANALYTICS | Authorized connected-account analytics access | Private impressions/saves/watch time/email opens only where granted; historical backfill limits and per-platform metric definitions. |
| INSTAGRAM_MESSAGING | Meta Instagram messaging API and webhooks | Business/Creator eligibility, messaging permissions/app review, privacy windows/rate limits, verified webhook signatures; actual messages need user-configured automation. |
| SUBSTACK_LOCAL / INSTAGRAM_LOCAL | Signed-in user-device bridge | No public posting/saves API per Eden docs; companion extension/desktop, same user account, device online and custom-domain grants where relevant. |
| EXTENSION | Chrome Manifest V3 companion | Local token, selected site permissions, capture/sidepanel and device-only bridges; web-app deployment does not automatically install extension. |
| INGEST / PDF_OCR / IMPORT | Fetch/extract/transcribe/import services | Safe URL fetching, SSRF defense, size/type checks, document parsers, PDF/EPUB and preserved source; access only content user is entitled to read. |
| TRANSCRIPTION / TTS / IMAGE_API / RENDER | Media generation/processing | Speech-to-text, reader narration, optional raster generation, crisp HTML/CSS to image export. Separate provider credentials and worker/runtime requirements. |
| READWISE / KINDLE / SNIPD | User-authorized source accounts | Appropriate source API/token/session/export flow; encrypted credential handling, resumable deduped sync; do not assume official API for every source. |
| BUSINESS_APIS | Kit, beehiiv, Klaviyo, Stripe, Whop, Kajabi, Notion, Webflow, Circle | Each requires user account, OAuth/API key and tools allowed by provider plan. API abilities must be discovered/implemented per provider; idle connector should cost no model credits. |
| MCP_CLIENT / MCP_SERVER | Remote MCP transport and OAuth | Hosted HTTPS custom connections, tool discovery and scopes; public server supplies structured tools, resource metadata, JSON-RPC errors and tenant boundary. |
| KEYVAULT | Credential encryption and runtime secret management | Encrypt OAuth refresh tokens/API keys and custom URLs, never return saved secrets, revoke/delete promptly. Azure Key Vault or equivalent. |
| EMAIL / PUSH / TELEGRAM | Delivery providers / Telegram bot | Invite/export/routine messages, native push tokens; Telegram digest requires BotFather token and target chat id. Sending tests externally is separate from provisioning. |
| BILLING | Payment processor account/webhooks | Subscriptions/seats/top-ups, tax/invoices, entitlements and exact-once credit ledger. Showing a paid plan is not a real billing integration. |
| SHORTLINK_DOMAIN / DNS_TLS | Default short domain plus user-owned custom domains | Redirect handler and aggregate click tracking, DNS verification, certificates and abuse controls. |

## Feature acceptance matrix

### Workspace

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `workspace.home` — Dashboard, navigation and command menu | Navigate Home, Library, Discover, Custom AI, Publish, Chats, boards and spaces; Cmd/Ctrl-K searches and creates items; pinned and recent items reopen correctly. | [Official](https://eden.so/help/getting-started/welcome-to-eden/) | DB |
| `workspace.tenancy` — Isolated workspaces and membership | A user switches workspaces; boards, notes, chats, social accounts, connectors and tokens never leak between tenants; member access is checked on every API and shared item. | [Official](https://eden.so/enterprise/) | DB, AUTH |
| `workspace.brand` — Multiple brands and pooled allowances | Separate brands have their own connected accounts, queue and schedules; multi-workspace plan pools credits, seats and social sets; changing brand changes scope everywhere. | [Official](https://eden.so/help/scheduling/managing-brands/) | DB, AUTH, BILLING |
| `workspace.capture` — Quick capture | Cmd/Ctrl-K capture supports sticky card, markdown document, URL preview and multi-file uploads; chosen board is remembered; changing destination does not save; repeated capture and recent captures work. | [Official](https://eden.so/help/getting-started/quick-capture/) | DB, BLOB, INGEST |
| `workspace.pinning` — Pinned items | Pin/unpin frequently used items and open from navigation; persistent per-user/workspace state. | [Official](https://eden.so/help/library/pinning/) | DB |
| `workspace.onboarding` — Onboarding and topic preferences | Guided first board, own accounts, niche/topic pillars and workspace defaults persist and feed research views. | [Official](https://eden.so/help/getting-started/the-complete-eden-walkthrough/) | DB, AUTH |

### Library

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `library.types` — Unified saved item library | Create and browse documents, sticky cards, links, PDFs, images, audio/video, EPUBs, saved social posts and highlights; item has stable identity independent of boards. | [Official](https://eden.so/help/library/the-library/) | DB, BLOB, INGEST |
| `library.filters` — Type, source, tags and topic filters | Combinable filters narrow library by item type, source, platform, topic and tags; switching grid/list retains relevant state and opens selected item. | [Official](https://eden.so/help/library/filtering-your-library/) | DB |
| `library.search` — Keyword and semantic search | Find exact text and conceptually related notes/highlights/PDFs/links/posts, with source links; queries cannot surface another tenant’s private items. | [Official](https://eden.so/help/library/searching-your-library/) | DB, EMBEDDINGS |
| `library.tags` — Workspace tags | Create, rename, recolor, assign, remove and filter shared workspace tags across supported item types. | [Official](https://eden.so/help/library/tags/) | DB |
| `library.backlinks` — Connections and bidirectional links | Connect any two items; both show relationship; inline @ mentions create durable connections; deleting a view does not corrupt original item. | [Official](https://eden.so/help/library/connecting-items/) | DB |
| `library.graph` — Graph view and entity hubs | Show item nodes linked through books, creators, boards and extracted entities; hub focus, zoom and type toggles work; new items enrich automatically. | [Official](https://eden.so/help/library/the-graph-view/) | DB, EMBEDDINGS, LLM |
| `library.neural` — Neural relations while writing | Current paragraph returns semantically relevant owned items with debounce; excludes already mentioned items; per-type preference; inserting suggestion is explicit and links items. | [Official](https://eden.so/help/library/neural-relations/) | DB, EMBEDDINGS |
| `library.sources` — Source assignment and enrichment | Saved items retain source URL, creator, title, date, platform and media metadata; source grouping survives board placement. | [Official](https://eden.so/help/library/sources/) | DB, INGEST |
| `library.annotations` — Notes on saved items | Write and persist personal/workspace notes attached to original social/link/media item, independently of which board displays it. | [Official](https://eden.so/help/library/notes-on-saved-items/) | DB |
| `library.rss` — RSS subscriptions | Add valid feed, ingest new entries, avoid duplicates, show source/feed filtering and unsubscribe without corrupting already saved work. | [Official](https://eden.so/help/library/rss-feeds/) | DB, INGEST, JOBS |
| `library.import_notion` — Notion export import | Import supported Notion export archive into notes/library, preserve supported hierarchy, attachments and links; report unsupported entries. | [Official](https://eden.so/help/library/import-notion/) | DB, BLOB, IMPORT |
| `library.import_obsidian` — Obsidian vault import | Import markdown vault and supported attachments/links without modifying originals. | [Official](https://eden.so/help/library/import-obsidian/) | DB, BLOB, IMPORT |
| `library.import_evernote` — Evernote import | Import supported Evernote export notes and attachments with useful metadata; report failed entries. | [Official](https://eden.so/help/library/import-evernote/) | DB, BLOB, IMPORT |
| `library.import_apple` — Apple Notes import | Accept documented Apple Notes export flow, ingest documents/media and report unsupported data. | [Official](https://eden.so/help/library/import-apple-notes/) | DB, BLOB, IMPORT |
| `library.instagram_saves` — Instagram Saves and collection sync | Local extension/desktop signed-in session imports selected saves; collections become tags on first import; daily and manual sync, selection backfill and disconnect behavior; login/session stays on device. | [Official](https://eden.so/help/library/connect-instagram-saves/) | DB, INSTAGRAM_LOCAL, EXTENSION, JOBS |
| `library.export` — Workspace export | Build asynchronous ZIP with markdown documents/cards, links.csv, source-grouped highlights and original uploads; progress, expiring download and skipped-files report; omit chats/layout/computed transcripts per documented behavior. | [Official](https://eden.so/help/account/export-your-workspace/) | DB, BLOB, JOBS, EMAIL |

### Boards

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `boards.views` — Grid and freeform canvas | Create/rename/duplicate boards; switch views without losing items; grid sorting and canvas coordinates persist; same item can appear on multiple boards. | [Official](https://eden.so/features/boards/) | DB |
| `boards.organize` — Spaces and sections | One-level sidebar Spaces organize boards; sections segment a board; items can be added/moved and board sorting can use documented sort keys. | [Official](https://eden.so/help/boards/boards-spaces-and-sections/) | DB |
| `boards.canvas` — Canvas interaction | Pan via space/right-drag, zoom, fit view, select, move and resize items; copy-paste at cursor; duplicate and Alt-drag; axis lock; escape cancel; user-local undo/redo. | [Official](https://eden.so/help/boards/working-fast-in-freeform/) | DB |
| `boards.drawing` — Canvas drawing and pointers | Pen, eraser, rectangle, text, line and arrow tools persist marks; laser pointer fades without saving; tools stay selected until changed. | [Official](https://eden.so/help/boards/working-fast-in-freeform/) | DB |
| `boards.snapping` — Grid and snapping | Toggle dot grid, snap on drag, temporarily override using modifier key; preferences persist. | [Official](https://eden.so/help/boards/freeform-grid-and-snapping/) | DB |
| `boards.multichat` — Multiple contextual chats | Create separate chats adjacent to sources, selected items or entire board; source relationships persist across sessions. | [Official](https://eden.so/features/boards/) | DB, LLM |

### Collaboration

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `boards.sharing` — Public board sharing and duplication | Create/revoke shareable links and allow read/comment or supported edits; recipient can duplicate accessible items into own workspace; no unshared private data travels. | [Official](https://eden.so/help/boards/sharing-a-board/) | DB, AUTH |
| `boards.private` — Team and private boards | Visibility modes restrict content to team or explicitly invited users; private board items do not become globally readable by changing views. | [Official](https://eden.so/help/boards/team-and-private-boards/) | DB, AUTH |
| `items.invites` — Specific-person item invitations | Invite by email to board/note/table, assign supported view/edit permission, revoke without workspace membership; guest invites do not consume member seat. | [Official](https://eden.so/help/boards/inviting-people/) | DB, AUTH, EMAIL |
| `items.sharing` — Share individual item | Share note/table/link/media independently of board; supported public view/comment/edit permission is enforced server-side; revoke is effective immediately. | [Official](https://eden.so/help/boards/sharing-an-item/) | DB, AUTH |
| `items.comments` — Threaded and anchored comments | Comments sit beside note/table/board, support replying/resolving/mentions where documented, require login to post, and obey share permission; summaries notify owners; comments do not enter AI context or exports. | [Official](https://eden.so/help/boards/comments/) | DB, AUTH, EMAIL, PUSH |
| `items.history` — Version history | List snapshots, inspect and restore versions within plan retention; restoration creates recoverable state rather than silent irreversible overwrite. | [Official](https://eden.so/help/boards/version-history/) | DB |
| `items.trash` — Trash and restore | Delete moves recoverable items into trash; restore retains useful context; plan-specific retention and permanent expiry are explicit. | [Official](https://eden.so/help/boards/trash-and-restoring-items/) | DB, JOBS |

### Editor & tables

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `editor.documents` — Rich markdown documents | Create long-form notes with headings, paragraphs, lists and blocks; slash insert menu, @ mentions, rearrange blocks, side panes and autosave; source context remains accessible. | [Official](https://eden.so/help/boards/documents-vs-tables/) | DB |
| `tables.schema` — Database table columns | Rows plus text, select, multi-select, date, checkbox, priority and workspace-item relation fields; add/rename/remove columns and options; computed created/platform/likes/views; color choices persist. | [Official](https://eden.so/help/boards/tables/) | DB |
| `tables.items` — Rows as workspace items | Link existing item, create document/table from row, or add related item without renaming row; linked title follows original item; row deletion remains recoverable. | [Official](https://eden.so/help/boards/tables/) | DB |
| `tables.layouts` — Table, list, kanban and calendar | Same rows switch among 4 layouts; group by status/date/etc, drag between groups to edit property, reorder lanes, date calendar drag; saved filters and views persist. | [Official](https://eden.so/help/boards/tables/) | DB |
| `tables.bulk` — Bulk and keyboard editing | Enter/Tab/arrows traverse typed editors; range select supports multi-cell change, clear, copy TSV and row duplicate/remove; sorted rows disable manual reorder. | [Official](https://eden.so/help/boards/tables/) | DB |
| `tables.recurrence` — Recurring tasks and relative date filters | Daily/weekday/weekly/monthly/yearly/custom recurrence; complete advances same row to next future occurrence and unchecks; optional from-completion anchor; calendar previews and undo; today/overdue filters remain relative. | [Official](https://eden.so/help/boards/tables/) | DB |
| `tables.embed` — Live embedded tables and templates | Embed existing/new table in note with bidirectional editing; deleting block retains table; external duplicate copies table safely; create from reusable templates and AI. | [Official](https://eden.so/help/boards/tables/) | DB, LLM |

### Reader & highlights

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `reader.articles` — Focused article/social reader | Render clean articles/newsletters and full social text with saved reading position; local browser capture may be needed for paid content user can already read. | [Official](https://eden.so/features/reader/) | DB, INGEST, EXTENSION |
| `reader.pdf` — PDF and EPUB reader | Upload/read PDF and EPUB, search/highlight, maintain figures/tables/layout for premium PDF extraction; retain original binary. | [Official](https://eden.so/help/library/reading-pdfs/) | DB, BLOB, PDF_OCR |
| `reader.transcript` — Video, reel and audio transcription | Saved YouTube/TikTok/Instagram videos and supported uploads get readable searchable transcripts tied to source; processing/error states and language handling are visible. | [Official](https://eden.so/help/library/reader-for-social-and-video/) | DB, BLOB, TRANSCRIPTION, INGEST |
| `reader.highlights` — First-class highlights | Select passage in readable formats, create highlight with source/position and note; searchable Highlights pane; add quote card to board; reopen source context. | [Official](https://eden.so/help/library/highlighting-while-reading/) | DB |
| `reader.narration` — Reader narration | Generate/play audio narration for saved reads with useful playback controls and clear availability on plan. | [Official](https://eden.so/pricing/) | DB, BLOB, TTS |
| `reader.kindle` — Kindle sync | Connect through documented authorized flow, import book highlights, track sync status, dedupe and disconnect. | [Official](https://eden.so/help/library/connect-kindle/) | DB, KINDLE, JOBS |
| `reader.readwise` — Readwise sync | Authorized Readwise connection imports highlights and source metadata; subsequent sync updates without duplicates; disconnect revokes credential. | [Official](https://eden.so/help/getting-started/connect-readwise/) | DB, READWISE, JOBS |
| `reader.snipd` — Snipd podcast highlights | Authorized connection imports podcast snips/highlights and source context with resumable sync and disconnect. | [Official](https://eden.so/help/library/connect-snipd/) | DB, SNIPD, JOBS |

### Research

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `research.discover` — Multi-platform outlier discovery | Search/filter corpus by topic, platform, date, follower range, format and outlier floor; use seven named research platforms; browse/filter free vs typed paid search is entitlement-driven. | [Official](https://eden.so/features/discover/) | DB, SOCIAL_CORPUS, EMBEDDINGS |
| `research.baseline` — Creator-relative outlier ranking | Outlier is post metric divided by creator recent median: likes for X/LinkedIn/Substack, views for YouTube/TikTok, separate IG content-type baselines; show sample/baseline provenance and unavailable metrics honestly. | [Official](https://eden.so/features/creators/) | DB, SOCIAL_CORPUS |
| `research.creators` — Creator search and profiles | Resolve handles and linked cross-platform profiles; semantic topic search returns excerpt evidence; top outlier/liked/viewed/shared/recent sorts; track creator data refresh. | [Official](https://eden.so/features/creators/) | DB, SOCIAL_CORPUS, EMBEDDINGS |
| `research.lists` — Creator lists and recommendations | Create/update lists, aggregate latest posts as refreshable feed, suggest similar creators, save standouts to boards; list differs from saved snapshot board. | [Official](https://eden.so/help/creators/building-creator-lists/) | DB, SOCIAL_CORPUS, EMBEDDINGS |
| `research.boost` — Boost/reverse-engineer posts | Analyze hook/structure/angle, apply pattern to user idea, generate variation/short-form angles; retain full source context and citation in resulting chat. | [Official](https://eden.so/help/chat/using-boosts/) | DB, LLM, SOCIAL_CORPUS |
| `research.ads` — Meta and TikTok ad discovery | Search ads with creative/copy/CTA/platform/niche/angle/format; sort running duration/rising; show run dates, variations and available TikTok CTR/views/likes without claiming true ROI. | [Official](https://eden.so/features/ads/) | DB, AD_CORPUS, BLOB, EMBEDDINGS |
| `research.brands` — Brand ads and watchlists | Resolve brand from name/site/social/ad URL, start on-demand collection, show active/history ads, daily refresh, track in shared watchlist feed. | [Official](https://eden.so/features/ads/) | DB, AD_CORPUS, JOBS |
| `research.advariants` — Ad variation comparison and archive | Group variations, compare dates/placements/copy/CTA side by side; saved permitted creatives remain available independently of live campaign; save/chat/brief from ad. | [Official](https://eden.so/features/ads/) | DB, AD_CORPUS, BLOB, LLM |

### AI chat

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `chat.eve` — Eve multi-tool chat | Streaming chat can search/read/organize/write/repurpose/prepare queue in one request; tool traces visible, retriable errors concrete, progress survives background runs. | [Official](https://eden.so/features/eve/) | DB, LLM, JOBS |
| `chat.sources` — Grounded board/workspace chat | Attach explicit board/item context, retrieve relevant owned material and return verifiable source lines; no unsupported claims that material was read. | [Official](https://eden.so/help/chat/chatting-with-a-board/) | DB, LLM, EMBEDDINGS |
| `chat.models` — Model selection and custom instructions | Select available models/tier, persistent user instructions, clear credits/cost display, configured provider/model capabilities; unavailable provider is marked unavailable. | [Official](https://eden.so/pricing/) | DB, LLM, BILLING |
| `chat.voice` — Multiple writing voices | Editable voice profiles derive from user-selected sources; choose writing voice globally/per chat; migration from older prompts/identities is documented. | [Official](https://eden.so/help/chat/set-a-custom-ai-as-your-writing-voice/) | DB, LLM |
| `chat.deep_social` — Deep Social background research | Run bounded multi-query market investigation, real posts and source citations, progress and final report; no fake metrics when corpus unavailable. | [Official](https://eden.so/help/chat/deep-social-research/) | DB, LLM, SOCIAL_CORPUS, JOBS |
| `chat.deep_synthesis` — Deep Synthesis | Search/read large owned library, connect themes with exact sources, deliver background result without cross-tenant leakage. | [Official](https://eden.so/help/chat/deep-synthesis/) | DB, LLM, EMBEDDINGS, JOBS |
| `chat.tasks` — Background tasks | Delegate longer work from chat, preserve visible running/completed/failed status, cancel/retry where appropriate, notify user and reopen result. | [Official](https://eden.so/help/chat/background-tasks/) | DB, LLM, JOBS |
| `chat.images` — Text-first image and hybrid generation | Generate post/quote cards, visual explainers and optional AI backgrounds; editable crisp HTML/CSS text overlay; save/refine/export and attach to draft. | [Official](https://eden.so/help/chat/generating-images/) | DB, BLOB, RENDER, IMAGE_API |
| `chat.voice_capture` — Voice-to-text capture | Microphone capture transcribes to editable text with explicit recording state and permission flow. | [Official](https://eden.so/pricing/) | DB, TRANSCRIPTION |

### Custom AI

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `custom.create` — Build a Custom AI | CRUD name/description/instructions/starters/voice, own chat history and page; attach library files, notes, live boards or public creators; answers show used sources. | [Official](https://eden.so/help/custom-ai/create-your-first-custom-ai/) | DB, LLM, EMBEDDINGS |
| `custom.isolation` — Narrow, live knowledge boundary | Only attached knowledge is accessible; live board/note references reflect updates; wrong source can be corrected; creator source refresh is explicit. | [Official](https://eden.so/features/custom-ai/) | DB, LLM, EMBEDDINGS, SOCIAL_CORPUS |
| `custom.sharing` — Share and install templates safely | Shared instructions/starters install independent copy, exclude private board/note/chat contents, replace private knowledge references with named empty slots. | [Official](https://eden.so/help/custom-ai/share-and-install-custom-ais/) | DB, AUTH |
| `custom.marketplace` — Explore marketplace | Search/filter categories/platforms, inspect template knowledge, install and start specialist; 19 publicly listed templates captured in report. | [Official](https://eden.so/marketplace/) | DB, LLM |
| `custom.routines` — Custom AI routines | Scheduled run inherits companion instruction/knowledge/voice in fresh chat; preserve source boundary and continuity through explicit notes. | [Official](https://eden.so/help/custom-ai/custom-ai-routines/) | DB, LLM, JOBS |

### Skills & routines

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `skills.portable` — Portable SKILL.md skills | Create via form/chat, import markdown or ZIP references, handle duplicate names via replace/keep-both, read refs on demand and export byte-exact; scripts stored but never executed. | [Official](https://eden.so/help/chat/using-skills/) | DB, BLOB |
| `skills.activate` — Slash and automatic skill activation | Slash picker or semantic trigger activates visible removable chip per chat; built-in skills toggle workspace-wide; custom skill editing and deletion persist. | [Official](https://eden.so/help/chat/using-skills/) | DB, LLM |
| `skills.builtins` — Nine built-in skills | Ship Skill creator, Prompt creator, X posts, X threads, LinkedIn posts, Instagram captions, YouTube titles, Newsletter writer, Table builder as exportable read-only toggles. | [Official](https://eden.so/help/chat/using-skills/) | DB, LLM |
| `routines.schedules` — Timezone-aware routines | CRUD 20/workspace max documented daily/weekday/weekly/monthly schedules with model/prompt/email; preserve original timezone; skip overlapping run; persist next run and pause status. | [Official](https://eden.so/help/chat/meet-routines/) | DB, LLM, JOBS, EMAIL |
| `routines.history` — Routine result inbox and notifications | Fresh chat per run, pulsing running and blue unread completed markers, latest-week run list, clear on open; persistent note/table memory across runs; email/push result option. | [Official](https://eden.so/help/chat/meet-routines/) | DB, JOBS, EMAIL, PUSH |

### Publishing

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `publish.accounts` — OAuth social account linking | Link X/LinkedIn/Threads/Instagram/TikTok/Facebook/YouTube on official auth screens, handle reconnect/revoke/errors and per-workspace/per-brand scope; IG requires professional, FB Page, YouTube Shorts only. | [Official](https://eden.so/help/scheduling/connecting-your-accounts/) | DB, AUTH, SOCIAL_PUBLISH |
| `publish.composer` — Multi-platform composer and drafts | Store draft/master plus per-platform versions, threads, images/video/doc media, platform validation and previews; drafts never publish until explicitly scheduled/published. | [Official](https://eden.so/help/scheduling/scheduling-and-publishing/) | DB, BLOB, SOCIAL_PUBLISH |
| `publish.calendar` — Queue/calendar/custom schedules | Queue into slots or explicit timezone time; best-time suggestions if supported by evidence; edit, move, cancel, reuse past post and status tracking until published. | [Official](https://eden.so/features/scheduling/) | DB, JOBS, SOCIAL_PUBLISH |
| `publish.delivery` — Durable scheduled delivery | Worker publishes due posts with per-platform results, retry/idempotency, failure reasons, connection expiry state and cancellation races handled; saved scheduled status must reflect actual provider result. | [Official](https://eden.so/help/scheduling/troubleshooting-scheduling/) | DB, JOBS, SOCIAL_PUBLISH |
| `publish.automations` — First comment and repost automation | After successful post, schedule first comment and supported X auto-retweet/repost/quote actions with explicit user configuration and result tracking. | [Official](https://eden.so/help/scheduling/x-scheduling/) | DB, JOBS, SOCIAL_PUBLISH |
| `publish.substack` — Substack local-device bridge | Text notes/articles hand off to Substack native scheduler via signed-in extension/desktop; mark On Substack only after confirmation; image/thread note requires live browser; missed is warning/draft, never stale publish; custom domain permission. | [Official](https://eden.so/help/scheduling/substack-scheduling/) | DB, EXTENSION, SUBSTACK_LOCAL, JOBS |
| `publish.post_images` — Post image renderer | Convert text to native-looking post image, select styling/aspect and identity, preview/export/attach; preserve per-platform attachments. | [Official](https://eden.so/help/scheduling/post-images/) | DB, BLOB, RENDER |

### Analytics

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `analytics.digest` — Own cross-platform analytics | Connected private metrics sync into warehouse; totals/deltas/follower counts, per-post views/likes/shares/saves/impressions/watch time/email opens when source supports; missing is syncing/unavailable, never zero. | [Official](https://eden.so/features/mcp/) | DB, SOCIAL_ANALYTICS, JOBS |
| `analytics.insights` — Topic/format winners and baseline comparisons | Filters by brand/platform/window, recent top posts and own baseline, compare periods, track 30/60/90-day plan history; separate own performance from market evidence. | [Official](https://eden.so/features/mcp/) | DB, SOCIAL_ANALYTICS, LLM |

### Auto-DM & links

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `dm.rules` — Instagram automation rules | Trigger by comment keyword, story reply, incoming DM keyword or reaction/optional emoji; target single/next/new posts; message editor and preview; separate public reply action. | [Official](https://eden.so/features/auto-dm/) | DB, INSTAGRAM_MESSAGING, JOBS |
| `dm.delivery` — Webhook automation delivery | Consume authenticated webhooks, dedupe same rule/person for 7 days, delay and respect hourly/daily platform limits, pause at zero credits and resume; count only successful actual sends. | [Official](https://eden.so/features/auto-dm/) | DB, INSTAGRAM_MESSAGING, JOBS, BILLING |
| `dm.links` — Tracked short links | Create branded short slug, redirect to editable destination, aggregate sends/clicks/CTR without exposing recipients; change destination preserves old link. | [Official](https://eden.so/features/auto-dm/) | DB, SHORTLINK_DOMAIN |
| `dm.domain` — Custom link domain | Verify owned domain and DNS, TLS/redirect serving, validation/errors and revoke; include default shared domain and slug collisions. | [Official](https://eden.so/help/scheduling/custom-link-domain/) | DB, SHORTLINK_DOMAIN, DNS_TLS |

### Connectors & MCP

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `connectors.catalog` — Business app connector catalog | Workspace-scoped Kit, beehiiv, Klaviyo, Stripe, Whop, Kajabi, Notion, Webflow and Circle; OAuth/API-key configuration, encrypted storage, pause/delete and per-tool disable. | [Official](https://eden.so/features/connectors/) | DB, KEYVAULT, BUSINESS_APIS |
| `connectors.actions` — Business reads and mutations | Read subscriber/revenue/member/page data, create broadcasts/products/posts, update CMS/pages according to each provider permissions; tool traces and content review for consequential actions. | [Official](https://eden.so/help/chat/connected-tools/) | DB, LLM, BUSINESS_APIS |
| `connectors.custom` — Custom hosted MCP and Zapier | Connect remote HTTPS MCP URL with API key/OAuth, discover tools lazily, per-tool enable, enforce SSRF boundaries and treat external results as data; stdio-only servers unsupported. | [Official](https://eden.so/features/connectors/) | DB, KEYVAULT, MCP_CLIENT |
| `mcp.server` — Public MCP server and OAuth | Streamable HTTP MCP endpoint, OAuth protected resource/authorization metadata, read/write scopes, workspace default/override and structured {ok:false,status,message} failures; expose permission-safe tool catalog. | [Official](https://eden.so/openapi.json) | DB, AUTH, MCP_SERVER |
| `mcp.tools` — 74 publicly catalogued MCP tools | Implement real workspace/research/boards/tables/scheduling/media/analytics/Custom AI/skills operations; published aliases work or deprecate explicitly; tool inputs discoverable at runtime. | [Official](https://eden.so/llms-full.txt) | DB, MCP_SERVER |

### Five workflows

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `workflow.weekly` — Weekly Strategist | Save settings once; score own posts separately; bounded market investigation; up to 3 patterns each supported by different creators; grade previous bet, exactly 3 plays and one bet; save dated memo with receipts. | [Official](https://eden.so/workflows/weekly-strategist/) | DB, LLM, SOCIAL_CORPUS, SOCIAL_ANALYTICS |
| `workflow.head` — Head of Content | Review prior plan/actual queue and metrics, reuse recent weekly memo, evidence for each slot and at most one experiment; approve slate, draft up to 7 in voice into queue, save week report and change log. | [Official](https://eden.so/workflows/head-of-content/) | DB, LLM, SOCIAL_CORPUS, SOCIAL_ANALYTICS |
| `workflow.command` — Content Command Center | Connect own analytics, show real top posts, Analyst/Scout/Strategist/Planner/Repurposer stations, saved settings/snapshot, refresh and optional Telegram digest; missing metrics say syncing. | [Official](https://eden.so/workflows/content-command-center/) | DB, LLM, SOCIAL_CORPUS, SOCIAL_ANALYTICS, JOBS, TELEGRAM |
| `workflow.brand` — Personal Brand Strategist | Interview/refresh answers, research personal-sized creators, curate 8–16 real receipt posts, positioning/story/topic tree/content directions/first five hooks/monetization, save strategy and optional approved queue drafts. | [Official](https://eden.so/workflows/personal-brand-strategist/) | DB, LLM, SOCIAL_CORPUS |
| `workflow.idea` — Idea Engine | Fuse own saved material, live market and tangent formats; each idea has at least two legs; 5–8 cards or honest fewer; dedupe last 3 runs and queued/published; hooks in voice, evidence and approved draft action. | [Official](https://eden.so/workflows/idea-engine/) | DB, LLM, SOCIAL_CORPUS |

### Clients

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `extension.capture` — Chrome extension capture and creator sidebar | Toolbar/right-click saves, inline buttons on X/YouTube/Instagram/Substack, chosen board/workspace, local token auth and creator sidebar; LinkedIn toolbar/profile flow. | [Official](https://eden.so/features/chrome-extension/) | DB, AUTH, EXTENSION, SOCIAL_CORPUS |
| `clients.mobile` — Responsive web and device continuation | Web works on mobile; native iOS TestFlight/Android APK/macOS exist publicly, but user requested web app; cross-device reading/chat continuation should work if native apps later built. | [Official](https://eden.so/downloads/) | DB, AUTH |

### Account & billing

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `billing.plans` — Plans, quotas and subscription lifecycle | Free/Personal/Personal Plus/Starter/Pro/Studio tiers; quotas on storage/upload/credits/history/tracking/brands/seats, accurate upgrades/downgrades/cancel/pause and retained data. | [Official](https://eden.so/help/account/plans-and-pricing/) | DB, BILLING |
| `billing.credits` — Credit ledger and usage | Free one-time grant, paid monthly refill, metered LLM/research/tool actions, retry-safe debit/refund and concurrent reservations; transparent history; out-of-credits is actionable and does not fabricate success. | [Official](https://eden.so/help/account/how-credits-work/) | DB, BILLING |
| `billing.invoices` — Invoices and tax details | Download paid invoice/receipt, company billing name and VAT/tax ID, plan ownership and safe payment portal. | [Official](https://eden.so/help/account/invoices-and-receipts/) | DB, BILLING |

### Public tools

| ID / feature | Observable acceptance | Source | Dependencies |
|---|---|---|---|
| `tools.free` — Seven free creator tools | YouTube/Instagram/TikTok transcript tools, X character counter, engagement rate calculator, post image generator and YouTube app-link generator; genuine inputs/outputs and provenance. | [Official](https://eden.so/tools/) | DB, TRANSCRIPTION, INGEST, RENDER |

## Public Custom AI marketplace inventory
19 templates: Personal Brand Strategist; Daily Post Writer; Topic Research; Substack Newsletter Studio; Thought Partner; Creator Deep Dive; Reels Script Studio; Weekly Content Planner; Weekly Strategist; YouTube Script Studio; Substack Notes Studio; LinkedIn Post Studio; X Post Studio; YouTube Title Generator; X Thread Studio; Offer Architect; Landing Page Studio; Ad Copywriter; Ad Research. Categories: Content & Writing (9), Marketing & Growth (4), Research & Analysis (2), Strategy & Planning (4). Public listing exposes descriptions and knowledge headings; full proprietary knowledge contents are not established by listing alone.

## Pricing evidence, not a proposed pricing plan
Public annual display on capture: Free $0; Personal $90/year ($7.50/month); Personal Plus $150/year ($12.50/month); Starter first year $200 then $299/year; Pro first year $529 then $790/year; Studio $1,999/year. Homepage monthly examples say Personal $9 and Pro $79. Annual welcome offer eligibility varies. Free 50 one-time credits; Personal none; Personal Plus 150/month; Starter 200; Pro 750; Studio 2,000. Storage 5GB/10GB/10GB/50GB/250GB/1TB, upload max 10MB/250MB/250MB/1GB/2GB/5GB, version/trash retention 7/30/30/30/60/90 days. Starter 5 tracked creators/brands, Pro 25, Studio unlimited. Plan table uses icons that plain-text extraction loses; verify exact icon entitlements in browser rather than guessing.

## MCP catalog
All names below are public API metadata, not proof they are authenticated/testable in this session. Each real implementation needs input validation, workspace scope, access control, error contract and result verification.

### Workspace

- `eden_list_workspaces` — List workspaces
- `eden_list_workspace_items` — List workspace items
- `eden_find_workspace_items` — Find workspace items (semantic)
- `eden_search_workspace_items` — Search workspace items
- `eden_get_note_markdown` — Read note markdown
- `eden_read_media_card` — Read media card content
- `eden_read_board` — Read board contents
- `eden_read_table` — Read table rows
- `eden_get_connections` — Get item connections
- `eden_list_tags` — List workspace tags
- `eden_list_chats` — List chats

### Social intelligence

- `eden_read_card` — Moved to eden_read_social_post
- `eden_search_creators` — Search creators
- `eden_resolve_creator` — Resolve creator
- `eden_analyze_creator` — Analyze creator
- `eden_read_social_post` — Read social post
- `eden_following_overview` — List followed creators
- `eden_analyze_list` — Analyze creator list
- `eden_search_social_content` — Search social content
- `eden_study_top_titles` — Study top titles
- `eden_search_ads` — Search ads
- `eden_get_brand_ads` — Get brand ads
- `eden_get_brand_list_ads` — Get brand-list ads
- `eden_save_brands_to_list` (write) — Save brands to list

### Highlights & captures

- `eden_search_highlights` — Search highlights
- `eden_search_captures` — Search captures

### Boards & documents

- `eden_create_board` (write) — Create board
- `eden_connect_items` (write) — Connect items
- `eden_rename_board` (write) — Rename board
- `eden_trash_board` (write) — Trash board
- `eden_create_note` (write) — Create note
- `eden_update_note` (write) — Update note
- `eden_create_sticky_note` (write) — Moved to eden_create_note
- `eden_rename_note` (write) — Rename note
- `eden_append_to_note` (write) — Append to note
- `eden_save_links_to_board` (write) — Save links to board
- `eden_save_posts_to_board` (write) — Save social posts to board
- `eden_save_ads_to_board` (write) — Save ads to board
- `eden_save_items_to_board` (write) — Save existing items to board
- `eden_create_table` (write) — Create table
- `eden_add_table_rows` (write) — Add table rows
- `eden_update_table_rows` (write) — Update table rows
- `eden_update_table` (write) — Update table (columns/view)
- `eden_update_item_tags` (write) — Update item tags

### Scheduling

- `eden_list_schedules` — List schedules
- `eden_update_schedule` (write) — Update schedule
- `eden_list_scheduled_posts` — List scheduled posts
- `eden_prepare_scheduling_media_upload` (write) — Prepare scheduling media upload
- `eden_scheduling_media_multipart` (write) — Multipart media upload step
- `eden_upload_scheduling_media` (write) — Upload scheduling media
- `eden_create_scheduling_draft` (write) — Moved to eden_schedule_post
- `eden_schedule_post` (write) — Schedule post
- `eden_publish_post_now` (write) — Publish post now
- `eden_update_scheduled_post` (write) — Update scheduled post
- `eden_cancel_scheduled_post` (write) — Cancel scheduled post
- `eden_get_analytics` — Get analytics digest
- `eden_list_analytics_posts` — List analytics posts
- `eden_connect_social_accounts` (write) — Connect social accounts
- `eden_list_auto_dm_rules` — List Auto-DM automations
- `eden_create_auto_dm_automation` (write) — Create Auto-DM automation

### Media

- `eden_study_top_carousels` — Study top carousels

### Custom AI

- `eden_list_custom_ai` — List Custom AI
- `eden_get_custom_ai` — Get a Custom AI
- `eden_create_custom_ai` (write) — Create Custom AI
- `eden_update_custom_ai` (write) — Update Custom AI
- `eden_manage_custom_ai_sources` (write) — Manage Custom AI knowledge
- `eden_delete_custom_ai` (write) — Delete Custom AI
- `eden_get_custom_ai_builder_guide` — Custom AI builder guide
- `eden_read_custom_ai_knowledge` — Read Custom AI knowledge
- `eden_search_custom_ai_knowledge` — Search Custom AI knowledge

### Skills

- `eden_list_skills` — List skills
- `eden_get_skill` — Get skill
- `eden_export_skill` — Export skill
- `eden_import_skill` (write) — Import skill

## Captured official page catalog

- [Eden | The AI that grows your creator business](https://eden.so/)
- [Download Eden](https://eden.so/downloads/)
- [Eden for teams and agencies · Enterprise](https://eden.so/enterprise/)
- [Eden Ads: research winning ads, study top brands, write your own](https://eden.so/features/ads/)
- [Instagram Auto-DM: Send the link automatically, track every click | Eden](https://eden.so/features/auto-dm/)
- [Boards — Swipe files and a freeform creative canvas | Eden](https://eden.so/features/boards/)
- [Chrome Extension — Save any post to Eden in one click](https://eden.so/features/chrome-extension/)
- [Connectors: connect Kit, beehiiv, Stripe, Notion, and more to Eden's AI](https://eden.so/features/connectors/)
- [Creator Research & Lists — Study any creator's best work | Eden](https://eden.so/features/creators/)
- [Custom AI: an AI built around your knowledge | Eden](https://eden.so/features/custom-ai/)
- [Discover — See what's actually working in your niche | Eden](https://eden.so/features/discover/)
- [Eve — The AI that researches, creates, and schedules your content](https://eden.so/features/eve/)
- [Highlights — Highlight anything you read, turn it into content | Eden](https://eden.so/features/highlights)
- [Highlights — Highlight anything you read, turn it into content | Eden](https://eden.so/features/highlights/)
- [Eden MCP: the social media MCP for Claude, ChatGPT, and Cursor](https://eden.so/features/mcp)
- [Eden MCP: the social media MCP for Claude, ChatGPT, and Cursor](https://eden.so/features/mcp/)
- [Reader — Read it in Eden. Turn it into content. | Eden](https://eden.so/features/reader)
- [Reader — Read it in Eden. Turn it into content. | Eden](https://eden.so/features/reader/)
- [Scheduling — Publish to every platform on autopilot with Eden](https://eden.so/features/scheduling)
- [Scheduling — Publish to every platform on autopilot with Eden](https://eden.so/features/scheduling/)
- [Help center — Eden](https://eden.so/help/)
- [Account & billing — Eden Help](https://eden.so/help/account/)
- [Put your business name and VAT number on invoices — Eden Help](https://eden.so/help/account/business-details-on-invoices/)
- [Canceling, pausing, and refunds — Eden Help](https://eden.so/help/account/canceling-and-refunds/)
- [Export your workspace — Eden Help](https://eden.so/help/account/export-your-workspace/)
- [How EdenAI credits work — Eden Help](https://eden.so/help/account/how-credits-work/)
- [Download invoices and receipts — Eden Help](https://eden.so/help/account/invoices-and-receipts/)
- [Plans, seats, and what each tier includes — Eden Help](https://eden.so/help/account/plans-and-pricing/)
- [Trash and version retention — Eden Help](https://eden.so/help/account/trash-and-version-retention/)
- [Run multiple workspaces on one plan — Eden Help](https://eden.so/help/account/workspaces-on-your-plan/)
- [Boards — Eden Help](https://eden.so/help/boards/)
- [How creators use Eden boards as swipe files — Eden Help](https://eden.so/help/boards/boards-as-swipe-files/)
- [Boards, spaces, and sections — Eden Help](https://eden.so/help/boards/boards-spaces-and-sections/)
- [Comments on notes and items — Eden Help](https://eden.so/help/boards/comments/)
- [Creating your first board — Eden Help](https://eden.so/help/boards/creating-your-first-board/)
- [Documents vs tables — Eden Help](https://eden.so/help/boards/documents-vs-tables/)
- [Grid and snapping on the freeform canvas — Eden Help](https://eden.so/help/boards/freeform-grid-and-snapping/)
- [Inviting people to a note, board, or table — Eden Help](https://eden.so/help/boards/inviting-people/)
- [Sharing a board with a collaborator — Eden Help](https://eden.so/help/boards/sharing-a-board/)
- [Sharing a single item — Eden Help](https://eden.so/help/boards/sharing-an-item/)
- [Sorting a board — Eden Help](https://eden.so/help/boards/sorting-a-board/)
- [Tables — Eden Help](https://eden.so/help/boards/tables/)
- [Team and private boards — Eden Help](https://eden.so/help/boards/team-and-private-boards/)
- [Trash and restoring items — Eden Help](https://eden.so/help/boards/trash-and-restoring-items/)
- [Using sections to organize a board — Eden Help](https://eden.so/help/boards/using-sections/)
- [Version history — Eden Help](https://eden.so/help/boards/version-history/)
- [Working fast in freeform — Eden Help](https://eden.so/help/boards/working-fast-in-freeform/)
- [Eden AI — Eden Help](https://eden.so/help/chat/)
- [Add custom instructions to Eden AI — Eden Help](https://eden.so/help/chat/add-custom-instructions/)
- [Delegate work to background tasks — Eden Help](https://eden.so/help/chat/background-tasks/)
- [The chat sidebar — Eden Help](https://eden.so/help/chat/chat-sidebar/)
- [Chatting with a board to write your next post — Eden Help](https://eden.so/help/chat/chatting-with-a-board/)
- [Connectors: give Eden chat access to your other apps — Eden Help](https://eden.so/help/chat/connected-tools/)
- [Deep Social — big social research without the noise — Eden Help](https://eden.so/help/chat/deep-social-research/)
- [Deep Synthesis — connect everything you've saved — Eden Help](https://eden.so/help/chat/deep-synthesis/)
- [Generate images in Eden — Eden Help](https://eden.so/help/chat/generating-images/)
- [Meet routines: put Eden on a schedule — Eden Help](https://eden.so/help/chat/meet-routines/)
- [Personalizing Eden AI — Eden Help](https://eden.so/help/chat/personalizing-eden-ai/)
- [Routine ideas: 7 things to put on autopilot — Eden Help](https://eden.so/help/chat/routine-ideas/)
- [Set a Custom AI as your writing voice — Eden Help](https://eden.so/help/chat/set-a-custom-ai-as-your-writing-voice/)
- [Using Boosts to remix posts and tighten drafts — Eden Help](https://eden.so/help/chat/using-boosts/)
- [Using Skills in Eden AI — Eden Help](https://eden.so/help/chat/using-skills/)
- [Chrome extension — Eden Help](https://eden.so/help/chrome-extension/)
- [Eden Chrome extension quick start guide — Eden Help](https://eden.so/help/chrome-extension/quick-start-guide/)
- [Using the Eden Chrome extension — Eden Help](https://eden.so/help/chrome-extension/the-chrome-extension/)
- [Creators — Eden Help](https://eden.so/help/creators/)
- [Building a creator list as a content feed — Eden Help](https://eden.so/help/creators/building-creator-lists/)
- [How Eden suggests creators for you — Eden Help](https://eden.so/help/creators/finding-creators-to-study/)
- [Searching creators by topic — Eden Help](https://eden.so/help/creators/searching-creators-by-topic/)
- [Searching for and tracking a creator — Eden Help](https://eden.so/help/creators/tracking-a-creator/)
- [Custom AI — Eden Help](https://eden.so/help/custom-ai/)
- [Adding creators as sources — Eden Help](https://eden.so/help/custom-ai/add-creators-as-sources/)
- [Building a voice Custom AI — Eden Help](https://eden.so/help/custom-ai/build-a-voice-custom-ai/)
- [Using Eden's built-in Custom AIs — Eden Help](https://eden.so/help/custom-ai/built-in-custom-ais/)
- [Connecting knowledge to a Custom AI — Eden Help](https://eden.so/help/custom-ai/connect-knowledge/)
- [Create your first Custom AI — Eden Help](https://eden.so/help/custom-ai/create-your-first-custom-ai/)
- [Give your Custom AI a routine — Eden Help](https://eden.so/help/custom-ai/custom-ai-routines/)
- [Use case: a mentor grounded in someone's real ideas — Eden Help](https://eden.so/help/custom-ai/learn-from-a-mentor/)
- [Meet Custom AI: what changed and why — Eden Help](https://eden.so/help/custom-ai/meet-custom-ai/)
- [Use case: a Newsletter Writer that knows your newsletter — Eden Help](https://eden.so/help/custom-ai/newsletter-writer/)
- [Use case: one Custom AI per client — Eden Help](https://eden.so/help/custom-ai/one-custom-ai-per-client/)
- [Use case: a research analyst for your niche — Eden Help](https://eden.so/help/custom-ai/research-analyst-for-your-niche/)
- [Sharing and installing Custom AIs — Eden Help](https://eden.so/help/custom-ai/share-and-install-custom-ais/)
- [Use case: turn your reading into a study companion — Eden Help](https://eden.so/help/custom-ai/study-companion-from-your-reading/)
- [Weekly Strategist — Eden Help](https://eden.so/help/custom-ai/weekly-strategist/)
- [What is a Custom AI — Eden Help](https://eden.so/help/custom-ai/what-is-a-custom-ai/)
- [Where did Prompts and Identities go? — Eden Help](https://eden.so/help/custom-ai/where-did-prompts-and-identities-go/)
- [Use case: write with a creator's voice — Eden Help](https://eden.so/help/custom-ai/write-in-a-creators-voice/)
- [Discover — Eden Help](https://eden.so/help/discover/)
- [Filtering Discover by platform, pillar, and outlier — Eden Help](https://eden.so/help/discover/filtering-discover/)
- [How to find outlier TikToks in your niche — Eden Help](https://eden.so/help/discover/find-outliers-on-tiktok/)
- [How to find outlier X posts in your niche — Eden Help](https://eden.so/help/discover/find-outliers-on-x/)
- [How to find outlier YouTube videos in your niche — Eden Help](https://eden.so/help/discover/find-outliers-on-youtube/)
- [Reading the outlier multiplier — Eden Help](https://eden.so/help/discover/outlier-multiplier/)
- [Getting the most out of Discover search — Eden Help](https://eden.so/help/discover/search-best-practices/)
- [Eden MCP — Eden Help](https://eden.so/help/eden-mcp/)
- [Using boards, documents, and lists in the Eden MCP — Eden Help](https://eden.so/help/eden-mcp/attaching-context/)
- [Eden agent skill for Codex, Claude Code, and Cursor — Eden Help](https://eden.so/help/eden-mcp/coding-agent-skill/)
- [Connect Claude, Cursor, or ChatGPT to your Eden workspace — Eden Help](https://eden.so/help/eden-mcp/connecting-ai-assistants/)
- [Connect Eden to Hermes Agent — Eden Help](https://eden.so/help/eden-mcp/connecting-hermes-agent/)
- [Connect Eden to Make — Eden Help](https://eden.so/help/eden-mcp/connecting-make/)
- [Connect Eden to n8n — Eden Help](https://eden.so/help/eden-mcp/connecting-n8n/)
- [Connect Eden to Raycast — Eden Help](https://eden.so/help/eden-mcp/connecting-raycast/)
- [Connect Eden to Zapier — Eden Help](https://eden.so/help/eden-mcp/connecting-zapier/)
- [Content Command Center: a free Claude workflow for your analytics — Eden Help](https://eden.so/help/eden-mcp/content-command-center-workflow/)
- [Using your Custom AIs through the Eden MCP — Eden Help](https://eden.so/help/eden-mcp/custom-ai/)
- [Head of Content: a free Claude workflow that runs your content week — Eden Help](https://eden.so/help/eden-mcp/head-of-content-workflow/)
- [Idea Engine: a free Claude workflow for daily post ideas — Eden Help](https://eden.so/help/eden-mcp/idea-engine-workflow/)
- [Install the Eden MCP from the command line — Eden Help](https://eden.so/help/eden-mcp/installing-with-cli/)
- [Personal Brand Strategist: a free Claude workflow — Eden Help](https://eden.so/help/eden-mcp/personal-brand-strategist-workflow/)
- [Eden MCP quick start: research social data inside Claude — Eden Help](https://eden.so/help/eden-mcp/quick-start/)
- [Getting the latest Eden MCP tools and slash commands — Eden Help](https://eden.so/help/eden-mcp/refreshing-tools/)
- [Using Custom AI as slash commands — Eden Help](https://eden.so/help/eden-mcp/slash-commands/)
- [Weekly Strategist: a free Claude workflow for content strategy — Eden Help](https://eden.so/help/eden-mcp/weekly-strategist-workflow/)
- [Getting started — Eden Help](https://eden.so/help/getting-started/)
- [Connecting Readwise to Eden — Eden Help](https://eden.so/help/getting-started/connect-readwise/)
- [Download the Eden Android beta — Eden Help](https://eden.so/help/getting-started/download-the-android-beta/)
- [Download the Eden desktop app for Mac — Eden Help](https://eden.so/help/getting-started/download-the-mac-app/)
- [Quick capture — Eden Help](https://eden.so/help/getting-started/quick-capture/)
- [Saving to Eden from your iPhone — Eden Help](https://eden.so/help/getting-started/saving-from-your-iphone/)
- [Set up Eden for your agency — Eden Help](https://eden.so/help/getting-started/set-up-eden-for-your-agency/)
- [The complete Eden walkthrough — Eden Help](https://eden.so/help/getting-started/the-complete-eden-walkthrough/)
- [A 5-minute tour of Eden — Eden Help](https://eden.so/help/getting-started/welcome-to-eden/)
- [Library — Eden Help](https://eden.so/help/library/)
- [Sync your Instagram saves — Eden Help](https://eden.so/help/library/connect-instagram-saves/)
- [Connect your Kindle highlights — Eden Help](https://eden.so/help/library/connect-kindle/)
- [Connect your Snipd podcast snips — Eden Help](https://eden.so/help/library/connect-snipd/)
- [Connecting items (backlinks) — Eden Help](https://eden.so/help/library/connecting-items/)
- [Creating items directly in the Library — Eden Help](https://eden.so/help/library/creating-items-in-the-library/)
- [Filtering and browsing your Library — Eden Help](https://eden.so/help/library/filtering-your-library/)
- [Highlighting while you read — Eden Help](https://eden.so/help/library/highlighting-while-reading/)
- [Import your Apple Notes — Eden Help](https://eden.so/help/library/import-apple-notes/)
- [Import your Evernote notes — Eden Help](https://eden.so/help/library/import-evernote/)
- [Import your Notion workspace — Eden Help](https://eden.so/help/library/import-notion/)
- [Import your Obsidian vault — Eden Help](https://eden.so/help/library/import-obsidian/)
- [Neural relations: your Library while you write — Eden Help](https://eden.so/help/library/neural-relations/)
- [Add notes to saved items — Eden Help](https://eden.so/help/library/notes-on-saved-items/)
- [Pinning what you use most — Eden Help](https://eden.so/help/library/pinning/)
- [Reader for social posts and videos — Eden Help](https://eden.so/help/library/reader-for-social-and-video/)
- [Reading saved articles in Eden — Eden Help](https://eden.so/help/library/reader-view/)
- [Reading EPUBs in Eden — Eden Help](https://eden.so/help/library/reading-epubs/)
- [Reading PDFs in Eden — Eden Help](https://eden.so/help/library/reading-pdfs/)
- [Follow RSS feeds in your Library — Eden Help](https://eden.so/help/library/rss-feeds/)
- [Saving paid and members-only articles — Eden Help](https://eden.so/help/library/saving-paid-articles/)
- [Searching your Library with AI — Eden Help](https://eden.so/help/library/searching-your-library/)
- [How Eden assigns sources — Eden Help](https://eden.so/help/library/sources/)
- [Tagging items with workspace tags — Eden Help](https://eden.so/help/library/tags/)
- [The graph view: see your Library as a map — Eden Help](https://eden.so/help/library/the-graph-view/)
- [The Highlights pane — Eden Help](https://eden.so/help/library/the-highlights-pane/)
- [The Library: everything you've saved, in one place — Eden Help](https://eden.so/help/library/the-library/)
- [Scheduling — Eden Help](https://eden.so/help/scheduling/)
- [Connect your social accounts — Eden Help](https://eden.so/help/scheduling/connecting-your-accounts/)
- [Set up a custom link domain — Eden Help](https://eden.so/help/scheduling/custom-link-domain/)
- [Schedule Facebook posts with Eden — Eden Help](https://eden.so/help/scheduling/facebook-scheduling/)
- [Instagram Auto-DMs — Eden Help](https://eden.so/help/scheduling/instagram-auto-dm/)
- [Schedule Instagram posts with Eden — Eden Help](https://eden.so/help/scheduling/instagram-scheduling/)
- [Schedule LinkedIn posts with Eden — Eden Help](https://eden.so/help/scheduling/linkedin-scheduling/)
- [Manage multiple brands — Eden Help](https://eden.so/help/scheduling/managing-brands/)
- [Turn a post into an image — Eden Help](https://eden.so/help/scheduling/post-images/)
- [Schedule and publish posts — Eden Help](https://eden.so/help/scheduling/scheduling-and-publishing/)
- [Schedule Substack notes with Eden — Eden Help](https://eden.so/help/scheduling/substack-scheduling/)
- [Schedule Threads posts with Eden — Eden Help](https://eden.so/help/scheduling/threads-scheduling/)
- [Schedule TikTok posts with Eden — Eden Help](https://eden.so/help/scheduling/tiktok-scheduling/)
- [Scheduling troubleshooting — Eden Help](https://eden.so/help/scheduling/troubleshooting-scheduling/)
- [Schedule X (Twitter) posts with Eden — Eden Help](https://eden.so/help/scheduling/x-scheduling/)
- [Schedule YouTube Shorts with Eden — Eden Help](https://eden.so/help/scheduling/youtube-scheduling/)
- [Troubleshooting — Eden Help](https://eden.so/help/troubleshooting/)
- [Coming from a beta.eden.so account — Eden Help](https://eden.so/help/troubleshooting/beta-account-migration/)
- [Recovering a deleted item — Eden Help](https://eden.so/help/troubleshooting/recovering-a-deleted-item/)
- [Custom AI Marketplace — Expert AI for Writing, Research, and Strategy | Eden](https://eden.so/marketplace/)
- [Eden Pricing | Curator and Creator Plans](https://eden.so/pricing)
- [Eden Pricing | Curator and Creator Plans](https://eden.so/pricing/)
- [Free tools for creators | Eden](https://eden.so/tools/)
- [Free Claude workflows for creators | Eden](https://eden.so/workflows/)
- [Content Command Center: a free Claude workflow | Eden](https://eden.so/workflows/content-command-center/)
- [Head of Content: a free Claude workflow that runs your content week | Eden](https://eden.so/workflows/head-of-content/)
- [Idea Engine: a free Claude workflow for daily content ideas | Eden](https://eden.so/workflows/idea-engine/)
- [Personal Brand Strategist: a free Claude workflow | Eden](https://eden.so/workflows/personal-brand-strategist/)
- [Weekly Strategist: a free Claude workflow for content strategy | Eden](https://eden.so/workflows/weekly-strategist/)

## Recommended architecture and delivery order

This order is a dependency sequence for achieving the full matrix, not a reduction of scope. Keep every feature ID in a delivery ledger with status, evidence and remaining credential dependency.

1. **Persistent workspace core.** Use a TypeScript web app with a server API, relational database, private blob storage and tenant-aware auth. Model Workspace, Membership, Item, Board, BoardPlacement, Section, Tag, Connection, DocumentVersion, ShareGrant, Comment, Table, Column, Row, CustomAI, Chat, Message, Skill, Routine, Brand and ScheduledPost explicitly. Store board placement separately from the reusable library item. All server requests derive authorization from session and membership rather than trusting a client workspace ID.
2. **Provider and capability boundary.** Define interfaces for AI generation/embedding, content ingestion, social search, publishing, analytics, messaging, business connectors, speech, image rendering and notification. Every capability exposes configured/connecting/ready/degraded/unavailable with a concrete reason. Tests can use fixtures; production data and demo fixtures must never be silently mixed. Persist OAuth tokens encrypted and do not ship secrets to browser.
3. **Knowledge workspace and editing.** Implement Library, notes, uploads, grids/canvas/sections, tables in four views, semantic search/graph, reader/highlights/import/export, permissioned sharing/comments/history. Choose established canvas/editor/table libraries where appropriate. Integrate source extraction and indexing via durable jobs; preserve originals and citation locations.
4. **AI and workflows.** One server-side tool registry powers chat, background tasks, Custom AIs, portable skills, routines and the public MCP server. Implement retrieval scoping, tool execution traces, model configuration, async job progress and durable workflow memory. The five workflows should compose real existing tools, produce structured outputs with receipt IDs and save result items. Head of Content produces reviewable drafts; publishing remains its own intentional action.
5. **External rails and companions.** In parallel, configure developer/provider accounts for seven-network research, eight-destination publishing, private analytics, ads, Meta messaging and business connectors. Build the Chrome companion for local-only Substack/Instagram Saves flows and web capture; ship a documented local install initially if store release is not yet available. Implement provider callbacks, refresh/revoke and audit trails. Do not convert a successful connection screen into a claim that post delivery works; test an authorized private/sandbox flow end to end.
6. **Operational pipeline and Azure.** Deploy stateless web/API plus worker, durable database and Blob storage in an explicitly chosen resource group. Environment configuration includes base URL, database/storage, key encryption, OAuth redirect URIs, model provider, webhook signatures and job queues. Add health/readiness, migrations, structured logs, cancellation, retry/backoff, dead-letter/error visibility, backup and restore. Use UTC persistence and named IANA zones for display/routines.
7. **Product completeness.** Add plan entitlements/credit ledger/billing, settings, marketplace, email/push/Telegram, tracked links/custom DNS, responsive polish, keyboard flows and account lifecycle. Native clients are separately documented product surfaces; responsive web fulfills the requested app form, while the companion is necessary for the specifically documented browser-session features.
8. **Verify against the matrix.** Minimum integration cases: tenant isolation on read/write/search/upload/share; data survives reload/redeploy; reference reuse across boards; editor/table autosave and undo; reproducible job retry without duplicate posts/charges; sourced workflow results; missing-provider states; expired OAuth; cancel-vs-publish race; webhook dedupe; share revocation and history restore. Browser verification should cover primary flows and responsive views. Record each external capability pending until real authorized credentials and provider results establish it.

Suggested main modules: `workspace`, `library`, `boards`, `editor`, `tables`, `reader`, `search`, `research`, `chat`, `custom-ai`, `skills`, `workflows`, `routines`, `publish`, `analytics`, `auto-dm`, `connectors`, `mcp`, `auth`, `billing`, `jobs`, `extension`. Keep the feature ledger in docs and report shipped vs blocked at feature granularity.
