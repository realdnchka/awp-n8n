# Workflows

n8n workflow JSONs, version-controlled here. The `n8n-import` sidecar in `docker-compose.dev.yml` syncs every JSON in this directory into n8n via its REST API on every `docker compose up` (and on demand via `docker compose run --rm n8n-import`). See `awp-n8n/README.md` *Workflow sync* for the full mechanism.

The directory is also mounted **read-only** into the live n8n container at `/home/node/workflows` for potential future bootstrapping; n8n itself doesn't auto-read it.

The sidecar matches by the workflow's **`name`** field (not by the top-level `id` — n8n's API generates its own IDs). Keep names unique inside this folder.

## Naming convention

`NN_descriptive_name.json` — two-digit prefix groups workflows by milestone (`00` for the M0 smoke test, `01..` for M1 PM intake, etc.). Workflows added later within a milestone use the next free two-digit number.

## M0 inventory

### `00_hello_world.json` — smoke test

Linear pipeline that proves the M0 wiring works end to end:

```
Webhook (POST /webhook/hello)
   ↓
Read /home/node/awp-agents/README.md   ← proves the awp-agents volume is mounted and readable
   ↓
POST http://echo-mcp:8800/echo         ← proves the MCP-server container is reachable by name
   ↓
Respond (text + Content-Type: application/json + JSON.stringify)
```

The Respond node uses `respondWith: "text"` + an explicit `Content-Type: application/json` header rather than `respondWith: "json"` — object-returning expressions in the JSON-respond mode are flaky across n8n versions and occasionally return empty bodies. The text mode + `JSON.stringify(...)` is version-stable.

It reads `README.md` only because it's a file guaranteed to exist; a real (M1+) workflow reads `agents/<role>/prompts/system.xml`.

## Verifying after sync

After the sidecar prints `[awp-sync] activated` for `00 — hello world`:

```bash
curl -s -X POST http://localhost:5678/webhook/hello \
  -H 'content-type: application/json' \
  -d '{"hello":"world"}' | jq
```

Expected JSON includes `agents_mounted: true`, `agents_file_name: "README.md"`, and `echo_mcp.echo.text: "from n8n"`. Both lines present ⇒ M0 closed.

If the webhook returns `404 — webhook not registered`:
- the sidecar didn't actually activate (no `N8N_API_KEY` set, or `"active": false` in the JSON);
- you hit `/webhook-test/hello` instead of `/webhook/hello` — test endpoints only fire when you click `Execute workflow` in the editor.

## Authoring rules

- **Unique `name` is mandatory.** It is the sync key. Two JSONs with the same `name` would resolve to the same n8n workflow and overwrite each other.
- **Top-level `id` is informational only.** n8n's REST API generates its own IDs on `POST /api/v1/workflows`. Hand-picked UUIDs in the JSON are kept for readability but are not used by the sync.
- **No `webhookId` in `Webhook` nodes.** Leave it absent — n8n assigns one. Hardcoding stale UUIDs from a previous export can cause `URL contained a reference to an unknown node` errors.
- **`"active": true`** to have the workflow live immediately after sync; `false` to leave it paused.
- **File naming**: `NN_descriptive_name.json` — two-digit prefix groups workflows by milestone (`00` = M0 smoke, `01..` = M1 PM intake, etc.).

## Editing workflows (round-trip)

n8n is the source of truth at runtime; JSONs here are the source of truth in git. The round-trip:

