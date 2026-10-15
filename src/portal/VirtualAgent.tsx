import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { VA_OPEN_EVENT, VA_TICKET_CREATED_EVENT, openVirtualAgent } from './vaEvents.ts'
import type { VaAction, VaCard, VaChip, VaMessage } from '../../shared/va.ts'

interface Line extends VaMessage {
  id: number
  from: 'bot' | 'user'
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let nextId = 1

const CARD_ICON: Record<VaCard['kind'], string> = { kb: 'book', item: 'cart', ticket: 'list', created: 'check' }

function Card({ card, onOpen }: { card: VaCard; onOpen: () => void }) {
  return (
    <Link to={card.to} className={`va-card ${card.kind}`} onClick={onOpen}>
      <span className="va-card-icon">
        <Icon name={card.icon || CARD_ICON[card.kind]} size={18} />
      </span>
      <span className="va-card-body">
        <b>{card.title}</b>
        <small>{card.subtitle}</small>
      </span>
      {card.badge && <span className="va-badge">{card.badge}</span>}
    </Link>
  )
}

export function VirtualAgent() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<Line[]>([])
  const [chips, setChips] = useState<VaChip[]>([])
  const [input, setInput] = useState('')
  const [typing, setTyping] = useState(false)
  const started = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [lines, typing])

  async function send(userText: string | null, body: { text?: string; action?: VaAction }) {
    if (typing) return
    if (userText) setLines((l) => [...l, { id: nextId++, from: 'user', text: userText }])
    setChips([])
    setTyping(true)
    try {
      const [reply] = await Promise.all([api.va(body), sleep(500)])
      for (const [i, m] of reply.messages.entries()) {
        if (i > 0) await sleep(450)
        setLines((l) => [...l, { ...m, id: nextId++, from: 'bot' }])
      }
      setChips(reply.chips)
      if (reply.messages.some((m) => m.cards?.some((c) => c.kind === 'created'))) window.dispatchEvent(new Event(VA_TICKET_CREATED_EVENT))
    } catch (e) {
      setLines((l) => [...l, { id: nextId++, from: 'bot', text: `Sorry, something went wrong: ${(e as Error).message}` }])
      setChips([{ label: 'Main menu', action: { type: 'menu' } }])
    } finally {
      setTyping(false)
      inputRef.current?.focus()
    }
  }

  useEffect(() => {
    const onOpen = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      setOpen(true)
      if (!started.current) {
        started.current = true
        if (!text) {
          void send(null, { action: { type: 'menu', greet: true } })
          return
        }
      }
      if (text) void send(text, { text })
    }
    window.addEventListener(VA_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(VA_OPEN_EVENT, onOpen)
  })

  function onChip(c: VaChip) {
    if (c.link) {
      navigate(c.link)
      return
    }
    void send(c.label, c.text ? { text: c.text } : { action: c.action })
  }

  if (!open) {
    return (
      <button className="va-launcher" onClick={() => openVirtualAgent()} aria-label="Chat with Virtual Agent">
        <Icon name="chat" size={26} />
        <span>Need help? Chat with us</span>
      </button>
    )
  }

  return (
    <section className="va-panel" role="dialog" aria-label="Virtual Agent">
      <header className="va-head">
        <span className="va-avatar">
          <Icon name="chat" size={18} />
        </span>
        <div>
          <b>Virtual Agent</b>
          <small>
            <i className="va-online" /> Online · typically replies instantly
          </small>
        </div>
        <button className="va-icon-btn" onClick={() => setOpen(false)} aria-label="Minimize chat">
          <Icon name="chevronDown" size={20} />
        </button>
      </header>
      <div className="va-log" ref={scroller} aria-live="polite">
        {lines.map((l) => (
          <div key={l.id} className={`va-line ${l.from}`}>
            {l.text && <div className="va-bubble">{l.text}</div>}
            {l.cards?.map((c) => (
              <Card key={c.to} card={c} onOpen={() => window.innerWidth < 700 && setOpen(false)} />
            ))}
          </div>
        ))}
        {typing && (
          <div className="va-line bot">
            <div className="va-bubble va-typing" aria-label="Virtual Agent is typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
        {!typing && chips.length > 0 && (
          <div className="va-chips">
            {chips.map((c) => (
              <button key={c.label} className="va-chip" onClick={() => onChip(c)}>
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <form
        className="va-input"
        onSubmit={(e) => {
          e.preventDefault()
          const t = input.trim()
          if (!t) return
          setInput('')
          void send(t, { text: t })
        }}
      >
        <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a message..." aria-label="Message" autoFocus />
        <button className="va-send" disabled={!input.trim() || typing} aria-label="Send">
          <Icon name="send" size={18} />
        </button>
      </form>
    </section>
  )
}
