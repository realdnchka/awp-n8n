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

It reads `README.md` only because it's a file guaranteed to exist; a real (M1+) workflow reads `agents/<role>/prompts/system.md`.

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

## Planned

- `01_pm_intake.json` (M1) — Jira webhook → PM decomposes → subtasks created with `awp.role`, `awp.tier`, `awp.estimate_input_tokens`, `awp.estimate_output_tokens`.
- `02_classifier.json` (M2) — fast-track router for trivial tasks.
- `03_dev_loop.json` (M2) — Dev agent → branch + PR + CI status push back to Jira; writes `awp.actual_*` fields.
- `04_review_debug.json` (M3) — Reviewer / DevOps with iteration limits (`debug=2`, `review=3`) and Telegram escalations.
- `05_dispatch.json` (M4) — periodic dispatcher honouring per-role caps from `.env`, using atomic Jira status transitions.
- `99_calibrate_estimates.json` (M6) — cron that aggregates `actual / estimate` ratios into `awp-agents/agents/shared/estimates.md`.
