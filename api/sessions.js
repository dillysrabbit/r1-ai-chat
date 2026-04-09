// Vercel Edge Function: GitHub-backed session store for the R1 app.
//
// Sessions live as markdown files in a private GitHub repo (env vars
// GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO). Each session is one file
// under `sessions/YYYYMMDD-HHMMSS-<slug>.md`. The markdown has YAML
// frontmatter with id/title/created/updated/model, and a body of
// alternating "## CHEF · HH:MM:SS" / "## MRS. L · HH:MM:SS" blocks.
//
// This collapses two problems into one: server-side persistence for
// the R1 (client storage on the device is unreliable), and automatic
// forwarding to the "My Happy Place" workspace on Daniel's Mac —
// which just pulls the repo and finds the sessions waiting there.
//
// Routes:
//   GET    /api/sessions          → { sessions: [{id, title, created, updated}] }
//   GET    /api/sessions?id=X     → { session: {id, title, created, updated, model, messages}, sha }
//   PUT    /api/sessions?id=X     → body {title?, model?, messages} → create or replace
//   DELETE /api/sessions?id=X     → { ok: true }

export const config = {
  runtime: 'edge'
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

// UTF-8 safe base64 helpers for the Edge runtime.
function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function decodeBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'r1-happy-place-inbox'
  };
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function hms(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function sanitize(s) {
  return (s || '').toString().replace(/[\r\n`]/g, ' ').trim();
}

function sessionPath(id) {
  return `sessions/${id}.md`;
}

// ----- Markdown render / parse --------------------------------------------

function renderMarkdown(session) {
  const fmLines = [
    '---',
    `id: ${session.id}`,
    `title: ${sanitize(session.title).slice(0, 120)}`,
    `created: ${session.created}`,
    `updated: ${session.updated}`,
    `model: ${sanitize(session.model)}`,
    '---',
    ''
  ];
  const body = (session.messages || []).map(m => {
    const role = m.role === 'assistant' ? 'MRS. L' : 'CHEF';
    const ts = m.ts ? ' · ' + hms(m.ts) : '';
    return `## ${role}${ts}\n\n${(m.content || '').trim()}\n`;
  }).join('\n');
  return fmLines.join('\n') + '\n' + body;
}

function parseMarkdown(md, fallbackId) {
  const out = {
    id: fallbackId,
    title: '',
    created: '',
    updated: '',
    model: '',
    messages: []
  };

  // Frontmatter
  let body = md;
  const fmMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    const lines = fmMatch[1].split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m && m[1] in out) out[m[1]] = m[2].trim();
    }
    body = md.slice(fmMatch[0].length);
  }

  // Messages: split on lines beginning with "## "
  const chunks = [];
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const header = line.match(/^## (CHEF|MRS\. L)(?:\s*·\s*([0-9:]+))?\s*$/);
    if (header) {
      if (current) chunks.push(current);
      current = { role: header[1] === 'MRS. L' ? 'assistant' : 'user', content: '' };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current);
  out.messages = chunks.map(c => ({
    role: c.role,
    content: c.content.trim()
  }));

  return out;
}

// ----- GitHub API helpers -------------------------------------------------

async function ghGetFile(token, owner, repo, path) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    { headers: ghHeaders(token) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function ghListDir(token, owner, repo, path) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    { headers: ghHeaders(token) }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub LIST ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function ghPutFile(token, owner, repo, path, content, sha, message) {
  const body = {
    message: message || `session: update ${path}`,
    content: encodeBase64(content)
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function ghDeleteFile(token, owner, repo, path, sha) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: 'DELETE',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `session: delete ${path}`, sha })
    }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub DELETE ${res.status}: ${await res.text()}`);
  }
  return true;
}

// ----- Filename → metadata ------------------------------------------------

function metaFromFilename(base) {
  // base format: YYYYMMDD-HHMMSS-<slug>
  const m = base.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/);
  if (!m) return { title: base, created: null };
  const [, y, mo, d, h, mi, s, slug] = m;
  const title = slug.replace(/-/g, ' ').trim();
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  return { title, created: iso };
}

// ----- Handler ------------------------------------------------------------

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    return json(500, {
      error: { message: 'GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO not set on server' }
    });
  }

  const url = new URL(req.url);
  const id  = url.searchParams.get('id');

  try {
    // --- LIST ---
    if (req.method === 'GET' && !id) {
      const items = await ghListDir(token, owner, repo, 'sessions');
      const list = items
        .filter(item => item.type === 'file' && item.name.endsWith('.md'))
        .map(item => {
          const base = item.name.replace(/\.md$/, '');
          const meta = metaFromFilename(base);
          return {
            id: base,
            title: meta.title,
            created: meta.created,
            updated: meta.created
          };
        })
        .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
      return json(200, { sessions: list });
    }

    // --- READ ---
    if (req.method === 'GET' && id) {
      const file = await ghGetFile(token, owner, repo, sessionPath(id));
      if (!file) return json(404, { error: { message: 'Session not found' } });
      const md = decodeBase64(file.content || '');
      const parsed = parseMarkdown(md, id);
      return json(200, { session: parsed, sha: file.sha });
    }

    // --- CREATE / REPLACE ---
    if (req.method === 'PUT' && id) {
      let body;
      try { body = await req.json(); }
      catch { return json(400, { error: { message: 'Invalid JSON body' } }); }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const now = new Date().toISOString();

      // If the file already exists, preserve `created` and obtain sha.
      const existing = await ghGetFile(token, owner, repo, sessionPath(id));
      let created = now;
      let sha = null;
      if (existing) {
        sha = existing.sha;
        try {
          const oldMd = decodeBase64(existing.content || '');
          const oldParsed = parseMarkdown(oldMd, id);
          if (oldParsed.created) created = oldParsed.created;
        } catch {}
      }

      const session = {
        id,
        title: sanitize(body.title).slice(0, 120),
        created,
        updated: now,
        model: sanitize(body.model),
        messages
      };
      const md = renderMarkdown(session);
      await ghPutFile(
        token, owner, repo, sessionPath(id), md, sha,
        existing ? `session: update ${id}` : `session: create ${id}`
      );
      return json(200, { ok: true, created, updated: now });
    }

    // --- DELETE ---
    if (req.method === 'DELETE' && id) {
      const existing = await ghGetFile(token, owner, repo, sessionPath(id));
      if (!existing) return json(404, { error: { message: 'Session not found' } });
      await ghDeleteFile(token, owner, repo, sessionPath(id), existing.sha);
      return json(200, { ok: true });
    }

    return json(405, { error: { message: 'Method not allowed' } });
  } catch (e) {
    return json(500, { error: { message: e.message || 'Unknown error' } });
  }
}
