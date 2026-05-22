// Sidecar entrypoint: sync every workflow JSON in $WORKFLOWS_DIR into n8n via
// its public REST API. The CLI (`n8n import:workflow`) is intentionally NOT
// used because it (a) imports workflows without an owner — they end up orphaned
// and invisible in the UI — and (b) forcibly deactivates workflows on import,
// so webhook listeners never register in the running process.
//
// REST API approach:
//   - GET /api/v1/workflows                       → enumerate existing workflows
//   - PUT /api/v1/workflows/{id}                  → update if a workflow with
//                                                   the same `name` already exists
//   - POST /api/v1/workflows                      → create otherwise (owned by
//                                                   the API key's user)
//   - POST /api/v1/workflows/{id}/activate        → if JSON has "active": true
//   - POST /api/v1/workflows/{id}/deactivate      → if JSON has "active": false
//
// Idempotent: re-runs over unchanged JSONs are no-ops.
// Match key is `name` (the JSON top-level `id` is informational only — n8n's
// API generates its own IDs on create).

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const apiKey = process.env.N8N_API_KEY;
const baseUrl = new URL(process.env.N8N_URL || 'http://n8n:5678');
const workflowsDir = process.env.WORKFLOWS_DIR || '/workflows';
const includeBaseDir = process.env.INCLUDE_BASE_DIR || '/home/node/awp-agents';

// Sidecar-side templating: walk every string field in the workflow JSON and
// replace `{{INCLUDE:relative/path/to/file}}` markers with the JS-string-literal
// form of the file contents (i.e. surrounded by double quotes, with \n, \", \\
// etc. escaped). The path is resolved relative to INCLUDE_BASE_DIR and must
// stay inside it (we reject any path that escapes via ..).
//
// Why: n8n 2.21+ runs Code nodes in a Task Runner with binaryDataMode=filesystem.
// Cross-node binary access does not return the .data field — the upstream
// Read File node hands the Code node a lazy reference that's useless inside
// the sandbox. Instead of fighting that, we bake static text files (PM
// prompt, etc.) directly into Code node source at sync time. Editing the
// prompt file + re-running this sidecar is the workflow.
const INCLUDE_RE = /\{\{INCLUDE:([^}]+)\}\}/g;

function jsStringLiteral(text) {
  // Produce a double-quoted JS string literal: "...". JSON.stringify happens
  // to do exactly that — JSON strings are a strict subset of JS strings.
  return JSON.stringify(text);
}

function resolveInclude(relPath) {
  const cleaned = relPath.trim();
  if (!cleaned) throw new Error('Empty include path');
  const abs = path.resolve(includeBaseDir, cleaned);
  const baseAbs = path.resolve(includeBaseDir) + path.sep;
  if (abs !== path.resolve(includeBaseDir) && !abs.startsWith(baseAbs)) {
    throw new Error(`Include path escapes ${includeBaseDir}: ${relPath}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

function expandIncludes(value, file) {
  if (typeof value === 'string') {
    if (!value.includes('{{INCLUDE:')) return value;
    return value.replace(INCLUDE_RE, (_, p) => {
      const content = resolveInclude(p);
      console.log(`[awp-sync] ${file}: inlined ${p.trim()} (${content.length} chars)`);
      // Emit a JS string literal so the surrounding jsCode reads:
      //   const x = "<<escaped contents>>";
      return jsStringLiteral(content);
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandIncludes(v, file));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = expandIncludes(value[k], file);
    return out;
  }
  return value;
}

if (!apiKey) {
  console.log('[awp-sync] N8N_API_KEY is not set — cannot sync via REST API.');
  console.log('[awp-sync]');
  console.log('[awp-sync] One-time setup:');
  console.log('[awp-sync]   1. Open http://localhost:5678  →  complete owner setup');
  console.log('[awp-sync]   2. Settings  →  n8n API  →  Create an API key');
  console.log('[awp-sync]   3. Paste into awp-n8n/.env as  N8N_API_KEY=...');
  console.log('[awp-sync]   4. docker compose run --rm n8n-import');
  process.exit(0);
}

function api(method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: baseUrl.hostname,
      port: baseUrl.port || 80,
      path: requestPath,
      method,
      headers: {
        'X-N8N-API-KEY': apiKey,
        Accept: 'application/json',
        'Content-Length': data ? Buffer.byteLength(data) : 0,
      },
    };
    if (data) opts.headers['Content-Type'] = 'application/json';

    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} ${method} ${requestPath}: ${buf || '(empty body)'}`));
        }
        if (!buf) return resolve({});
        try {
          resolve(JSON.parse(buf));
        } catch (e) {
          resolve({ raw: buf });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function workflowPayload(wf) {
  // Fields accepted by POST /workflows and PUT /workflows/{id}.
  // Strip anything else that exists in our hand-authored JSON (id, active,
  // pinData, tags, etc.). Active state is set separately via /activate.
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: wf.settings || {},
  };
}

