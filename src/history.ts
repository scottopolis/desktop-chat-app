import type { UIMessage } from 'ai';
import { z } from 'zod';

export type SavedChat = { id: string; title: string; updatedAt: number; messages: UIMessage[] };
export const HISTORY_KEY = 'gridrise.chats.v1';

// Only transcript text is persisted, never handoff credentials or tool payloads.
const historySchema = z.array(z.object({
  id: z.string(), title: z.string(), updatedAt: z.number(),
  messages: z.array(z.object({
    id: z.string(), role: z.enum(['user', 'assistant']),
    parts: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  })),
}));

export function loadHistory(): SavedChat[] {
  try {
    return historySchema.parse(JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  } catch { return []; }
}

export function updateHistory(chats: SavedChat[], id: string, messages: UIMessage[]): SavedChat[] {
  if (!messages.length) return chats;
  const text = messages.find(message => message.role === 'user')?.parts
    .filter(part => part.type === 'text').map(part => part.text).join(' ') ?? 'New chat';
  const chat: SavedChat = {
    id, title: text.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New chat', updatedAt: Date.now(),
    messages: messages.filter(message => message.role !== 'system').map(message => ({
      id: message.id, role: message.role,
      parts: message.parts.filter(part => part.type === 'text').map(part => ({ type: 'text' as const, text: part.text })),
    })),
  };
  return [chat, ...chats.filter(item => item.id !== id)].slice(0, 10);
}
