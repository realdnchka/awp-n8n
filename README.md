# awp-n8n

n8n (Community, self-hosted) workflow host for the **AWP** project — and the *only* execution engine in the system. Workflows here orchestrate agents (Anthropic via the `AI Agent` node), call tools (MCP servers as sibling containers), persist coordination state in Jira, and react to webhooks / chats / crons.

## Status

- **M0** — done. Smoke test (`00_hello_world`) passes: webhook → read from mounted `awp-agents` → call `echo-mcp` on the shared Docker network → JSON response. See `n8n/workflows/README.md` for the verifying `curl`.
- **M1+** — see Roadmap at the bottom.

## Where this repo fits

AWP is three sibling repos plus Jira/GitHub/Anthropic externally:

```mermaid
flowchart LR
  subgraph external[External]
    Jira[(Jira Cloud)]
    GH[(GitHub)]
    Anthropic((Anthropic API))
    TG[Telegram alerts]
  end
  subgraph host[Docker host — network: awp]
    N8N["awp-n8n<br/>(n8n + SQLite)"]
    AGENTS[awp-agents<br/>read-only volume]
    MCP["awp-mcp<br/>single Go binary<br/>(echo now; runtime + fs from M2)"]
  end
  Jira -- webhooks --> N8N
  N8N -- REST --> Jira
  N8N -- REST --> GH
  N8N -- API --> Anthropic
  N8N -- mount /home/node/awp-agents --> AGENTS
  N8N -- HTTP / SSE --> MCP
  N8N -- alerts --> TG
```

- **`awp-agents`** (sibling repo): role artifacts (prompts, configs, pricing, calibration). **Mounted read-only** into the n8n container at `/home/node/awp-agents`.
- **`awp-mcp`** (sibling repo): MCP servers for the **agent's working environment only** — filesystem, shell sandbox, code intel. Consumed via the `MCP Client` node by the `AI Agent` inside its own loop. *Not* used for Jira / GitHub / Telegram — those go through native n8n nodes.

### Tools split into two layers

| Layer | Caller | Mechanism | Auth | Examples |
|---|---|---|---|---|
| **L1 — workflow plumbing** | n8n workflow (deterministic) | native n8n nodes | n8n Credentials | `Jira Software Cloud`, `GitHub`, `Telegram`, `HTTP Request` |
| **L2 — agent's environment** | the model itself (exploratory) | `MCP Client` → `awp-mcp` | none required (workspace-scoped) | filesystem, shell sandbox, grep |

The AI Agent node can attach native n8n nodes as tools too — meaning even when the model "picks" a Jira action, the call still runs through n8n's Jira node with n8n Credentials, not via MCP. This keeps credential bookkeeping single-sourced and gives every call a debuggable execution panel in the editor.

## Layout

```
docker-compose.yml         # n8n only (Community, SQLite, persistent volume)
docker-compose.dev.yml     # dev overlay: mounts ../awp-agents and builds ../awp-mcp/echo-mcp
.env.example               # required env vars (N8N_ENCRYPTION_KEY, TZ, ports)
n8n/
  workflows/               # importable workflow JSONs (mounted read-only at /home/node/workflows)
submodules/   (M2+ idea)   # eventual home of awp-agents and awp-mcp as git submodules
infra/        (M5+)        # traefik / backups / cloud-migration assets
```

State persistence: n8n keeps workflows, executions, credentials in the named Docker volume `awp_n8n_data` (mounted at `/home/node/.n8n`). `docker compose down` is safe; `down -v` wipes everything.

## M0 quick start

The three repos sit next to each other on disk:

```
~/Dev/ai/awp/
├── awp-n8n/      <- you are here
├── awp-agents/   (artifacts: prompts, configs)
└── awp-mcp/      (MCP servers)
```

1. **Prepare `.env`** (generate a strong key):

   ```bash
   cp .env.example .env
   # then edit .env: N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
   ```

