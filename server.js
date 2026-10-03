const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// AI writing helpers. The platform LLM proxy is only injected in production;
// staging and local runs report it unavailable and the client falls back to
// its built-in offline generator.
const LLM_ENABLED = !!(process.env.USERNODE_LLM_PROXY_URL && process.env.USERNODE_LLM_PROXY_TOKEN);
const LLM_MODEL = 'claude-haiku-4-5-20251001';

const AI_SYSTEM = [
  'You help people write short family-friendly drama films for the app "Studio Drama Pendek".',
  'Content rules (mandatory): no violence, injury, weapons, crime as entertainment, self-harm,',
  'sexual or suggestive content, dating, flirting, alcohol, drugs or gambling. Romance means',
  'wholesome affection only (letters, longing, family love, reunions). Horror means mild suspense',
  'with a harmless explanation (creaks, shadows, a lost cat). If the request asks for anything',
  'outside these rules, write a gentle, safe story instead.',
  'Reply with JSON only, no prose and no code fences.',
].join(' ');

function aiPrompt(kind, lang, input) {
  const language = lang === 'en' ? 'English' : 'Bahasa Indonesia';
  const i = input || {};
  if (kind === 'ideas') {
    return `Write 5 different one-sentence premises for a short drama film in ${language}.
Genre: ${i.genre || ''}. Tone: ${i.tone || ''}. Title (may be empty): ${i.title || ''}.
Return {"ideas":["...","...","...","...","..."]}.`;
  }
  if (kind === 'outline') {
    return `Write a story outline for a short drama film in ${language}, built from this premise: ${i.premise || ''}.
Genre: ${i.genre || ''}. Tone: ${i.tone || ''}.
Return {"title":"short film title","logline":"one sentence","characters":[{"name":"...","age":30,"role":"utama|pendukung","traits":"two or three traits"}],"conflict":"two sentences on the central conflict","beats":[{"act":1,"title":"beat name","summary":"one or two sentences"}],"ending":"two sentences on how the story ends"}.
Give 2 to 5 characters and 5 to 7 beats spread across acts 1, 2 and 3.`;
  }
  return `Write a three-act script for a short drama film in ${language}.
Title: ${i.title || ''}. Genre: ${i.genre || ''}. Tone: ${i.tone || ''}. Premise: ${i.premise || ''}.
Target length: ${i.targetMinutes || 1} minute(s), so about ${i.sceneCount || 3} scenes with ${i.linesPerScene || 4} short dialogue lines each.
Characters (use exactly these names): ${JSON.stringify(i.characters || [])}.
Allowed location keys: ${JSON.stringify(i.locations || [])}.
Return {"scenes":[{"act":1|2|3,"location":"<location key>","timeOfDay":"pagi|siang|malam","mood":"...","action":"one sentence","lines":[{"character":"<name or Narator>","text":"..."}]}]}.
Every character should speak at least once. Keep every line under 140 characters.`;
}

function parseJsonLoose(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

app.get('/api/ai/status', (_req, res) => res.json({ llm: LLM_ENABLED }));

app.post('/api/ai/generate', async (req, res) => {
  if (!LLM_ENABLED) return res.status(503).json({ code: 'llm_unavailable' });
  const { kind, lang, input } = req.body || {};
  if (kind !== 'ideas' && kind !== 'script' && kind !== 'outline') return res.status(400).json({ code: 'bad_kind' });
  if (JSON.stringify(input || {}).length > 8192) return res.status(413).json({ code: 'too_large' });
  try {
    const upstream = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
        'x-usernode-user-token': req.headers['x-usernode-token'] || req.query.token || '',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: kind === 'script' ? 4000 : kind === 'outline' ? 1500 : 800,
        system: AI_SYSTEM,
        messages: [{ role: 'user', content: aiPrompt(kind, lang, input) }],
      }),
    });
    const body = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(upstream.status).json({ code: (body && body.code) || 'upstream_error' });
    }
    const text = (body.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const data = parseJsonLoose(text);
    if (!data) return res.status(502).json({ code: 'bad_output' });
    res.json({ data });
  } catch (err) {
    console.warn('ai generate failed: ' + err.message);
    res.status(502).json({ code: 'upstream_error' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/dranus-dbd729/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/dranus-dbd729/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Projects live in each browser's storage, so the app has no tables yet. The
// pool stays for future server-side storage; it connects lazily.
async function start() {
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, draining`);
    server.close();
    setTimeout(async () => {
      try { await pool.end(); } catch {}
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
