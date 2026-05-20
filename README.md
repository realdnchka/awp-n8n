# awp-n8n

n8n (Community, self-hosted) workflow host for the **AWP** project. n8n is the **only** execution engine — there is no separate agents service.

- `awp-agents` (skills, prompts, role configs, pricing) is **mounted read-only** into the n8n container.
- `awp-mcp` (MCP servers) runs as **independent containers** on the shared `awp` network and is consumed via `MCP Client` / `HTTP Request` nodes from inside workflows.

See `../PLAN.md` for the full architecture and roadmap.

## Layout

```
docker-compose.yml         # n8n only (Community, SQLite)
docker-compose.dev.yml     # dev overlay: mounts ../awp-agents and builds ../awp-mcp/echo-mcp
.env.example
n8n/
  workflows/               # importable workflow JSONs (read-only mount)
submodules/                # in M0+ becomes git submodules of awp-agents and awp-mcp
infra/                     # traefik, backups, cloud migration (M5+)
```

The shared Docker network is named `awp`. All three repos attach to it; services reach each other by container name (e.g. `echo-mcp:8800`).

## M0 — quick start

This assumes the three repos sit next to each other on disk:

```
~/Dev/ai/awp/
├── awp-n8n/      <- you are here
├── awp-agents/   (skills, prompts, configs)
├── awp-mcp/      (MCP servers)
└── PLAN.md
```

1. Generate an encryption key and prepare `.env`:

   ```bash
   cp .env.example .env
   # then edit .env: set N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
   ```

2. Boot the stack (n8n + echo-mcp, with `awp-agents` mounted into n8n):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
   ```

3. Open <http://localhost:5678>, complete the one-time owner setup.

4. Import `n8n/workflows/00_hello_world.json` (see `n8n/workflows/README.md`),
   activate it, and verify:

   ```bash
   curl -s -X POST http://localhost:5678/webhook/hello \
     -H 'content-type: application/json' \
     -d '{"hello":"world"}' | jq
   ```

   Expected: a JSON containing
   - `agents_mounted: true` and `agents_file_name: "README.md"` (proves `awp-agents` is mounted and readable from a workflow), and
   - `echo_mcp.echo.text: "from n8n"` (proves the MCP-server container is reachable).

## Switching to git submodules (later)

When `awp-agents` and `awp-mcp` are pushed to GitHub:

```bash
git submodule add git@github.com:<user>/awp-agents.git submodules/awp-agents
git submodule add git@github.com:<user>/awp-mcp.git    submodules/awp-mcp
```

Then point the volume mount and build context in `docker-compose.dev.yml` at
`./submodules/awp-agents` and `./submodules/awp-mcp/servers/echo-mcp`.
