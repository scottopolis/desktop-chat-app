import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

type Session = {
  channel: string;
  transport: { protocol: string; url: string; capability: string; credentialExpiresAt: string };
};

/** One in-memory session per open chat. Credentials are never saved with history. */
export class GridriseTransport implements ChatTransport<UIMessage> {
  private socket?: WebSocket;
  private expiresAt = 0;

  dispose() {
    this.socket?.close();
    this.socket = undefined;
  }

  async reconnectToStream() { return null; }

  async sendMessages({ messages, trigger, messageId, abortSignal }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || Date.now() >= this.expiresAt) {
      this.dispose();
      const response = await fetch('/api/sessions', { method: 'POST', signal: abortSignal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? 'Unable to start a chat session. Please try again.');
      }
      const { session } = await response.json() as { session: Session };
      if (session.channel !== 'chat' || session.transport.protocol !== 'gridrise-chat-v1') {
        throw new Error('This app requires a published Gridrise chat agent.');
      }
      const url = new URL(session.transport.url);
      url.searchParams.set('capability', session.transport.capability);
      this.expiresAt = Date.parse(session.transport.credentialExpiresAt);
      const socket = new WebSocket(url);
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => fail('Connection timed out. Please try again.'), 15_000);
        const cleanup = () => {
          clearTimeout(timeout);
          socket.removeEventListener('open', open);
          socket.removeEventListener('error', error);
          socket.removeEventListener('close', error);
          abortSignal?.removeEventListener('abort', abort);
        };
        const fail = (message: string) => { cleanup(); socket.close(); reject(new Error(message)); };
        const open = () => { cleanup(); resolve(); };
        const error = () => fail('Could not connect to Gridrise. Please try again.');
        const abort = () => { cleanup(); socket.close(); reject(new DOMException('Stopped', 'AbortError')); };
        socket.addEventListener('open', open);
        socket.addEventListener('error', error);
        socket.addEventListener('close', error);
        abortSignal?.addEventListener('abort', abort, { once: true });
        if (abortSignal?.aborted) abort();
      });
    }

    const socket = this.socket!;
    const id = crypto.randomUUID();
    const textId = `${id}-text`;
    let cleanup = () => {};
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        let ended = false;
        let textStarted = false;
        let timeout: ReturnType<typeof setTimeout>;
        cleanup = () => {
          clearTimeout(timeout);
          socket.removeEventListener('message', receive);
          socket.removeEventListener('close', closed);
          socket.removeEventListener('error', closed);
          abortSignal?.removeEventListener('abort', abort);
        };
        const finish = (error?: Error) => {
          if (ended) return;
          ended = true;
          cleanup();
          if (error) { this.dispose(); controller.error(error); }
          else {
            if (textStarted) controller.enqueue({ type: 'text-end', id: textId });
            controller.enqueue({ type: 'finish' });
            controller.close();
          }
        };
        const closed = () => finish(new Error('Connection interrupted. Retry to continue this chat.'));
        const abort = () => { finish(); this.dispose(); };
        const resetTimeout = () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => finish(new Error('The agent stopped responding. Please retry.')), 120_000);
        };
        const receive = (event: MessageEvent) => {
          try {
            const frame = JSON.parse(String(event.data));
            if (frame.type !== 'cf_agent_use_chat_response' || frame.id !== id) return;
            resetTimeout();
            if (frame.error) { finish(new Error('The agent could not complete this response. Please retry.')); return; }
            if (frame.body) {
              const chunk = JSON.parse(frame.body);
              if (chunk.type === 'error') { finish(new Error('The agent could not complete this response. Please retry.')); return; }
              if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
                if (!textStarted) {
                  controller.enqueue({ type: 'text-start', id: textId });
                  textStarted = true;
                }
                controller.enqueue({ type: 'text-delta', id: textId, delta: chunk.delta });
              }
            }
            if (frame.done) finish();
          } catch { finish(new Error('Received an invalid response from Gridrise. Please retry.')); }
        };
        controller.enqueue({ type: 'start', messageId: `${id}-assistant` });
        socket.addEventListener('message', receive);
        socket.addEventListener('close', closed);
        socket.addEventListener('error', closed);
        abortSignal?.addEventListener('abort', abort, { once: true });
        resetTimeout();
        if (abortSignal?.aborted) { abort(); return; }
        socket.send(JSON.stringify({
          type: 'cf_agent_use_chat_request', id,
          init: { method: 'POST', body: JSON.stringify({ messages, trigger, messageId }) },
        }));
      },
      cancel: () => { cleanup(); this.dispose(); },
    });
  }
}
