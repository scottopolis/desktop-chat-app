import { config } from 'dotenv';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// The personal app's .env takes precedence over unrelated shell credentials.
config({ override: true, quiet: true });

const AGENT_ID = 'agent_bb34ddbfd404477ba07cb9267ad6899b';
const SESSION_URL = `https://cloudflare-agent-host-production.designbyscott.workers.dev/v1/agent-sessions?agentId=${AGENT_ID}`;

export function createSessionServer({ apiKey = process.env.GRIDRISE_API_KEY, request = fetch }: { apiKey?: string; request?: typeof fetch } = {}) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const reply = (status: number, body: unknown) => { res.writeHead(status); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/api/health') { reply(200, { configured: Boolean(apiKey) }); return; }
    if (req.url !== '/api/sessions') { reply(404, { error: 'Not found' }); return; }
    if (req.method !== 'POST') { reply(405, { error: 'Use POST to start a session.' }); return; }
    // This is a personal local app, not an unauthenticated public admission proxy.
    const origins = ['http://localhost:5173', 'http://127.0.0.1:5173', process.env.GRIDRISE_APP_ORIGIN];
    if (!req.headers.origin || !origins.includes(req.headers.origin)) { reply(403, { error: 'Origin not allowed.' }); return; }
    if (!apiKey) { reply(503, { error: 'Add GRIDRISE_API_KEY to the server .env file and restart the app to connect your agent.' }); return; }
    try {
      const upstream = await request(SESSION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ purpose: 'api' }), signal: AbortSignal.timeout(30_000),
      });
      const correlation = upstream.headers.get('X-Correlation-Id');
      if (correlation) res.setHeader('X-Correlation-Id', correlation);
      const retryAfter = upstream.headers.get('Retry-After');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      if (!upstream.ok) {
        const errors: Record<number, string> = {
          401: 'The agent API key is invalid or revoked. Check your server .env file.',
          403: 'This key cannot create API sessions.',
          404: 'The agent is unpublished or the key is bound to a different agent.',
          409: 'Gridrise reported a session conflict. Please try again.',
          429: `Too many session requests. ${retryAfter ? `Try again after ${retryAfter} seconds.` : 'Please wait before trying again.'}`,
          503: 'Gridrise is temporarily unavailable. Please try again shortly.',
        };
        reply(upstream.status, { error: errors[upstream.status] ?? 'Gridrise could not start a session.' }); return;
      }
      reply(201, await upstream.json());
    } catch { reply(502, { error: 'Could not reach Gridrise. Check your connection and try again.' }); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSessionServer().listen(Number(process.env.API_PORT ?? 8787), '127.0.0.1', () => {
    console.log('Gridrise session backend listening on loopback.');
  });
}
