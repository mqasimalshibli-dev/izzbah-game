import { useEffect, useMemo, useRef, useState } from 'react'

/* ------------------------------------------------------------------ *
 * Pulse — an interactive, animated chat home screen.
 * Everything below runs on mock data; no backend required.
 * ------------------------------------------------------------------ */

const SEED = [
  {
    id: 'aisha',
    name: 'Aisha Rahman',
    avatar: '🦋',
    accent: '#7c5cff',
    online: true,
    unread: 2,
    messages: [
      { id: 1, from: 'them', text: 'Morning! Did you get a chance to look at the deck?', time: '09:02' },
      { id: 2, from: 'me', text: 'Yep — slides 4 and 7 are 🔥', time: '09:04' },
      { id: 3, from: 'them', text: 'Knew you’d like the motion study 😄', time: '09:05' },
      { id: 4, from: 'them', text: 'Can we hop on a quick call at noon?', time: '09:05' },
    ],
  },
  {
    id: 'design',
    name: 'Design Guild',
    avatar: '🎨',
    accent: '#ff7a59',
    online: true,
    unread: 5,
    members: 'Lina, Omar, Theo +4',
    messages: [
      { id: 1, from: 'them', text: 'Lina: new icon set is in Figma', time: '08:31' },
      { id: 2, from: 'them', text: 'Omar: the rounded variant is chef’s kiss', time: '08:40' },
      { id: 3, from: 'me', text: 'Shipping it in the next build 🚀', time: '08:42' },
    ],
  },
  {
    id: 'omar',
    name: 'Omar Khalid',
    avatar: '🛰️',
    accent: '#2dd4bf',
    online: false,
    unread: 0,
    messages: [
      { id: 1, from: 'me', text: 'Pushed the fix, CI is green', time: 'Yesterday' },
      { id: 2, from: 'them', text: 'Legend. Merging now.', time: 'Yesterday' },
    ],
  },
  {
    id: 'mom',
    name: 'Mom 💛',
    avatar: '🌷',
    accent: '#f472b6',
    online: true,
    unread: 1,
    messages: [
      { id: 1, from: 'them', text: 'Are you eating properly?', time: '07:15' },
      { id: 2, from: 'me', text: 'Yes mom, I promise 😅', time: '07:20' },
      { id: 3, from: 'them', text: 'Call me when you’re free ❤️', time: '07:21' },
    ],
  },
  {
    id: 'nova',
    name: 'Nova (AI)',
    avatar: '🤖',
    accent: '#60a5fa',
    online: true,
    unread: 0,
    messages: [
      { id: 1, from: 'them', text: 'I drafted 3 taglines. Want bold or playful?', time: '11:48' },
      { id: 2, from: 'me', text: 'Playful, lean weird', time: '11:49' },
      { id: 3, from: 'them', text: 'On it. Generating…', time: '11:49' },
    ],
  },
]

const REPLIES = [
  'Haha totally 😄',
  'Good point — let me think about that.',
  'Sending it over now 📎',
  'On it!',
  'Wait, say more about that?',
  '💯',
  'Let’s do it.',
  'Give me 5 minutes ⏳',
  'That’s actually genius.',
  'Noted! I’ll follow up tomorrow.',
]

const nowLabel = () =>
  new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Avatar({ emoji, accent, online, size = 46 }) {
  return (
    <span className="avatar" style={{ '--accent': accent, width: size, height: size }}>
      <span className="avatar__emoji" style={{ fontSize: size * 0.5 }}>{emoji}</span>
      {online && <span className="avatar__dot" />}
    </span>
  )
}

function TypingDots() {
  return (
    <div className="bubble bubble--them typing" aria-label="typing">
      <span /><span /><span />
    </div>
  )
}

