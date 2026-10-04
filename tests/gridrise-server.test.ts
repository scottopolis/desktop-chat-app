// @vitest-environment node
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createSessionServer } from '../server/sessions';

it('admits only the exact configured agent with server-side authorization and no caching', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ session: { transport: { capability: 'short-lived-test' } } }, { status: 201 }));
  const server = createSessionServer({ apiKey: 'server-only-test-key', request });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const blocked = await fetch(`${url}/api/sessions`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(blocked.status).toBe(403);
    expect(request).not.toHaveBeenCalled();
    const response = await fetch(`${url}/api/sessions`, { method: 'POST', headers: { Origin: 'http://localhost:5173' } });
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(request.mock.calls[0][0]).toBe('https://cloudflare-agent-host-production.designbyscott.workers.dev/v1/agent-sessions?agentId=agent_bb34ddbfd404477ba07cb9267ad6899b');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer server-only-test-key');
    expect(request.mock.calls[0][1].headers['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ purpose: 'api' });
    expect(await response.text()).not.toContain('server-only-test-key');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('preserves rate-limit guidance and correlation IDs without leaking upstream errors', async () => {
  const request = vi.fn().mockResolvedValue(Response.json({ secret: 'do-not-forward' }, { status: 429, headers: { 'Retry-After': '12', 'X-Correlation-Id': 'correlation-test' } }));
  const server = createSessionServer({ apiKey: 'server-key', request });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions`, { method: 'POST', headers: { Origin: 'http://localhost:5173' } });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
    expect(response.headers.get('X-Correlation-Id')).toBe('correlation-test');
    expect(await response.json()).toEqual({ error: 'Too many session requests. Try again after 12 seconds.' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
