# Durable workflows and deep research

Grove's five workflows and background research now execute a saved six-step plan. They collect a bounded evidence snapshot, execute three research queries, validate a typed result, and commit private artifacts together. Ordinary chat and image/audio client routing remain independent.

## API contract

`GET /api/workflows/:id/settings` returns:

```json
{
  "settings": {
    "input": "",
    "sourceIds": [],
    "customAiId": null,
    "researchEnabled": true
  },
  "entityId": null
}
```

`PUT /api/workflows/:id/settings` accepts the `settings` object directly and returns that same response shape. It stores a private item owned by the caller. Input is at most 30,000 characters, source IDs at most 80; omitted fields use the defaults above. The route requires workspace write permission. Selected sources are checked before saving. Existing settings shared with another user cannot receive new private selections.

`POST /api/workflows/:id/run` keeps its `202 {job,entity}` response. It accepts `{input?,sourceIds?,customAiId?,researchEnabled?}`. Input can be a string or an object, as before. Missing values use saved settings. An explicit `sourceIds` override clears a saved custom assistant unless `customAiId` is also supplied. Empty input after settings resolution is rejected.

`POST /api/ai/research` keeps `202 {job}` and accepts `{input,title?,mode?:"social"|"synthesis",sourceIds?,customAiId?}`. The job now contains `data.runId`, identifying a private `workflow-run` entity. Synthesis mode uses saved source material; social mode may also use connected search providers.

`GET /api/jobs/:id` and `GET /api/entities/:runId` remain the polling endpoints. Both retain actor/tenant access checks. The completed job result and `run.data.result` have these fields:

```json
{
  "entityId": "report UUID",
  "documentId": "same report UUID",
  "runId": "workflow-run UUID",
  "draftIds": [],
  "ideaIds": [],
  "evidenceIds": []
}
```

The first three fields preserve the existing workflow response. Draft and idea IDs are new reviewable artifacts; evidence IDs refer to accessible source items. A report contains `data.structuredOutput`, `data.draftIds`, `data.ideaIds`, `data.snapshotAt`, `data.sourceIds`, and actual source citations.

## Progress and recovery

`run.data.execution` is `{version:1,startedAt,completedAt?,steps}`. Each step contains `id`, `title`, `status` (`pending`, `running`, `completed`, or `failed`), `attempts`, optional timestamps/error, and its durable `result`.

| Step ID | Result |
|---|---|
| `context` | Authorized source snapshots, owned metrics, prior-run/draft context, three planned queries and scope gaps |
| `research-1` | Topic query receipt, real evidence, provider status and gaps |
| `research-2` | Audience query receipt, real evidence, provider status and gaps |
| `research-3` | Examples/formats query receipt, real evidence, provider status and gaps |
| `synthesis` | Strictly validated workflow-specific JSON |
| `artifacts` | Committed report, draft, idea and evidence IDs |

Completed steps are reused after a worker retry or restart. A PostgreSQL advisory lock prevents concurrent executors for the same run. Job creation and its private run commit together, including deduplicated routine requests. All output items, drafts, evidence snapshots, the notification, and completion state commit in **one database transaction using one client**. A crash after that commit returns the existing result; it cannot duplicate artifacts or downgrade completion.

The existing job queue provides bounded automatic retry/backoff and lease recovery. An interrupted external AI request can be repeated if its completed response was not durably recorded; provider charges cannot be made exactly once across a crash. The existing quota reservation system remains active. Terminal failures retain their step history. Source revocation or a changed custom-assistant source list requires a new run using current sources. Deleting a completed report does not silently recreate it.

Jobs queued before durable deep-research runs existed are upgraded using the actor-bound job row as their stable identity. Their old authorization is unknown, so recovery cannot activate live research.

## Source and authorization boundaries

