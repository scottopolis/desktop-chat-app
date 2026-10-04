import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import App from '../src/App';
import { HISTORY_KEY, loadHistory, updateHistory } from '../src/history';
import { GridriseTransport } from '../src/gridrise-transport';

class MockSocket extends EventTarget {
  static OPEN = 1;
  static sockets: MockSocket[] = [];
  readyState = 0;
  sent: { id: string; init: { body: string }; type: string }[] = [];
  constructor(public url: string) {
    super(); MockSocket.sockets.push(this);
    setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  frame(body: object) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(body) })); }
}

const userMessage = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });
const options = { chatId: 'chat-1', trigger: 'submit-message' as const, messageId: undefined, messages: [userMessage('u1', 'A question')], abortSignal: undefined };
const sessionResponse = () => Response.json({ session: { channel: 'chat', transport: {
  protocol: 'gridrise-chat-v1', url: 'wss://example.test/chat?existing=yes', capability: 'test-capability&encoded', credentialExpiresAt: new Date(Date.now() + 60_000).toISOString(),
} } });

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const chunks: T[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

beforeEach(() => { localStorage.clear(); MockSocket.sockets = []; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps the 10 most recent chats, promotes an existing chat, and persists only text', () => {
  let chats = loadHistory();
  for (let i = 0; i < 11; i++) chats = updateHistory(chats, `chat-${i}`, [userMessage(`u${i}`, `Question ${i}`)]);
  expect(chats.map(chat => chat.id)).toEqual(['chat-10', 'chat-9', 'chat-8', 'chat-7', 'chat-6', 'chat-5', 'chat-4', 'chat-3', 'chat-2', 'chat-1']);
  chats = updateHistory(chats, 'chat-3', [{ ...userMessage('u3', '  Saved\n question  '), metadata: { capability: 'must-not-persist' } }]);
  expect(chats).toHaveLength(10);
  expect(chats[0].title).toBe('Saved question');
  expect(JSON.stringify(chats)).not.toContain('must-not-persist');
  localStorage.setItem(HISTORY_KEY, JSON.stringify(chats));
  expect(loadHistory()[0]).toEqual(chats[0]);
  localStorage.setItem(HISTORY_KEY, 'broken');
  expect(loadHistory()).toEqual([]);
});

it('uses the handoff URL, sends full history, ignores unrelated frames, streams text and reuses a valid session', async () => {
  vi.stubGlobal('WebSocket', MockSocket);
  const request = vi.fn().mockImplementation(sessionResponse);
  vi.stubGlobal('fetch', request);
  const transport = new GridriseTransport();
  const stream = await transport.sendMessages(options);
  const socket = MockSocket.sockets[0];
  const url = new URL(socket.url);
  expect(url.searchParams.get('existing')).toBe('yes');
  expect(url.searchParams.get('capability')).toBe('test-capability&encoded');
  expect(socket.sent[0].type).toBe('cf_agent_use_chat_request');
  expect(JSON.parse(socket.sent[0].init.body)).toEqual({ messages: options.messages, trigger: 'submit-message' });
  const id = socket.sent[0].id;
  socket.frame({ type: 'cf_agent_use_chat_response', id: 'different', body: JSON.stringify({ type: 'text-delta', delta: 'Wrong' }) });
  for (const delta of ['Hello ', '**Scott**']) socket.frame({ type: 'cf_agent_use_chat_response', id, body: JSON.stringify({ type: 'text-delta', delta }) });
  socket.frame({ type: 'cf_agent_use_chat_response', id, done: true });
  const chunks = await collect(stream);
  expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta).join('')).toBe('Hello **Scott**');
  expect(chunks.at(-1)?.type).toBe('finish');
  const next = await transport.sendMessages(options);
  expect(request).toHaveBeenCalledTimes(1);
  socket.frame({ type: 'cf_agent_use_chat_response', id: socket.sent[1].id, done: true });
  await collect(next);
  transport.dispose();
});

it('renews expired capabilities and stops a pending stream without saving credentials', async () => {
  vi.stubGlobal('WebSocket', MockSocket);
  const request = vi.fn().mockImplementation(sessionResponse);
  vi.stubGlobal('fetch', request);
  const transport = new GridriseTransport();
  const first = await transport.sendMessages(options);
  MockSocket.sockets[0].frame({ type: 'cf_agent_use_chat_response', id: MockSocket.sockets[0].sent[0].id, done: true });
  await collect(first);
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
  const abort = new AbortController();
  const second = await transport.sendMessages({ ...options, abortSignal: abort.signal });
  expect(request).toHaveBeenCalledTimes(2);
  expect(MockSocket.sockets[0].readyState).toBe(3);
  abort.abort();
  await collect(second);
  expect(MockSocket.sockets[1].readyState).toBe(3);
  vi.restoreAllMocks();
});

it('fails a turn on a matching error or connection loss', async () => {
  vi.stubGlobal('WebSocket', MockSocket);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(sessionResponse));
  const transport = new GridriseTransport();
  const stream = await transport.sendMessages(options);
  const socket = MockSocket.sockets[0];
  socket.frame({ type: 'cf_agent_use_chat_response', id: socket.sent[0].id, error: true });
  await expect(collect(stream)).rejects.toThrow('could not complete');
  const next = await transport.sendMessages(options);
  MockSocket.sockets[1].close();
  await expect(collect(next)).rejects.toThrow('Connection interrupted');
});

it('restores chats, switches transcripts, starts empty chats, deletes locally, and reports setup errors', async () => {
  const saved = updateHistory(updateHistory([], 'old', [userMessage('a', 'Older idea')]), 'recent', [userMessage('b', 'Recent idea')]);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(saved));
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => Promise.resolve(init?.method === 'POST'
    ? Response.json({ error: 'Add GRIDRISE_API_KEY to continue.' }, { status: 503 })
    : Response.json({ configured: false }))));
  render(<App />);
  const log = screen.getByRole('log');
  expect(log).toHaveTextContent('Recent idea');
  await userEvent.click(screen.getByRole('button', { name: 'Older idea' }));
  expect(log.isConnected).toBe(false);
  expect(screen.getByRole('log')).toHaveTextContent('Older idea');
  await userEvent.click(screen.getByRole('button', { name: /New chat/ }));
  expect(screen.getByRole('log')).toHaveTextContent('What’s on your mind?');
  expect(loadHistory()).toHaveLength(2);
  await userEvent.type(screen.getByPlaceholderText('Message Gridrise…'), 'Test setup{enter}');
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Add GRIDRISE_API_KEY'));
  expect(loadHistory()[0].title).toBe('Test setup');
  await userEvent.click(screen.getByRole('button', { name: 'Delete chat: Older idea' }));
  expect(loadHistory().map(chat => chat.id)).not.toContain('old');
});