1. Edit in the n8n editor.
2. `…` menu → `Download` → save over the matching `NN_*.json` here.
3. `git commit` (conventional commits, scope `workflow`: `feat(workflow): add PM intake`).
4. Next `docker compose up` (yours or anyone else's) re-imports the updated version — no manual UI work needed.

Heavy iteration without a full restart:

```bash
docker compose run --rm n8n-import
```

If you renamed nodes inside an active workflow and the editor shows `Node not found`: delete the workflow in the UI, then re-run the sidecar.

## M1 inventory

### `01_pm_intake.json` — Jira intake + PM decomposition

Polls Jira every 60s as the `awp-pm` service account, finds Epics assigned to `awp-pm` in status `To Do` that haven't been touched yet, and feeds each into the PM agent. The agent decomposes into ≤ 10 Stories (or asks for clarification); valid Stories get created back in Jira, the Epic transitions `To Do → In Progress`.

```
Schedule (every 60s)
  ↓
Jira: search PM-assigned Epics   (JQL: project = ATF AND type = Epic AND status = "To Do" AND assignee = currentUser() AND (labels IS EMPTY OR labels NOT IN (Needs_Clarification)))
  ↓
Read PM system prompt            (/home/node/awp-agents/agents/pm/prompts/system.xml, inlined at sync time via {{INCLUDE}})
  ↓
Prep Epic + prompt               (Code: decode prompt binary → utf-8, extract workspace domain from epic.self, build user-message JSON)
  ↓
PM Agent  ⇐ ai_languageModel ⇐ Anthropic Chat Model (claude-sonnet-4-5)
  ↓
Parse PM output                  (Code: parse <output>{...}</output>, validate schema, build a full Jira REST payload per story with proper parent.key and {value: ...} option-wrapping for single-select fields)
  ↓
Needs clarification?             (IF)
  ├─ true ──→ Jira: label Epic Needs_Clarification → Jira: comment with questions
  └─ false ─→ Jira: create Story (REST)   (N input items → N HTTP requests, serial)
                  ├──→ One item per Epic           (Code: group story responses into one item per Epic;
                  │       ↓                         carries storyKeys, ADF rewrite, token totals)
                  │       ├──→ Jira: audit comment on Epic    (POST comment: decomp summary + quoted original description)
                  │       ├──→ Jira: update Epic (description + token totals)  (PUT description ADF + customfield_10043/10044)
                  │       ├──→ Jira: list boards for project → Pick board for project → Jira: move Stories to board
                  │       └──→ Jira: list Epic transitions → Pick "In Progress" transition → Jira: Epic To Do → In Progress
                  │
                  └──→ Build issue link specs      (Code: localId → jiraKey + depends_on → one item per blocker pair)
                          ↓
                      Jira: link Story blockers    (POST /rest/api/3/issueLink per item, type=Blocks)
```

**Why no SplitInBatches loop around Story creation.** We tried the obvious "loop with `batchSize=1`" pattern first, but it broke `One item per Epic`: when a Code node sits OUTSIDE a loop and reads `$('Jira — create Story (REST)').all()` (a node INSIDE the loop), n8n returns only the items from the FINAL iteration, not the accumulated outputs across all iterations. The visible symptom: only the last Story (e.g. `ATF-41` out of 8) ended up in `storyKeys`, the audit comment listed `1 Stories`, and the board-move call moved only that one. Removing the loop lets the HTTP Request node handle N input items in its native one-execution-emits-N-outputs mode, which keeps `$('NodeName').all()` truthful. Jira tier-1 rate limits (~10 req/s) absorb 10 stories per Epic per minute comfortably, so we lose nothing by dropping the explicit throttle.

**Routing model.** The user opts into PM decomposition by setting `assignee = awp-pm` on the Epic at file time. `currentUser()` in the JQL resolves to whatever Jira account the `jira:awp-pm` credential authenticates as (i.e. `awp-pm`'s `accountId`), so this workflow is workspace-portable — no hardcoded account IDs in the search step. New Stories created via `POST /rest/api/2/issue` land in `status = "To Do"` by default (Jira default for new issues), so no extra Story-transition step is needed.

**Why HTTP Request for everything mutating, not the native Jira node**: n8n's `n8n-nodes-base.jira` has two unrelated bugs that bite us — (1) the `Create Issue` operation silently ignores `parentIssueKey` for non-subtask issuetypes, which breaks Epic Link on Stories in team-managed projects; (2) the issue-transition operation has been renamed across n8n versions (`transitionStatus`, `transitions`, `update + statusId`…) and some versions remove it entirely, so a workflow exported on one n8n version fails validation on another. Both problems disappear by hitting the Jira REST API directly via the HTTP Request node, authenticated via `nodeCredentialType: jiraSoftwareCloudApi` so it still goes through the same `jira:awp-pm` credential.

**Atlassian `/search/jql` body asymmetry**: in `POST /rest/api/{2,3}/search/jql` the request schema has `fields` typed as **array** of strings but `expand` typed as a single **string** of comma-separated values (`"changelog"`, `"changelog,names"`, …). Sending `expand: ["changelog"]` returns a useless `400 Invalid request payload` with no indication of which field is wrong. Same story for the deprecated `/rest/api/3/search` GET endpoint. We tripped over it when adding `expand: 'changelog'` to read the Epic's edit history for the audit-comment author-resolver. Schema-checked against [Atlassian's official docs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post). If we ever need multiple expand values, write `'changelog,names'` not `['changelog', 'names']`.

**How the Epic transition is resolved.** Instead of hardcoding a numeric transition ID (workspace-specific, error-prone), the workflow:

1. `HTTP GET /rest/api/3/issue/{epicKey}/transitions` — Atlassian returns the transitions currently available for the issue.
2. `Pick "In Progress" transition` (Code) — picks the one whose `to.name == "In Progress"` (falling back to `name == "In Progress"`). Errors loudly with the list of available transitions if none matches, so you can see why and fix the workflow in Jira (e.g. add an explicit transition to `In Progress`).
3. `HTTP POST /rest/api/3/issue/{epicKey}/transitions` — body `{ transition: { id: <picked> } }`. `continueOnFail: true` so a misconfigured Jira workflow can't block Story creation that already succeeded above.

This means **you don't have to find or paste any transition ID** — the workflow self-configures from whatever transitions you have wired in Jira.

**Status**: shipped as `"active": false`. Credentials (`jira:awp-pm`, `anthropic`) are matched by name on import — verified by running `docker compose run --rm n8n-import` and reading the workflow back via `GET /api/v1/workflows/<id>`; n8n resolved both correctly without UI intervention.

Before activating, in n8n UI: just toggle the workflow to `Active`. No node-level tuning required (the auto-resolving transition above replaces the previous "go set the transition ID in the dropdown" step).

The system prompt at `/home/node/awp-agents/agents/pm/prompts/system.xml` is **baked into the Code node at sync time** via the `{{INCLUDE:agents/pm/prompts/system.xml}}` marker — edit the file, then run `docker compose run --rm n8n-import` to re-sync. n8n's editor will then show the new prompt as a string literal inside `Prep Epic + prompt`'s `jsCode`. See `awp-n8n/README.md` § "INCLUDE markers" for the underlying mechanism.

The `Parse PM output` Code node hardcodes two maps that **must stay in sync** with their yaml source-of-truth:

- accountIds for `dev` / `qa` / `devops` ← `awp-agents/agents/shared/jira-accounts.yaml`
- customfield IDs for `role` / `tier` / `acceptance_criteria` / `estimate_input_tokens` / `estimate_output_tokens` ← `awp-agents/agents/shared/jira-fields.yaml`

When you rename a custom field in Jira UI, only the display name changes; `customfield_NNNNN` is locked at creation. So the hardcoded map is stable as long as the underlying fields exist. If you ever recreate a custom field (which mints a new `customfield_NNNNN`), update both the yaml and the Code node.

### Swapping the chat model for cheap testing

The workflow ships a second chat-model node — `Google Gemini Chat Model (test, unwired)` — parked next to the live `Anthropic Chat Model` but **not connected** to anything. It exists so we can switch the PM Agent to Gemini 3.5 Flash for throwaway runs (free tier on Google AI Studio, ~1500 req/day) without editing JSON or rebuilding the workflow.

To switch from Anthropic → Gemini:

1. In the n8n editor, click the line connecting `Anthropic Chat Model` → `PM Agent` (the `ai_languageModel` input). Press <kbd>Delete</kbd>.
2. Drag from the output dot of `Google Gemini Chat Model (test, unwired)` onto the same `PM Agent` input. The label `ai_languageModel` will appear.
3. Run `Execute Workflow`. PM Agent is now answered by Gemini.

One-time setup of the credential (do once per workspace):

1. Get an API key at <https://aistudio.google.com/apikey>. Free tier is fine.
2. In n8n → Credentials → Create new → type `Google Gemini(PaLM) API` → Name: `google-gemini` → paste API key → Save. The host defaults to `https://generativelanguage.googleapis.com` which is correct.

To switch back: delete the Gemini → PM Agent edge, reconnect Anthropic → PM Agent. Production polling should always end up on Anthropic; the Gemini node is a scratch lever, not a deploy target.

Cost / behaviour notes:
- Free Gemini 3.5 Flash is plenty for PM (1M-token context, 64k-token output cap, ~4x faster than Sonnet on output tokens/s) but it's somewhat looser on instruction-following than Sonnet 4.5. Expect the occasional malformed `<output>` wrapper that the parser will catch and route to Clarification.
- Don't leave the workflow running on Gemini permanently — the free tier has a 1500 req/day soft quota and Google reserves the right to throttle. For real decomposition use Sonnet 4.5; for cheap iteration on the prompt or the workflow plumbing use Gemini.

### Testing the PM intake

1. File a Jira Epic with a fleshed-out description, **set `Assignee = awp-pm`** (this is the routing signal), leave status at its default `To Do`, and do **not** add the `Needs_Clarification` label.
   - Epics in team-managed Jira don't appear on the Kanban board (they're containers). Find them under **Backlog tab → Epics panel** on the right side, or filter the Backlog by `Type = Epic`, or run `project = ATF AND type = Epic` in JQL search.