- An explicit nonempty source selection or a custom assistant restricts **all factual context** to those resolved sources, including board children. It excludes other workspace knowledge, metrics and drafts, and skips live provider search. The report explains this scope. Empty custom-assistant knowledge remains empty.
- Without a source restriction, the engine searches only material visible to its actor. It considers matching knowledge, owned metric records, recent strategy/run summaries and drafts. It snapshots the source text used, with provenance and capture time. Access is checked again before subsequent steps and before artifact creation; revoked sources cannot be used for another AI call.
- Live search requires an existing connected X or YouTube account/API key in the same workspace. It never creates credentials, invents a corpus, sends messages, publishes posts, or calls arbitrary tools. The engine chooses at most one connected account for each supported search API.
- Direct jobs persist the caller's research authorization before background actor reconstruction. API tokens need `research:read` to enable connected research. A server-owned `routine.data.researchAuthorized` marker preserves the same boundary for routines; old routines without that marker cannot activate live research until an authorized update.
- Research responses and imported market evidence are distinct from owned metric records. Missing provider measurements remain `null`; missing owned metrics produce explicit gaps. A provider failure is saved as `providerStatus: "unavailable"`, without leaking its raw error or credentials.
- Reports, new evidence snapshots, strategy documents, idea cards, notifications and drafts are private to the initiating actor. Workflow drafts always begin as `status: "draft"`, without approval, schedule or destination connections. Publishing continues to require the existing explicit review/approval flow.

## Typed outputs

The authoritative Zod schemas and evidence checks are in [workflow-schema.ts](../server/workflow-schema.ts). All outputs have `summary` and `gaps`; unknown action fields and unavailable evidence IDs are rejected before artifacts are created.

| Workflow | Structured result and saved artifacts |
|---|---|
| Weekly Strategist | Owned-performance summary, up to three patterns, exactly three plays, one measurable bet, and prior-bet status. Patterns require at least two different supplied creator labels; grading a prior bet requires both prior-run and owned-metric evidence. The report is saved with `artifactType: "strategy"`. |
| Head of Content | Up to seven proposed slate entries and a change log. Every entry has supplied evidence; at most one is an experiment. Each entry becomes a private unapproved draft. |
| Content Command Center | Analyst, Scout, Strategist, Planner and Repurposer, each exactly once; a source-bound repurposing draft and a saved digest. Analyst references can only point to owned metrics. No digest is sent by this workflow. |
| Personal Brand Strategist | Positioning, audience needs, origin story, topic tree, content directions, monetization hypotheses, actual reference-post IDs, unanswered interview questions, and up to five supported drafts. Saves a strategy report and private unapproved drafts. |
| Idea Engine | Up to eight cards with hook, angle, audience value, format, first step, and at least two different evidence categories and source IDs. Categories are `knowledge`, `market`, and `format`. A saved item tagged `format-reference` provides a format source. Exact normalized hooks are checked against the prior three idea runs and the draft context; repeated cards are omitted with a gap. Saves individual `type: "card"` items and a report. |
| Deep research | Evidence-cited findings, supported disagreements, next steps and gaps. Saves a report, with private snapshots for retrieved remote posts. Empty evidence produces no fabricated factual findings. |

Structured generation uses the already-configured chat model with the Responses API's strict `text.format` JSON-schema mechanism, followed by local Zod and evidence checks. The implementation follows the [official structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs), accessed 2026-09-05. A refusal, incomplete response, malformed JSON, unsupported evidence ID, or invalid domain constraint fails the synthesis step; it does not fall back to a purported success document.

## Bounds and remaining work

The query plan is deterministic: topic, audience questions, and examples/formats. It makes three provider searches at most; YouTube may need two HTTP reads per search. Each query retains at most eight saved and eight provider results. It does not claim exhaustive coverage, seven-network access, a licensed creator corpus, verified cross-platform creator identity, or semantic duplicate detection.

The current actor-visible library read is bounded at 2,000 entities. Context includes up to 24 matching knowledge items, 20 metric records, 20 drafts, three prior runs and two strategies, combined to at most 64 base evidence records. Research considers up to 120 saved corpus snapshots. Report synthesis is capped at 100 evidence records and a 145,000-character evidence payload, with explicit omission gaps. This is a compact investigation, not full-library indexing or an adaptive autonomous research tree.

Schema validation establishes shapes, source references and selected workflow rules; it does not prove every generated claim, personal story, market interpretation or forecast. Draft review is still required. Slate-wide approval, interactive brand interview state, account-specific content constraints, measured bet grading, semantic idea deduplication, broader research adapters and richer workflow memory remain follow-up product work.

## Verification

[workflows.test.ts](../tests/workflows.test.ts) uses an isolated local PostgreSQL schema, a local Responses fixture, and inert provider adapters. It exercises all five outputs, interruption before/after commits, concurrent executors, transaction rollback, source revocation, selected/custom source privacy, malformed outputs and fabricated citations, saved settings, deep-search receipts, unavailable providers, token/routine authorization and legacy recovery. [services.test.ts](../tests/services.test.ts) retains the existing worker/API, quota-adjacent and delivery/routine regressions. Tests do not call paid AI services or send social messages.
