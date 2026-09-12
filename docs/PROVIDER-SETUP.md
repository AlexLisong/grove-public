# Provider setup

Configure only the providers your installation needs. API keys and OAuth secrets stay on the server. Provider plans, model availability and app approvals are separate from Grove. For local text generation, set `OPENAI_API_KEY` and `OPENAI_MODEL`; Azure OpenAI and managed identity are optional. See [self-hosting](self-hosting.md) for configuration and storage.

Accounts require a private registration code at signup. Scope API tokens to the client’s task and revoke unused tokens.

## Social accounts

Connections accepts approved access tokens and relevant account IDs. OAuth buttons work after the administrator sets `{PROVIDER}_CLIENT_ID` and `{PROVIDER}_CLIENT_SECRET`. Providers are `X`, `LINKEDIN`, `YOUTUBE`, `FACEBOOK`, `INSTAGRAM`, `THREADS`, `TIKTOK`. Register the exact callback `https://<grove-host>/api/oauth/<provider>/callback`. Consult the official developer portal for current scopes, eligibility, app review, token lifetime and API plan.

- **X:** user-authorized read/write token and user ID. Recent search requires an API plan. A thread uses lines containing `---` between posts. Media upload requires approved media scopes.
- **Instagram:** professional account ID, Meta app approval, content publishing and relevant insights/messaging scopes. Account ID must refer to the Instagram professional account. Meta webhook callback is `/api/webhooks/instagram`; set `INSTAGRAM_APP_SECRET` and `INSTAGRAM_VERIFY_TOKEN`. Auto-DM rules must be explicitly enabled. Grove enforces dedupe and conservative sending caps in addition to provider restrictions.
- **Facebook:** Page ID and Page access token. User access tokens alone do not grant Page publishing.
- **Threads:** Threads-specific token and account ID. Container creation and publishing are separate provider operations.
- **LinkedIn:** member or organization URN and approved permissions. Organization analytics needs its approved API product. The current media adapter supports image and text publishing; native video/document media require the additional upload protocol.
- **YouTube:** authorized channel with upload/read/analytics scopes. Uploads default private unless explicitly configured otherwise. Only use qualifying short videos for the Shorts workflow; YouTube ultimately determines Shorts eligibility. Public research can use a separate `YouTube research` API key.
- **TikTok:** approved Content Posting API app, creator-authorized token and verified media URL domain for `PULL_FROM_URL`. Unreviewed apps may be restricted to private posts. A publish ID is a processing receipt; Grove checks status before marking it published.
- **Substack:** there is no supported public server posting API. The web app copies an approved draft and opens the native editor. Grove Capture can save visible content from the user’s browser. Automatic Substack scheduling and full daily Instagram Saves synchronization are not claimed by this companion build.

No external social posts or messages are sent by the test suite. Live provider publishing requires a user-authored draft, explicit approval, connected destination, and a user publish/schedule action.

## Research corpus

The app does not possess Eden’s proprietary indexed corpus. YouTube Data API, X search and approved Meta Ad Library access can supply live research. CSV/JSON ingestion accepts authorized exports for every listed platform, retaining provenance. Outliers use earlier same-creator, same-platform posts (Instagram also same format), minimum five samples, and up to 20 earlier observations. No metric is inferred when the baseline is insufficient. Importing a partial history gives a partial baseline, clearly described in the stored record.

## Business and knowledge

Notion, Stripe, Kit, beehiiv, Klaviyo, Whop, Kajabi, Webflow, Circle and Readwise adapters accept user-provided integration keys. Provider plans and permissions control available data. Notion and Readwise import only authorized data. RSS/Atom feeds require public HTTP(S); private network URLs are rejected. Telegram delivery requires a bot token and chat ID plus explicit routine delivery enablement. The app never sends a test message on connect.

Custom HTTPS MCP servers support initialization, JSON/SSE responses, tool discovery and individually enabled tool calls. All remote results remain untrusted data. Each call requires explicit confirmation; connecting a server does not authorize automatic remote actions.

## Grove MCP

Connect to `https://<grove-host>/mcp` with a scoped API token or OAuth with PKCE. Metadata is at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`. Tools advertise actual schemas and granular scopes. Grove-prefixed tool names cover the public reference operations; `eden_` aliases map for compatibility but do not reproduce private upstream schemas. Some reference names are deliberately adapted: media preparation accepts bounded upload data rather than a proprietary multipart protocol; draft creation always stays unapproved.

## Optional SaaS billing

The default installation is self-hosted: infrastructure and connected providers bill their account owners. Optional Stripe Checkout/Portal uses separate `STRIPE_BILLING_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`; callback `/api/webhooks/stripe`. These are distinct from a user’s read-only Stripe business connector. Grove does not invent a paid subscription or invoice when billing is unconfigured.

## Client

Install the responsive web app as a PWA. Its offline cache stores only the public offline shell; it never caches authenticated API responses. Download Grove Capture from the Extension screen, unzip, and load unpacked in Chrome. Signed native iOS, Android and desktop binaries and store distribution are outside this web deployment.
