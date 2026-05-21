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

async function main() {
  console.log(`[awp-sync] enumerating workflows at ${baseUrl.origin}`);
  const listResp = await api('GET', '/api/v1/workflows?limit=250');
  const existingList = Array.isArray(listResp) ? listResp : listResp.data || [];
  const byName = new Map();
  for (const wf of existingList) byName.set(wf.name, wf);
  console.log(`[awp-sync] ${existingList.length} workflow(s) already in n8n`);

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  console.log(`[awp-sync] ${files.length} workflow JSON(s) under ${workflowsDir}`);

  for (const file of files) {
    const wf = JSON.parse(fs.readFileSync(path.join(workflowsDir, file), 'utf8'));
    if (!wf.name) {
      console.log(`[awp-sync] ${file}: no "name" field, skipping`);
      continue;
    }
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
