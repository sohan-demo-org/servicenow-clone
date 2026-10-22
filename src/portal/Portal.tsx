import { useEffect, useState } from 'react'
import { Link, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { TABLES, URGENCY, choiceLabel } from '../../shared/schema.ts'
import { api } from '../api.ts'
import type { JournalEntry, Rec } from '../api.ts'
import { Icon } from '../components/Icon.tsx'
import { isAgent, useAuth } from '../auth.tsx'
import { initials, recordUrl, timeAgo } from '../util.ts'
import { NotificationBell } from '../components/NotificationBell.tsx'

const CATS = [
  { value: '', label: 'All items' },
  ...(TABLES.sc_cat_item.fields.find((f) => f.name === 'category')?.choices ?? []),
]

function money(n: unknown) {
  const v = Number(n ?? 0)
  return v === 0 ? 'Free' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
}

export function PortalLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  return (
    <div className="sp">
      <header className="sp-header">
        <Link to="/sp" className="sp-brand">
          <span className="sp-brand-mark">now</span> Service Portal
        </Link>
        <nav>
          <Link to="/sp/catalog">Request Something</Link>
          <Link to="/sp/kb">Knowledge</Link>
          <Link to="/sp/get-help">Get Help</Link>
          <Link to="/sp/tickets">My Tickets</Link>
          {isAgent(user) && <Link to="/">Agent View</Link>}
        </nav>
        <div className="sp-user">
          <NotificationBell />
          <span className="sn-avatar sm">{initials(String(user?.name ?? ''))}</span>
          {String(user?.name ?? '')}
          <button
            className="sp-logout"
            onClick={() => {
              logout()
              navigate('/login')
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <Outlet />
      <footer className="sp-footer">ServiceNow clone · unaffiliated demo</footer>
    </div>
  )
}

function PortalSearch({ big }: { big?: boolean }) {
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  return (
    <form
      className={`sp-search ${big ? 'big' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim()) navigate(`/sp/kb?q=${encodeURIComponent(q.trim())}`)
      }}
    >
      <Icon name="search" size={20} />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="How can we help?" aria-label="Search portal" />
      <button className="sp-btn">Search</button>
    </form>
  )
}

export function PortalHome() {
  const { user } = useAuth()
  const [items, setItems] = useState<Rec[]>([])
  const [articles, setArticles] = useState<Rec[]>([])
  const [mine, setMine] = useState<Rec[]>([])
  useEffect(() => {
    document.title = 'Service Portal | ServiceNow Clone'
    api.list('sc_cat_item', { query: 'active=true^ORDERBYname', limit: 6 }).then((r) => setItems(r.result))
    api.list('kb_knowledge', { query: 'workflow_state=published^ORDERBYDESCsys_view_count', limit: 5 }).then((r) => setArticles(r.result))
    api.list('incident', { query: 'caller_id=javascript:gs.getUserID()^stateNOTIN6,7,8^ORDERBYDESCsys_updated_on', limit: 4 }).then((r) => setMine(r.result))
  }, [])
  return (
    <>
      <section className="sp-hero">
        <h1>Good day, {String(user?.name ?? '').split(' ')[0]}. How can we help?</h1>
        <PortalSearch big />
      </section>
      <div className="sp-container">
        <div className="sp-tiles">
          {[
            { to: '/sp/catalog', icon: 'cart', title: 'Request Something', text: 'Browse the catalog for hardware, software and services' },
            { to: '/sp/kb', icon: 'book', title: 'Knowledge Base', text: 'Find answers in how-to articles and policies' },
            { to: '/sp/get-help', icon: 'wrench', title: 'Get Help', text: 'Report an issue and we will get on it' },
            { to: '/sp/tickets', icon: 'list', title: 'My Tickets', text: 'Track your open incidents and requests' },
          ].map((t) => (
            <Link to={t.to} key={t.title} className="sp-tile">
              <span className="sp-tile-icon">
                <Icon name={t.icon} size={28} />
              </span>
              <b>{t.title}</b>
              <span>{t.text}</span>
            </Link>
          ))}
        </div>
        <div className="sp-grid">
          <section className="sp-card">
            <h2>Popular Items</h2>
            <div className="sp-items small">
              {items.map((i) => (
                <ItemCard key={i.sys_id} item={i} />
              ))}
            </div>
          </section>
          <aside>
            <section className="sp-card">
              <h2>My Open Tickets</h2>
              {mine.length === 0 && <div className="muted">You have no open tickets.</div>}
              {mine.map((m) => (
                <Link key={m.sys_id} to={`/sp/ticket/incident/${m.sys_id}`} className="sp-row">
                  <b>{String(m.short_description)}</b>
                  <small>
                    {String(m.number)} · {choiceLabel('incident', 'state', String(m.state))} · updated {timeAgo(String(m.sys_updated_on))}
                  </small>
                </Link>
              ))}
            </section>
            <section className="sp-card">
              <h2>Top Articles</h2>
              {articles.map((a) => (
                <Link key={a.sys_id} to={`/sp/kb/${a.sys_id}`} className="sp-row">
                  <b>{String(a.short_description)}</b>
                  <small>
                    {String(a.number)} · {String(a.sys_view_count)} views
                  </small>
                </Link>
              ))}
            </section>
          </aside>
        </div>
      </div>
    </>
  )
}

function ItemCard({ item }: { item: Rec }) {
  return (
    <Link to={`/sp/item/${item.sys_id}`} className="sp-item" data-testid="catalog-item">
      <span className="sp-item-icon">
        <Icon name={String(item.icon ?? 'cart')} size={30} />
      </span>
      <b>{String(item.name)}</b>
      <span className="sp-item-desc">{String(item.short_description ?? '')}</span>
      <span className="sp-price">{money(item.price)}</span>
    </Link>
  )
}

export function PortalCatalog() {
  const [cat, setCat] = useState('')
  const [items, setItems] = useState<Rec[]>([])
  useEffect(() => {
    document.title = 'Service Catalog | ServiceNow Clone'
    api.list('sc_cat_item', { query: `active=true${cat ? `^category=${cat}` : ''}^ORDERBYname`, limit: 100 }).then((r) => setItems(r.result))
  }, [cat])
  return (
    <div className="sp-container">
      <div className="sp-crumbs">
        <Link to="/sp">Home</Link> › Service Catalog
      </div>
      <div className="sp-catalog">
        <aside className="sp-card sp-cats">
          <h2>Categories</h2>
          {CATS.map((c) => (
            <button key={c.value} className={cat === c.value ? 'on' : ''} onClick={() => setCat(c.value)}>
              {c.label}
            </button>
          ))}
        </aside>
        <section>
          <h1 className="sp-h1">{CATS.find((c) => c.value === cat)?.label}</h1>
          <div className="sp-items">
            {items.map((i) => (
              <ItemCard key={i.sys_id} item={i} />
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

export function PortalItem() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [item, setItem] = useState<Rec | null>(null)
  const [qty, setQty] = useState(1)
  const [vars, setVars] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.get('sc_cat_item', id).then((r) => {
      setItem(r)
      document.title = `${String(r.name)} | Service Catalog`
    })
  }, [id])
  if (!item) return <div className="sp-container muted">Loading…</div>
  const category = String(item.category)
  const fields: { key: string; label: string; type: 'text' | 'select' | 'textarea'; options?: string[] }[] =
    category === 'hardware'
      ? [
          { key: 'Color', label: 'Color', type: 'select', options: ['Silver', 'Space Gray', 'Black'] },
          { key: 'Business justification', label: 'Business justification', type: 'textarea' },
        ]
      : category === 'access'
        ? [
            { key: 'Access level', label: 'Access level', type: 'select', options: ['Read only', 'Read / write', 'Administrator'] },
            { key: 'Reason', label: 'Why do you need access?', type: 'textarea' },
          ]
        : category === 'software'
          ? [
              { key: 'Operating system', label: 'Operating system', type: 'select', options: ['Windows', 'macOS'] },
              { key: 'Business justification', label: 'Business justification', type: 'textarea' },
            ]
          : [{ key: 'Details', label: 'Additional details', type: 'textarea' }]
  const total = Number(item.price ?? 0) * qty
  const order = async () => {
    setBusy(true)
    try {
      const ritm = await api.order(id, { quantity: qty, variables: vars })
      navigate(`/sp/order/${ritm.sys_id}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="sp-container">
      <div className="sp-crumbs">
        <Link to="/sp">Home</Link> › <Link to="/sp/catalog">Service Catalog</Link> › {String(item.name)}
      </div>
      <div className="sp-item-page">
        <section className="sp-card">
          <div className="sp-item-head">
            <span className="sp-item-icon lg">
              <Icon name={String(item.icon ?? 'cart')} size={40} />
            </span>
            <div>
              <h1 className="sp-h1">{String(item.name)}</h1>
              <div className="muted">{String(item.description ?? '')}</div>
            </div>
          </div>
          {fields.map((f) => (
            <label className="sp-field" key={f.key}>
              <span>{f.label}</span>
              {f.type === 'select' ? (
                <select className="sn-input" value={vars[f.key] ?? ''} onChange={(e) => setVars({ ...vars, [f.key]: e.target.value })}>
                  <option value="">-- Choose --</option>
                  {f.options?.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea className="sn-input" rows={3} value={vars[f.key] ?? ''} onChange={(e) => setVars({ ...vars, [f.key]: e.target.value })} />
              ) : (
                <input className="sn-input" value={vars[f.key] ?? ''} onChange={(e) => setVars({ ...vars, [f.key]: e.target.value })} />
              )}
            </label>
          ))}
        </section>
        <aside className="sp-card sp-order-box">
          <div className="sp-price big">{money(total)}</div>
          <div className="muted">Delivery time: {String(item.delivery_time ?? '')}</div>
          <label className="sp-field">
            <span>Quantity</span>
            <select className="sn-input" value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="Quantity">
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          {total >= 1000 && <div className="sp-note">Orders of $1,000 or more require manager approval.</div>}
          <button className="sp-btn block" disabled={busy} onClick={order} data-testid="order-now">
            Order Now
          </button>
        </aside>
      </div>
    </div>
  )
}

export function PortalOrderDone() {
  const { id = '' } = useParams()
  const [ritm, setRitm] = useState<Rec | null>(null)
  useEffect(() => {
    api.get('sc_req_item', id).then(setRitm)
  }, [id])
  if (!ritm) return <div className="sp-container muted">Loading…</div>
  return (
    <div className="sp-container">
      <section className="sp-card sp-done" data-testid="order-confirmation">
        <span className="sp-done-icon">
          <Icon name="check" size={36} />
        </span>
        <h1 className="sp-h1">Thank you, your request has been submitted</h1>
        <p>
          Request item <b>{String(ritm.number)}</b> for <b>{ritm._dv?.cat_item}</b> (qty {String(ritm.quantity)}) is{' '}
          <b>{choiceLabel('sc_req_item', 'stage', String(ritm.stage))}</b>.
        </p>
        <div className="sp-done-actions">
          <Link className="sp-btn" to={`/sp/ticket/sc_req_item/${ritm.sys_id}`}>
            View request
          </Link>
          <Link className="sp-btn ghost" to="/sp/catalog">
            Continue shopping
          </Link>
        </div>
      </section>
    </div>
  )
}

export function PortalGetHelp() {
  const navigate = useNavigate()
  const [sd, setSd] = useState('')
  const [desc, setDesc] = useState('')
  const [urgency, setUrgency] = useState('3')
  const [category, setCategory] = useState('inquiry')
  const [err, setErr] = useState('')
  const { user } = useAuth()
  useEffect(() => {
    document.title = 'Get Help | ServiceNow Clone'
  }, [])
  const submit = async () => {
    if (!sd.trim()) {
      setErr('Please tell us briefly what is wrong.')
      return
    }
    const inc = await api.create('incident', {
      caller_id: user?.sys_id,
      short_description: sd,
      description: desc,
      urgency,
      impact: '3',
      category,
      contact_type: 'self-service',
    })
    navigate(`/sp/ticket/incident/${inc.sys_id}?created=1`)
  }
  return (
    <div className="sp-container narrow">
      <div className="sp-crumbs">
        <Link to="/sp">Home</Link> › Get Help
      </div>
      <section className="sp-card">
        <h1 className="sp-h1">Report an issue</h1>
        <p className="muted">Something not working? Tell us and the Service Desk will pick it up.</p>
        <label className="sp-field">
          <span>
            <i className="req">*</i> What is the issue?
          </span>
          <input className="sn-input" value={sd} onChange={(e) => setSd(e.target.value)} placeholder="e.g. My laptop will not connect to Wi-Fi" data-testid="gethelp-sd" />
        </label>
        <div className="sp-two">
          <label className="sp-field">
            <span>Category</span>
            <select className="sn-input" value={category} onChange={(e) => setCategory(e.target.value)}>
              {TABLES.incident.fields
                .find((f) => f.name === 'category')
                ?.choices?.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
            </select>
          </label>
          <label className="sp-field">
            <span>How urgent is it?</span>
            <select className="sn-input" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
              {URGENCY.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="sp-field">
          <span>Please describe the issue</span>
          <textarea className="sn-input" rows={5} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        {err && <div className="sn-msg error">{err}</div>}
        <button className="sp-btn" onClick={submit} data-testid="gethelp-submit">
          Submit
        </button>
      </section>
    </div>
  )
}

export function PortalTickets() {
  const [incs, setIncs] = useState<Rec[]>([])
  const [reqs, setReqs] = useState<Rec[]>([])
  useEffect(() => {
    document.title = 'My Tickets | ServiceNow Clone'
    api.list('incident', { query: 'caller_id=javascript:gs.getUserID()^ORDERBYDESCsys_updated_on', limit: 50 }).then((r) => setIncs(r.result))
    api.list('sc_req_item', { query: 'requested_for=javascript:gs.getUserID()^ORDERBYDESCsys_created_on', limit: 50 }).then((r) => setReqs(r.result))
  }, [])
  const rows = [
    ...incs.map((r) => ({ r, table: 'incident', status: choiceLabel('incident', 'state', String(r.state)) })),
    ...reqs.map((r) => ({ r, table: 'sc_req_item', status: choiceLabel('sc_req_item', 'stage', String(r.stage)) })),
  ].sort((a, b) => String(b.r.sys_updated_on).localeCompare(String(a.r.sys_updated_on)))
  return (
    <div className="sp-container">
      <div className="sp-crumbs">
        <Link to="/sp">Home</Link> › My Tickets
      </div>
      <section className="sp-card">
        <h1 className="sp-h1">My Tickets</h1>
        {rows.length === 0 && <div className="muted">Nothing here yet.</div>}
        {rows.map(({ r, table, status }) => (
          <Link key={r.sys_id} to={`/sp/ticket/${table}/${r.sys_id}`} className="sp-ticket-row">
            <span className="sp-ticket-type">{table === 'incident' ? 'Incident' : 'Request'}</span>
            <span className="grow">
              <b>{String(r.short_description ?? r._dv?.cat_item ?? '')}</b>
              <small>
                {String(r.number)} · updated {timeAgo(String(r.sys_updated_on))}
              </small>
            </span>
            <span className="sp-status">{status}</span>
          </Link>
        ))}
      </section>
    </div>
  )
}

export function PortalTicket() {
  const { table = '', id = '' } = useParams()
  const [sp] = useSearchParams()
  const { user } = useAuth()
  const [rec, setRec] = useState<Rec | null>(null)
  const [journal, setJournal] = useState<JournalEntry[]>([])
  const [text, setText] = useState('')
  useEffect(() => {
    api.get(table, id).then(setRec)
    api.journal(table, id).then(setJournal)
  }, [table, id])
  if (!rec) return <div className="sp-container muted">Loading…</div>
  const post = async () => {
    if (!text.trim()) return
    await api.addJournal(table, id, 'comments', text.trim())
    setText('')
    setJournal(await api.journal(table, id))
  }
  const comments = journal.filter((j) => j.element === 'comments')
  return (
    <div className="sp-container">
      <div className="sp-crumbs">
        <Link to="/sp">Home</Link> › <Link to="/sp/tickets">My Tickets</Link> › {String(rec.number)}
      </div>
      {sp.get('created') && (
        <div className="sn-msg success" data-testid="ticket-created">
          Incident {String(rec.number)} has been created. The Service Desk will be in touch.
        </div>
      )}
      <div className="sp-ticket">
        <section className="sp-card">
          <h1 className="sp-h1">{String(rec.short_description ?? rec._dv?.cat_item ?? '')}</h1>
          <div className="sp-compose">
            <textarea className="sn-input" rows={2} placeholder="Type your message here…" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="sp-btn" onClick={post}>
              Send
            </button>
          </div>
          <ul className="sp-convo">
            {comments.map((c) => (
              <li key={c.sys_id} className={c.sys_created_by === user?.name ? 'me' : ''}>
                <span className="sn-avatar sm">{initials(c.sys_created_by)}</span>
                <div>
                  <small>
                    <b>{c.sys_created_by}</b> · {timeAgo(c.sys_created_on)}
                  </small>
                  <p>{c.value}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <aside className="sp-card sp-details">
          <h2>Details</h2>
          <dl>
            <dt>Number</dt>
            <dd>{String(rec.number)}</dd>
            <dt>State</dt>
            <dd>{choiceLabel(table, 'state', String(rec.state))}</dd>
            {table === 'sc_req_item' && (
              <>
                <dt>Stage</dt>
                <dd>{choiceLabel(table, 'stage', String(rec.stage))}</dd>
                <dt>Approval</dt>
                <dd>{choiceLabel(table, 'approval', String(rec.approval))}</dd>
              </>
            )}
            {table === 'incident' && (
              <>
                <dt>Priority</dt>
                <dd>{choiceLabel(table, 'priority', String(rec.priority))}</dd>
              </>
            )}
            <dt>Assigned to</dt>
            <dd>{rec._dv?.assigned_to || '—'}</dd>
            <dt>Created</dt>
            <dd>{timeAgo(String(rec.sys_created_on))}</dd>
          </dl>
          {isAgent(user) && (
            <Link className="sn-link" to={recordUrl(table, id)}>
              Open in agent view
            </Link>
          )}
        </aside>
      </div>
    </div>
  )
}

export function PortalKb() {
  const [sp, setSp] = useSearchParams()
  const q = sp.get('q') ?? ''
  const [cat, setCat] = useState('')
  const [articles, setArticles] = useState<Rec[]>([])
  const cats = TABLES.kb_knowledge.fields.find((f) => f.name === 'kb_category')?.choices ?? []
  useEffect(() => {
    document.title = 'Knowledge | ServiceNow Clone'
    api
      .list('kb_knowledge', {
        query: ['workflow_state=published', cat ? `kb_category=${cat}` : '', q ? `short_descriptionLIKE${q}^ORtextLIKE${q}` : '', 'ORDERBYDESCsys_view_count'].filter(Boolean).join('^'),
        limit: 50,
      })
      .then((r) => setArticles(r.result))
  }, [q, cat])
  return (
    <>
      <section className="sp-hero small">
        <h1>Knowledge Base</h1>
        <form
          className="sp-search"
          onSubmit={(e) => {
            e.preventDefault()
            const v = new FormData(e.currentTarget).get('q')
            setSp(v ? { q: String(v) } : {})
          }}
        >
          <Icon name="search" size={20} />
          <input name="q" defaultValue={q} placeholder="Search knowledge" aria-label="Search knowledge" key={q} />
          <button className="sp-btn">Search</button>
        </form>
      </section>
      <div className="sp-container">
        <div className="sp-catalog">
          <aside className="sp-card sp-cats">
            <h2>Categories</h2>
            <button className={cat === '' ? 'on' : ''} onClick={() => setCat('')}>
              All
            </button>
            {cats.map((c) => (
              <button key={c.value} className={cat === c.value ? 'on' : ''} onClick={() => setCat(c.value)}>
                {c.label}
              </button>
            ))}
          </aside>
          <section className="sp-card">
            <h2>{q ? `Results for “${q}”` : 'Articles'}</h2>
            {articles.length === 0 && <div className="muted">No articles found.</div>}
            {articles.map((a) => (
              <Link key={a.sys_id} to={`/sp/kb/${a.sys_id}`} className="sp-article-row">
                <b>{String(a.short_description)}</b>
                <span className="muted">{String(a.text ?? '').slice(0, 140)}…</span>
                <small>
                  {String(a.number)} · {choiceLabel('kb_knowledge', 'kb_category', String(a.kb_category))} · {String(a.sys_view_count)} views · {String(a.rating)} found helpful
                </small>
              </Link>
            ))}
          </section>
        </div>
      </div>
    </>
  )
}

export function PortalArticle() {
  const { id = '' } = useParams()
  const [a, setA] = useState<Rec | null>(null)
  const [voted, setVoted] = useState(false)
  useEffect(() => {
    setVoted(false)
    api.kbView(id).then((r) => {
      setA(r)
      document.title = `${String(r.short_description)} | Knowledge`
    })
  }, [id])
  if (!a) return <div className="sp-container muted">Loading…</div>
  return (
    <div className="sp-container narrow">
      <div className="sp-crumbs">
        <Link to="/sp">Home</Link> › <Link to="/sp/kb">Knowledge</Link> › {String(a.number)}
      </div>
      <article className="sp-card sp-article">
        <div className="muted small">
          {String(a.number)} · {choiceLabel('kb_knowledge', 'kb_category', String(a.kb_category))} · by {a._dv?.author} · {String(a.sys_view_count)} views
        </div>
        <h1 className="sp-h1">{String(a.short_description)}</h1>
        {String(a.text ?? '')
          .split('\n')
          .filter(Boolean)
          .map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        <div className="sp-helpful">
          Was this article helpful?
          <button
            className="sp-btn ghost"
            disabled={voted}
            onClick={async () => {
              setA(await api.kbHelpful(id))
              setVoted(true)
            }}
          >
            <Icon name="thumb" size={14} /> Yes
          </button>
          {voted && <span className="muted">Thanks for your feedback! ({String(a.rating)} people found this helpful)</span>}
        </div>
      </article>
    </div>
  )
}