export default function App() {
  const [conversations, setConversations] = useState(SEED)
  const [activeId, setActiveId] = useState(SEED[0].id)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [typing, setTyping] = useState(false)
  const [dark, setDark] = useState(true)

  const threadRef = useRef(null)
  const replyTimer = useRef(null)

  const active = conversations.find((c) => c.id === activeId)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.messages[c.messages.length - 1]?.text.toLowerCase().includes(q),
    )
  }, [conversations, query])

  // Auto-scroll the thread to the newest message / typing indicator.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [active?.messages.length, typing, activeId])

  useEffect(() => () => clearTimeout(replyTimer.current), [])

  // The open conversation never shows an unread badge — clear it whenever it
  // becomes active (covers the initially-selected chat too, not just clicks).
  useEffect(() => {
    setConversations((prev) =>
      prev.some((c) => c.id === activeId && c.unread > 0)
        ? prev.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c))
        : prev,
    )
  }, [activeId])

  function openConversation(id) {
    setActiveId(id)
    setTyping(false)
    clearTimeout(replyTimer.current)
  }

  function send() {
    const text = draft.trim()
    if (!text || !active) return
    const mine = { id: Date.now(), from: 'me', text, time: nowLabel() }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeId ? { ...c, messages: [...c.messages, mine] } : c,
      ),
    )
    setDraft('')
    setTyping(true)
    clearTimeout(replyTimer.current)
    const replyText = REPLIES[Math.floor(Math.random() * REPLIES.length)]
    replyTimer.current = setTimeout(() => {
      setTyping(false)
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  { id: Date.now() + 1, from: 'them', text: replyText, time: nowLabel() },
                ],
              }
            : c,
        ),
      )
    }, 1400 + Math.random() * 900)
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className={`app ${dark ? 'theme-dark' : 'theme-light'}`}>
      <div className="shell">
        {/* ---------------- Sidebar ---------------- */}
        <aside className="sidebar">
          <header className="sidebar__head">
            <div className="brand">
              <span className="brand__logo">◈</span>
              <span className="brand__name">Pulse</span>
            </div>
            <button
              className="icon-btn theme-toggle"
              onClick={() => setDark((d) => !d)}
              aria-label="Toggle theme"
              title="Toggle theme"
            >
              <span className="theme-toggle__thumb">{dark ? '🌙' : '☀️'}</span>
            </button>
          </header>

          <div className="search">
            <span className="search__icon">⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
            />
            {query && (
              <button className="search__clear" onClick={() => setQuery('')} aria-label="Clear">×</button>
            )}
          </div>

          <nav className="convo-list">
            {filtered.length === 0 && <p className="empty">No matches for “{query}”.</p>}
            {filtered.map((c, i) => {
              const last = c.messages[c.messages.length - 1]
              return (
                <button
                  key={c.id}
                  className={`convo ${c.id === activeId ? 'is-active' : ''}`}
                  style={{ animationDelay: `${i * 55}ms` }}
                  onClick={() => openConversation(c.id)}
                >
                  <Avatar emoji={c.avatar} accent={c.accent} online={c.online} />
                  <span className="convo__body">
                    <span className="convo__top">
                      <span className="convo__name">{c.name}</span>
                      <span className="convo__time">{last?.time}</span>
                    </span>
                    <span className="convo__preview">
                      {last?.from === 'me' ? 'You: ' : ''}
                      {last?.text}
                    </span>
                  </span>
                  {c.unread > 0 && <span className="badge">{c.unread}</span>}
                </button>
              )
            })}
          </nav>

          <footer className="me-card">
            <Avatar emoji="🧑‍🚀" accent="#a78bfa" online size={40} />
            <div className="me-card__txt">
              <strong>You</strong>
              <small>Active now</small>
            </div>
            <span className="me-card__cta">＋</span>
          </footer>
        </aside>

        {/* ---------------- Chat panel ---------------- */}
        <main className="chat">
          <header className="chat__head">
            <div className="chat__peer">
              <Avatar emoji={active.avatar} accent={active.accent} online={active.online} />
              <div>
                <div className="chat__name">{active.name}</div>
                <div className={`chat__status ${active.online ? 'on' : ''}`}>
                  {active.members ? active.members : active.online ? 'Online' : 'Last seen recently'}
                </div>
              </div>
            </div>
            <div className="chat__actions">
              {['📞', '🎥', 'ⓘ'].map((g) => (
                <button key={g} className="icon-btn" aria-label="action">{g}</button>
              ))}
            </div>
          </header>

          <div className="thread" ref={threadRef}>
            {active.messages.map((m) => (
              <div key={m.id} className={`row ${m.from === 'me' ? 'row--me' : ''}`}>
                <div className={`bubble ${m.from === 'me' ? 'bubble--me' : 'bubble--them'}`}>
                  <span className="bubble__text">{m.text}</span>
                  <span className="bubble__time">{m.time}</span>
                </div>
              </div>
            ))}
            {typing && (
              <div className="row">
                <TypingDots />
              </div>
            )}
          </div>

          <div className="composer">
            <button className="icon-btn" aria-label="emoji">😊</button>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={`Message ${active.name.split(' ')[0]}…`}
              aria-label="Message"
            />
            <button
              className={`send ${draft.trim() ? 'ready' : ''}`}
              onClick={send}
              disabled={!draft.trim()}
              aria-label="Send"
            >
              ➤
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}