// Walk the workflow's node list and resolve every `credentials` block from
// (type, name) to (type, name + id). n8n's import API silently drops nodes
// that reference a credential by name only — at execution time you get
// "Found credential with no ID". The built-in node types (jiraSoftwareCloudApi,
// anthropicApi, ...) auto-resolve by name as a legacy compatibility, but
// generic types like httpHeaderAuth do not. Resolving on the sidecar side
// keeps workflow JSONs human-readable (no UUID gore) while satisfying n8n.
function resolveCredentialIds(wf, credByTypeAndName, file) {
  if (!Array.isArray(wf.nodes)) return wf;
  let resolved = 0;
  const missing = [];
  for (const node of wf.nodes) {
    if (!node.credentials || typeof node.credentials !== 'object') continue;
    for (const credType of Object.keys(node.credentials)) {
      const entry = node.credentials[credType];
      if (!entry || typeof entry !== 'object' || !entry.name) continue;
      const key = `${credType}::${entry.name}`;
      const found = credByTypeAndName.get(key);
      if (found) {
        entry.id = found.id;
        resolved += 1;
      } else if (!entry.id) {
        missing.push(`${node.name} → ${credType}:${entry.name}`);
      }
    }
  }
  if (resolved > 0) {
    console.log(`[awp-sync] ${file}: resolved ${resolved} credential reference(s) to IDs`);
  }
  if (missing.length > 0) {
    console.log(`[awp-sync] ${file}: WARNING — could not resolve credentials by (type, name): ${missing.join(', ')}. Create them in the n8n UI before this workflow can execute.`);
  }
  return wf;
}

async function main() {
  console.log(`[awp-sync] enumerating workflows at ${baseUrl.origin}`);
  const listResp = await api('GET', '/api/v1/workflows?limit=250');
  const existingList = Array.isArray(listResp) ? listResp : listResp.data || [];
  const byName = new Map();
  for (const wf of existingList) byName.set(wf.name, wf);
  console.log(`[awp-sync] ${existingList.length} workflow(s) already in n8n`);

  // Pre-load credentials so we can resolve workflow node references by name.
  // n8n's public API only returns metadata (id/name/type) — no secrets — so
  // this is safe to do under the sync sidecar's API key.
  const credResp = await api('GET', '/api/v1/credentials?limit=250');
  const credList = Array.isArray(credResp) ? credResp : credResp.data || [];
  const credByTypeAndName = new Map();
  for (const c of credList) {
    if (!c || !c.type || !c.name || !c.id) continue;
    credByTypeAndName.set(`${c.type}::${c.name}`, { id: c.id, type: c.type, name: c.name });
  }
  console.log(`[awp-sync] ${credList.length} credential(s) available for name→id resolution`);

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  console.log(`[awp-sync] ${files.length} workflow JSON(s) under ${workflowsDir}`);

  for (const file of files) {
    const rawWf = JSON.parse(fs.readFileSync(path.join(workflowsDir, file), 'utf8'));
    if (!rawWf.name) {
      console.log(`[awp-sync] ${file}: no "name" field, skipping`);
      continue;
    }
    const expanded = expandIncludes(rawWf, file);
    const wf = resolveCredentialIds(expanded, credByTypeAndName, file);
    const payload = workflowPayload(wf);

    let id;
    const existing = byName.get(wf.name);
    if (existing) {
      await api('PUT', `/api/v1/workflows/${existing.id}`, payload);
      id = existing.id;
      console.log(`[awp-sync] ${file}: updated  (api id ${id})`);
    } else {
      const created = await api('POST', '/api/v1/workflows', payload);
      id = created.id;
      console.log(`[awp-sync] ${file}: created  (api id ${id})`);
    }

    const wantActive = wf.active === true;
    try {
      if (wantActive) {
        await api('POST', `/api/v1/workflows/${id}/activate`);
        console.log(`[awp-sync] ${file}: activated`);
      } else {
        await api('POST', `/api/v1/workflows/${id}/deactivate`);
        console.log(`[awp-sync] ${file}: deactivated (active=false in JSON)`);
      }
    } catch (e) {
      // Already in the desired state is fine.
      const msg = e.message || String(e);
      if (msg.includes('already') || msg.includes('400')) {
        console.log(`[awp-sync] ${file}: ${wantActive ? 'activate' : 'deactivate'} → ${msg.split(':')[0]} (likely already in state)`);
      } else {
        console.log(`[awp-sync] ${file}: ${wantActive ? 'activate' : 'deactivate'} failed → ${msg}`);
      }
    }
  }
  console.log('[awp-sync] done');
}

main().catch((e) => {
  console.error(`[awp-sync] FATAL: ${e.message}`);
  process.exit(1);
});