2. **First boot** (n8n + echo-mcp + workflow-sync sidecar, with `awp-agents` mounted into n8n):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
   ```

   On the very first boot the sidecar can't do anything yet (no `N8N_API_KEY`) — it prints a help message and exits with code 0. n8n itself is up and accessible.

3. Open <http://localhost:5678>, **complete the one-time owner setup**, then **create the n8n API key**: `Settings → n8n API → Create an API key`. Paste the key into `awp-n8n/.env`:

   ```bash
   N8N_API_KEY=eyJhbGc…
   ```

4. **Run the sidecar** (creates the workflows under your owner account and activates them):

   ```bash
   docker compose run --rm n8n-import
   ```

   Expected output: one `created` (or `updated`) and one `activated` line per workflow JSON. Webhook listeners are now registered in the live n8n process.

5. **Verify** from the host:

   ```bash
   curl -s -X POST http://localhost:5678/webhook/hello \
     -H 'content-type: application/json' \
     -d '{"hello":"world"}' | jq
   ```

   Expected JSON includes:
   - `agents_mounted: true`, `agents_file_name: "README.md"` — proves the `awp-agents` volume is mounted and readable from inside a workflow.
   - `echo_mcp.echo.text: "from n8n"` — proves the MCP-server container is reachable by service name.

   Both present ⇒ M0 closed.

## M1 prerequisites

To run the M1 workflow (`01_pm_intake.json`, Jira → PM decomposition) the following setup needs to be done **once**. None of these are needed for M0.

### Identity model (read this first)

Each automated role runs under its own **Atlassian service account** (per-role audit trail, native `assignee`-based routing from M2). Service accounts on Atlassian Cloud are non-human accounts that **do not consume the 10-seat Free-tier user limit** — every org gets 5 of them for free, which fits AWP exactly (4 used, 1 spare).

| Role | Service account | `accountId` (recorded) | n8n credential | Comes online |
|---|---|---|---|---|
| `pm` | `awp-pm` | `712020:5a2a8ccc-e479-49a1-9965-2748d01d9d26` | `Jira — awp-pm` | M1 |
| `classifier` | borrows `awp-pm` | — | — | M2 |
| `dev` | `awp-dev` | `712020:88195866-6d79-4da8-a642-e559cd055709` | `Jira — awp-dev` | M2 |
| `qa` | `awp-qa` | `712020:3643c5de-b750-4046-908d-0bc55051ad03` | `Jira — awp-qa` | M3 |
| `devops` | `awp-devops` | `712020:4e757014-d33f-4d1e-acf4-1c0eb3c2848f` | `Jira — awp-devops` | M3 |
| `reviewer` | borrows `awp-dev` (default; pending confirmation) | — | — | M3 |

All four service accounts are created up-front in M1 (cheap — single admin screen, no email aliases needed). The canonical mapping (workspace, accountIds, credential names) lives in `awp-agents/agents/shared/jira-accounts.yaml` — **this file is gitignored** because it contains workspace-specific identifiers. Bootstrap from the committed template:

```bash
cd awp-agents/agents/shared
cp jira-accounts.yaml.example jira-accounts.yaml
cp jira-fields.yaml.example   jira-fields.yaml
# edit both, replacing TODO placeholders with your values
```

API tokens and n8n credentials are added per-role as agents come online — M1 only needs `Jira — awp-pm`.

### Jira Cloud setup (one-time)

1. **Workspace + project** — sign up for Jira Cloud Free if not already. Create a project (Scrum or Kanban; doesn't matter). Note the workspace domain (`<workspace>.atlassian.net`).
2. **Service accounts** — `admin.atlassian.com → Directory → Service accounts → Create service account`. Create all four: `awp-pm`, `awp-dev`, `awp-qa`, `awp-devops`. For each:
   - Grant **product access to Jira**.
   - In the Jira project: assign **Developer** role (create issues, transition, comment).
   - Copy the `accountId` and record it in `awp-agents/agents/shared/jira-accounts.yaml`.
   - For `awp-pm` only (M1): create an **API token** on its admin page; the page also shows the `service_account_email` value to paste into n8n.
3. **Issue type hierarchy** — `Project settings → Issue types`. Confirm **Epic**, **Story**, and **Subtask** are all enabled (defaults in any team-managed Jira project). In M1 the PM workflow watches **Epics** in Backlog and creates **Stories** with `parent` set to the Epic (native Epic Link in team-managed projects — no custom field needed). Stories filed directly will be picked up by the Classifier in M2.

4. **Board and statuses** — Jira's **Backlog** is an entity (a tab in the project sidebar), not a column. Issues with status `Backlog` live there and are *not* on the board. Everything else moves through five board columns:

   | Status | Where it appears | Set by |
   |---|---|---|
   | `Backlog` | Backlog tab only | Default for new Epics/Stories. PM trigger watches Epics here. |
   | `To Do` | Board column 1 | PM after decomposing an Epic; Classifier (M2) for direct Stories. |
   | `In Progress` | Board column 2 | Epic after decomposition; executing agent (Dev/QA/DevOps) once it picks up a Story. |
   | `PR` | Board column 3 | Dev after opening a PR; QA / reviewer working. |
   | `Ready to Merge` | Board column 4 | All checks/reviews green, awaiting human merge. |
   | `Done` | Board column 5 | After merge. |

   Add any missing status via `Project settings → Workflow`.

5. **Label `needs-clarification`** — used by PM in its failure path instead of a dedicated status. When PM can't decompose an Epic, the Epic stays in `Backlog`, gets this label, and PM posts its questions as a comment. The PM trigger excludes Epics carrying this label, so the ticket sits quietly until you remove the label.

6. **Custom fields** — **internal IDs (`customfield_NNNNN`) are the only thing the Jira REST API knows about**. Display names are cosmetic — rename in `Project settings → Custom fields → ⋯ → Edit name` any time without breaking anything. Workflows reference fields by semantic key; the canonical mapping (semantic key → `customfield_NNNNN` + display name) lives in `awp-agents/agents/shared/jira-fields.yaml`. Proposed names:

   | Semantic key (code) | Display name (Jira UI) | Type | Filled by |
   |---|---|---|---|
   | `role` | **AWP Role** | Single-select: `pm`, `classifier`, `dev`, `qa`, `devops`, `reviewer` | Classifier / PM |
   | `tier` | **AWP Tier** | Single-select: `L1`, `L2`, `L3` | Classifier / PM |
   | `acceptance_criteria` | **AWP Acceptance Criteria** | Long text (multi-line) | PM |
   | `estimate_input_tokens` | **AWP Estimated Input Tokens** | Number | Classifier / PM |
   | `estimate_output_tokens` | **AWP Estimated Output Tokens** | Number | Classifier / PM |
   | `actual_input_tokens` | **AWP Actual Input Tokens** | Number | (M2+) executing agent |
   | `actual_output_tokens` | **AWP Actual Output Tokens** | Number | (M2+) executing agent |
   | `actual_cost_usd` | **AWP Actual Cost (USD)** | Number | (M2+) executing agent |

### Who picks up what (M1)

The workflow trigger filters by **issue type**, so the user-visible contract is *what you create*:

| You file in Backlog | Picked up by | Milestone | What happens |
|---|---|---|---|
| **Epic**, `AWP Role` empty, no `needs-clarification` label | PM agent | M1 | Decomposes into ≤ 10 linked Stories (status `To Do`, assignee + fields filled). Epic transitions `Backlog → In Progress`. |
| **Story**, `AWP Role` empty | Classifier | M2 | Fast track: fills role / tier / estimates, no decomposition; moves to `To Do`. |
| **Story**, `AWP Role` set | Executing agent | M2+ | Dev/QA/DevOps picks up by `assignee` and moves status through the board. |

In M1 the PM trigger JQL is:

```
project = AWP AND issuetype = Epic AND status = "Backlog" AND "AWP Role" IS EMPTY AND labels NOT IN ("needs-clarification")
```

Stories filed directly are *not* picked up until Classifier ships in M2.

### Anthropic (one-time, in console.anthropic.com)

1. Sign up; top up $10–20 of balance.
2. Generate an API key.

### n8n Credentials (one-time, in n8n UI at <http://localhost:5678>)

`Credentials → Create New`:

1. **`Anthropic API`** — paste API key.
2. **`Jira — awp-pm`** (type `Jira Software Cloud API`):
   - `Domain` = `<workspace>.atlassian.net`
   - `Email` = the service-account email Atlassian shows on the API-token creation page (commonly `<accountId>@connect.atlassian.com`; copy exactly)
   - `API Token` = the token from step 2 above
3. Per-role Jira credentials (`Jira — awp-dev`, `Jira — awp-qa`, `Jira — awp-devops`) are added as those roles come online in M2/M3.

(The n8n API key for the sidecar is a separate thing, covered in *Workflow sync* below.)

### Roles registered in M1

`awp.role` Jira enum maps 1:1 to folders under `awp-agents/agents/`:

| Role id | Authored in | First used by | Service account | Input it watches |
|---|---|---|---|---|
| `pm` | M1 | `01_pm_intake.json` | `awp-pm` | Epic in Backlog, `awp.role` empty |
| `classifier` | M2 | `02_classifier.json` | shares `awp-pm` | Story in Backlog, `awp.role` empty |
| `dev` | M2 | `03_dev_loop.json` | `awp-dev` | Story `assignee = awp-dev` |
| `qa` | M3 | `03_dev_loop.json` (handoff) | `awp-qa` | Story `assignee = awp-qa` |
| `devops` | M3 | `04_review_debug.json` | `awp-devops` | Story `assignee = awp-devops`; red CI |
| `reviewer` | M3 | `04_review_debug.json` | shares `awp-dev` | GitHub PR event, not Jira |

Each role is an open enum entry — adding a new one is `mkdir agents/<role>/` + Jira-side enum value + entry in `awp-agents/agents/shared/jira-accounts.yaml` + routing in workflows. No code changes.

## Workflow sync (auto-import + auto-activate)

Workflow JSONs live under `n8n/workflows/`. The `n8n-import` sidecar in `docker-compose.dev.yml` runs the script at `scripts/sync-workflows.js` after n8n becomes healthy. It uses n8n's **public REST API** (not the `n8n import:workflow` CLI) and does, per file:

1. `GET /api/v1/workflows` — enumerate existing workflows once.
2. If a workflow with the same `name` exists → `PUT /api/v1/workflows/<id>` to update.
   If not → `POST /api/v1/workflows` to create (owned by the API key's user).
3. `POST /api/v1/workflows/<id>/activate` (if JSON has `"active": true`), or `…/deactivate` (if `"active": false`). This is what registers webhook listeners in the running n8n process.

Why REST and not CLI: `n8n import:workflow` (a) imports workflows **without an owner** — they end up orphaned and produce `User attempted to access a workflow without permissions` in the UI; (b) forcibly **deactivates** workflows on import, so webhook listeners never come up. Both problems disappear when using the API under the owner's key.

**Matching is by `name`**, not by the top-level `id` in the JSON — n8n's API generates its own IDs on create, so name is the only durable handle. Keep workflow names unique inside `n8n/workflows/`.

Without `N8N_API_KEY` the sidecar exits cleanly with a help message and does nothing — set the key first (see [M0 quick start](#m0-quick-start)).

### Adding a new workflow

1. Author / export the JSON.
2. Give it a **unique `name`** (this is the sync key). Optional top-level `id` is informational only.
3. Avoid hardcoding `webhookId` on Webhook nodes — leave it out so n8n assigns one.
4. Set `"active": true` to have it activated automatically (or `false` for drafts).
5. Drop into `n8n/workflows/NN_descriptive_name.json`.
6. `docker compose up`, or `docker compose run --rm n8n-import` for an ad-hoc re-sync.

### Editing a workflow (round-trip)

1. Edit in the n8n editor at <http://localhost:5678>.
2. `…` menu → `Download` → save over the matching `NN_*.json`. Keep the `name` field stable (it's the sync key).
3. `git commit`. The next `docker compose up` re-syncs.

### Triggering sync manually

```bash
docker compose run --rm n8n-import
```

Idempotent. Safe to run any time n8n is healthy. Re-running with no changes prints `(likely already in state)` per workflow and exits.

## Configuration

`.env` consumed by `docker-compose.yml` (see `.env.example` for defaults):

| Variable | Purpose |
|---|---|
| `N8N_ENCRYPTION_KEY` | 32-char random string used to encrypt credentials at rest. **Required.** |
| `TZ` | Time zone used by cron triggers. |
| `N8N_HOST`, `N8N_PORT`, `N8N_PROTOCOL`, `WEBHOOK_URL` | Where the editor / webhooks are exposed. |
| `ECHO_MCP_PORT` | External port for `echo-mcp` when run standalone (M0 only). |

Anthropic API keys, Jira/GitHub PATs, Telegram tokens go into **n8n Credentials** (created from the editor), *not* `.env`. Rationale: credentials are encrypted at rest with `N8N_ENCRYPTION_KEY` and never leave the SQLite store.

## Workflows

See [`n8n/workflows/README.md`](n8n/workflows/README.md) for the current inventory and import instructions. Workflow JSONs are version-controlled here; production workflows live inside n8n's SQLite store and are imported via the editor's `Import from File…` action.

## n8n operational notes (gotchas)

Things that bit us during M0 and are worth keeping handy:

- **File-access whitelist.** `Read/Write Files from Disk` is restricted to `/home/node/.n8n-files` by default. The dev overlay opens up the mounted volume: `N8N_RESTRICT_FILE_ACCESS_TO=/home/node/awp-agents`. Multiple paths separated by `;`. Requires container restart to apply.
- **Expression syntax.** A field starting with `=` enables expression mode, but JS is only evaluated inside `{{ … }}`. `={ "a": $('X').item.json }` is parsed as literal text and breaks JSON-body fields. Always wrap as `={{ JSON.stringify({...}) }}`.
- **Avoid `respondWith: "json"` for dynamic bodies.** Behaviour with object-returning expressions varies across n8n versions (sometimes empty body, sometimes double-encoded). Use `respondWith: "text"` + `JSON.stringify(...)` + explicit `Content-Type: application/json` in `responseHeaders`.
- **Re-import after rename.** Renaming a node inside an already-active workflow can leave dangling references and surface as `Node not found` in the editor. Delete the workflow in the UI, reload, re-import the updated JSON.
- **No custom n8n nodes.** Everything in AWP is built with stock nodes: `Webhook`, `Chat Trigger`, `HTTP Request`, `AI Agent`, `MCP Client`, `Read/Write Files from Disk`, `Respond to Webhook`, `Telegram`, `Code` (sparingly).

## Switching to git submodules (later)

When we want `awp-agents` and `awp-mcp` to live inside this repo's tree (single-checkout convenience):

```bash
git submodule add git@github.com:realdnchka/awp-agents.git submodules/awp-agents
git submodule add git@github.com:realdnchka/awp-mcp.git    submodules/awp-mcp
```

Then change the volume mount and build context in `docker-compose.dev.yml` from `../awp-agents`/`../awp-mcp/...` to `./submodules/awp-agents`/`./submodules/awp-mcp/...`. Nothing else changes.

## Roadmap

- **M0 — Skeleton.** Done. Smoke test passes.
- **M1 — Jira intake + PM (Layer-1 only, no MCP added).** PM polls Epics in Backlog via `Jira Trigger` (as `awp-pm`), decomposes each Epic into ≤ 10 Stories via the native Jira node, fills the AWP custom fields (`AWP Role`, `AWP Tier`, `AWP Acceptance Criteria`, `AWP Estimated Input Tokens`, `AWP Estimated Output Tokens`) and sets `assignee` on each Story to the role's service-account `accountId`. Stories land with status `To Do` (board column 1); the Epic transitions `Backlog → In Progress`. Vague Epics get the `needs-clarification` label instead of a status change. Anthropic + `Jira — awp-pm` credentials added in n8n. Field-name mapping kept in `awp-agents/agents/shared/jira-fields.yaml`.
- **M2 — Dev happy path + Classifier + first L2 MCP.** Classifier picks up unlabeled Stories (`issuetype = Story AND "AWP Role" IS EMPTY`) via native Jira node only, fills role/tier/estimates. Dev agent (as `awp-dev`) gets the first MCP handlers (`runtime` shell sandbox + `fs` filesystem) consolidated in the single `awp-mcp` Go binary. Native GitHub node opens branch + PR + posts CI status back to Jira. Every agent writes actual tokens + computes `actual_cost_usd` from `agents/shared/pricing.yaml`.
- **M3 — Review + Debug loops.** Reviewer + DevOps workflows, iteration limits (`debug=2`, `review=3` defaults), Telegram alerts on escalation (native Telegram node).
- **M4 — Dispatcher.** `dispatch_loop` workflow + per-role caps from `.env`, atomic Jira status transitions. No broker.
- **M5 — Chat Trigger + project bootstrap.** Conversational entry point + repo template.
- **M6 — Calibration + budget.** `calibrate_estimates` cron → `agents/shared/estimates.md`. Hard stop on monthly `sum(actual_cost_usd)` + Telegram alert.
