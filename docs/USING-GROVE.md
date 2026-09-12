# Using Grove

Open your Grove installation and sign in with the account created during setup. For local development, open `http://localhost:5173`. Keep any owner login files under the private, Git-ignored `.data/` directory. The registration code is reserved for creating additional accounts; normal use only needs email and password.

1. **Capture a source.** Open Library → New item. Write a note, save a URL, upload a document/media file, or import a Markdown/CSV/JSON/ENEX/ZIP export. Choose a destination board and remember it for later captures. Stars pin items for your account; library filters and recently opened items follow you between sessions.
2. **Organize the work.** Create a board and add existing library items. The same source can appear on several boards. Switch to Canvas to arrange or resize cards, draw, add shapes and text, and undo changes. Hold Space to pan; use the zoom controls or Fit. Canvas saves automatically and offers recovery if a save fails. Create a typed table for a content pipeline.
3. **Write with context.** Open Chat, choose source notes/boards, and ask a question. A Custom AI adds reusable instructions and a selected knowledge boundary. Generated chats and workflow documents start private so retrieved knowledge does not silently become shared.
4. **Run a workflow.** Choose Weekly Strategist, Head of Content, Content Command Center, Personal Brand Strategist, or Idea Engine. Give it your goal and sources. Save a reusable setup or run it once. Recent runs shows each persisted step, its result document, and any generated idea cards or unapproved drafts. Missing evidence is listed in the report. Chat’s Deep Social and Deep Synthesis modes also create these background research runs.
5. **Set a rhythm.** Create a routine, choose timezone and cadence, and select a workflow. Results stay in the app. Optional Telegram delivery requires a configured connection and explicit delivery enablement.
6. **Prepare publishing.** Create a draft in Publish. Generate platform variants, review and approve the copy, choose connected destinations, then schedule or publish. Editing approved copy withdraws approval. Failed or uncertain delivery needs review; the worker does not blindly resend.
7. **Connect your accounts.** Open Connections for social, research, knowledge and business services. Azure AI and private storage are configured by deployment. Social apps still require your approved OAuth application or access token, account eligibility and API permissions. See [Provider setup](PROVIDER-SETUP.md).
8. **Research and measure.** Discover uses configured providers or authorized imports. Analytics displays connected/imported metrics. An empty view means no data is connected; missing metrics remain unavailable instead of being presented as zero.
9. **Collaborate deliberately.** Set a board/item private or workspace-visible, invite individual viewers/commenters/editors, or create a revocable public link. Settings manages workspace membership and scoped API/MCP tokens.
10. **Capture from Chrome.** Open Extension, download the ZIP, unzip it, then load the directory through Chrome's extension manager. Configure your Grove URL, workspace ID and a narrowly scoped token. Toolbar/context-menu capture works without exporting source-site cookies.

Open a note’s **Write** tab to type `/` for blocks or `@` to link a workspace item. Linked items show backlinks. The related-source switch finds suggestions for your current paragraph; choose a result to insert it. The Markdown tab preserves tables, tasks, images and other source blocks. Rich blocks that need Markdown display a preview and an editable source block. A table embedded in a document shows a live preview; **Open table** opens its full editor.

Tables support typed properties, options/colors, item links, range copy/paste, saved views, kanban and calendar. Use row details to create or attach a workspace document, add related items, or configure recurrence. Completion advances a recurring row to its next future date; Undo restores the latest completion. Removed rows stay recoverable inside the table.

Use **Reader** for source search, EPUB chapters, colored highlights and browser narration. Your reading position and personal notes save separately from the source. Highlights start private; use their sharing controls when teammates need access. PDF highlights use extracted readable text; the original PDF has a saved-page field. In Library, **graph view** reveals links and hubs; drag to pan, scroll to zoom and select a hub to see related items.

In Chat, choose the microphone button, **Start recording**, then **Stop recording**. **Transcribe recording** saves a private audio item and converts it to text. Review the transcript and choose **Use transcript** to insert it into your message. Send it when ready. Closing before transcription discards only the local recording; an uploaded recording remains privately in Library.

If saving fails, keep the editor open and retry. Browser recovery stores a local draft when storage is available. If a newer server version exists, the recovery prompt lets you keep the server copy or review the recovered draft before saving.

Use Command/Ctrl-K to search or create quickly. Creator tools include text counters, an engagement calculator and an exportable post-image renderer. Library media can be transcribed when a transcription provider is configured.

Grove is an independently built web application, not a connection to Eden. It does not inherit Eden's licensed research corpus, private account data, platform app approvals, subscription, or native client distribution.

The **Start here** board contains this guide, a blank creator brief and an empty content-pipeline table. Fill out the brief, select it as a workflow source, and run Personal Brand Strategist for a first positioning report. Idea Engine needs two distinct evidence categories (for example, your notes plus saved social or format references); it reports the missing evidence when only a blank brief is available. Social destinations remain disconnected until you add your own authorized accounts.

Grove remains pilot software. The [feature coverage ledger](feature-coverage.md) records remaining gaps in embedded table editing, PDF layout reconstruction, broader research coverage, companion sync, native clients and provider-specific capabilities; this release is not full Eden parity.

## Publish website articles

Open **Website articles** to draft and review English or Simplified Chinese
articles for your configured destinations. Choose destination websites, save
privately, review the saved preview, then publish. Editing a draft does not
change a public copy until you publish again. Unpublish removes one destination
while retaining the Grove document. See [website publishing](website-publishing.md)
for the full workflow and shared-database contract.
