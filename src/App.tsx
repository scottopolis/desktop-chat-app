import { useChat } from '@ai-sdk/react';
import { ArrowUpRight, MessageSquare, PanelLeft, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import { ChatSurface } from './lib/ChatSurface';
import { GridriseTransport } from './gridrise-transport';
import { HISTORY_KEY, loadHistory, updateHistory, type SavedChat } from './history';

export default function App() {
  const [chats, setChats] = useState(loadHistory);
  const [activeId, setActiveId] = useState(() => chats[0]?.id ?? crypto.randomUUID());
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [storageError, setStorageError] = useState(false);
  const [configured, setConfigured] = useState<boolean>();
  const active = chats.find(chat => chat.id === activeId);
  const initialMessages = useRef<UIMessage[]>(active?.messages ?? []);

  useEffect(() => {
    fetch('/api/health').then(response => response.json()).then(body => setConfigured(body.configured)).catch(() => setConfigured(false));
  }, []);
  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(chats)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [chats]);

  function selectChat(chat?: SavedChat) {
    initialMessages.current = chat?.messages ?? [];
    setActiveId(chat?.id ?? crypto.randomUUID());
  }

  return (
    <div className={`gridrise-app ${sidebarOpen ? '' : 'sidebar-hidden'}`}>
      <aside className="sidebar" aria-label="Chat history" hidden={!sidebarOpen}>
        <a className="wordmark" href="/" aria-label="Gridrise home"><span className="logo-mark">G</span>Gridrise</a>
        <button className="new-chat" onClick={() => selectChat()}><Plus size={18} />New chat<span>↗</span></button>
        <div className="history-heading">Recent chats <span>{chats.length}/10</span></div>
        <nav className="history-list" aria-label="Recent chats">
          {!chats.length && <p className="history-empty">A little space for your ideas.<br />Your chats will appear here.</p>}
          {chats.map(chat => (
            <div key={chat.id} className={`history-item ${activeId === chat.id ? 'active' : ''}`}>
              <button className="history-select" aria-current={activeId === chat.id ? 'page' : undefined} onClick={() => selectChat(chat)} title={chat.title}>
                <MessageSquare size={15} /><span>{chat.title}</span>
              </button>
              <button className="delete-chat" aria-label={`Delete chat: ${chat.title}`} onClick={() => {
                setChats(current => current.filter(item => item.id !== chat.id));
                if (activeId === chat.id) selectChat();
              }}><Trash2 size={14} /></button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer"><span className="local-avatar">G</span><div><strong>Your workspace</strong><span>Saved only in this browser</span></div></div>
      </aside>
      <main className="main-panel">
        <header className="app-header">
          <button className="icon-button" onClick={() => setSidebarOpen(open => !open)} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}><PanelLeft size={20} /></button>
          <span>Gridrise <span className="header-divider">/</span> <span className="header-title">{active?.title ?? 'New chat'}</span></span>
          <span className="private-label">Personal chat</span>
        </header>
        {configured === false && <div className="setup-banner" role="status">One quick setup: add your agent’s API key to <code>GRIDRISE_API_KEY</code> in the server’s <code>.env</code> file, then restart the app.</div>}
        {storageError && <div className="setup-banner" role="alert">Browser storage is unavailable or full. Chats won’t survive a refresh until storage is available.</div>}
        <Conversation key={activeId} id={activeId} initialMessages={initialMessages.current} onMessages={messages => setChats(current => updateHistory(current, activeId, messages))} />
      </main>
    </div>
  );
}

function Conversation({ id, initialMessages, onMessages }: {
  id: string; initialMessages: UIMessage[]; onMessages: (messages: UIMessage[]) => void;
}) {
  const [transport] = useState(() => new GridriseTransport());
  const chat = useChat({ id, messages: initialMessages, transport });
  const saveRef = useRef(onMessages);
  saveRef.current = onMessages;
  useEffect(() => { saveRef.current(chat.messages); }, [chat.messages]);
  useEffect(() => () => { void chat.stop(); transport.dispose(); }, [transport, chat.stop]);

  return (
    <ChatSurface
      messages={chat.messages} status={chat.status} error={chat.error}
      actions={{ ...chat, addToolApprovalResponse: () => {} }}
      title="Gridrise chat" header={null} className={`desktop-chat ${chat.messages.length ? 'has-messages' : 'is-empty'}`}
      composerPlaceholder="Message Gridrise…"
      disclaimer="AI can make mistakes. Double-check important details."
      welcome={<><span className="welcome-symbol"><Sparkles size={27} strokeWidth={1.6} /></span><span className="welcome-eyebrow">A LITTLE CLARITY, A LOT OF POSSIBILITY</span><span className="welcome-title">What’s on your mind?</span><span className="welcome-subtitle">Think it through. Make a plan. Start a conversation.</span><span className="welcome-hint">Your Gridrise agent is one message away <ArrowUpRight size={15} /></span></>}
    />
  );
}
