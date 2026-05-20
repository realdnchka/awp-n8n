# Workflows

This directory is mounted read-only into the n8n container at `/home/node/workflows`. The files here are exportable workflow JSONs that can be imported via the n8n editor (`Workflows → Import from File`).

## M0 inventory

- `00_hello_world.json` — smoke-test workflow. A webhook fan-outs to:
  - reading `README.md` from the mounted `awp-agents` volume, and
  - posting to `echo-mcp:/echo` on the shared Docker network,
  then merges both and returns the result. It validates that
  (a) the `awp-agents` volume is reachable from n8n and (b) MCP-server
  containers are reachable by name. (We read `README.md` only because it's a
  file guaranteed to exist; a real workflow would read `agents/<role>/prompts/system.md`.)

## How to import

1. Open <http://localhost:5678>, complete the one-time owner setup.
2. `Workflows` (left sidebar) → `…` menu → `Import from File…` → pick `00_hello_world.json`.
3. Click `Active` (top right) — the webhook is now listening at
   `http://localhost:5678/webhook/hello`.
4. From the host:

   ```bash
   curl -s -X POST http://localhost:5678/webhook/hello \
     -H 'content-type: application/json' \
     -d '{"hello":"world"}' | jq
   ```

   Expected: a JSON with non-null `agents_file_name = "README.md"`, a positive
   `agents_file_bytes`, and `echo_mcp.echo.text = "from n8n"`.