2. Wait ≤ 60s, or trigger the workflow manually via the editor's `Execute Workflow` button.
3. Expected: N Stories appear in the project, each `parent`-linked to the Epic, with `AWP Role`/`AWP Tier`/`AWP Acceptance Criteria`/`AWP Estimated Input Tokens`/`AWP Estimated Output Tokens` filled, and `assignee` set to the corresponding service account (`awp-dev`/`awp-qa`/`awp-devops`). Stories land in `status = "To Do"` (Jira default). The Epic transitions `To Do → In Progress` automatically (the workflow looks up the right transition ID by name).
4. Vague Epic test: file an Epic whose description is "do the thing" or similar with `assignee = awp-pm` — PM should add the `Needs_Clarification` label and post a comment with its questions. The Epic stays in `To Do` with `assignee = awp-pm`; the label keeps it out of the JQL until you remove it.

## Planned

- `02_classifier.json` (M2) — fast-track router for already-scoped Stories.
- `03_dev_loop.json` (M2) — Dev agent → branch + PR + CI status push back to Jira; writes `awp.actual_*` fields.
- `04_review_debug.json` (M3) — Reviewer / DevOps with iteration limits (`debug=2`, `review=3`) and Telegram escalations.
- `06_pm_comment_webhook.json` (M3.5) — Jira `issue_commented` webhook → wakes the PM agent on `Needs_Clarification` Epics so the human can answer in a Jira comment instead of editing the Epic description. Requires the public n8n endpoint from `PLAN.md` §15. Polling in `01_pm_intake.json` stays as a fallback.
- `05_dispatch.json` (M4) — periodic dispatcher honouring per-role caps from `.env`, using atomic Jira status transitions.
- `07_telegram_bot.json` (M7, post-MVP) — Telegram bot webhook: main menu, per-role and per-task chat threads, push notifications with action buttons. Replies typed in Telegram become Jira comments and re-enter via `06_pm_comment_webhook.json`. See `PLAN.md` §16.
- `99_calibrate_estimates.json` (M6) — cron that aggregates `actual / estimate` ratios into `awp-agents/agents/shared/estimates.md`.
