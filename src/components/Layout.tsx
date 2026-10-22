import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Icon } from './Icon.tsx'
import { NotificationBell } from './NotificationBell.tsx'
import { NAV } from '../nav.ts'
import { isAgent, useAuth } from '../auth.tsx'
import { getHistory, initials, listUrl, recordUrl, timeAgo } from '../util.ts'
import { api } from '../api.ts'
import type { Rec } from '../api.ts'

const TitleCtx = createContext<(t: string) => void>(() => {})

// oxlint-disable-next-line react/only-export-components
export function usePageTitle(title: string) {
  const set = useContext(TitleCtx)
  useEffect(() => {
    set(title)
    document.title = title ? `${title} | ServiceNow Clone` : 'ServiceNow Clone'
  }, [title, set])
}

const FAVORITES = [
  { label: 'Incidents - Open', to: listUrl('incident', 'stateNOTIN6,7,8') },
  { label: 'ITSM Overview', to: '/' },
  { label: 'Change - Awaiting Approval', to: listUrl('change_request', 'approval=requested') },
  { label: 'Service Portal', to: '/sp' },
]

function useClickAway(onAway: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onAway])
  return ref
}

function Header({ title, navOpen, toggleNav }: { title: string; navOpen: boolean; toggleNav: () => void }) {
  const { user, logout, login } = useAuth()
  const navigate = useNavigate()
  const [menu, setMenu] = useState<'' | 'fav' | 'hist' | 'user' | 'imp'>('')
  const [q, setQ] = useState('')
  const [impUsers, setImpUsers] = useState<Rec[]>([])
  const close = () => setMenu('')
  const ref = useClickAway(close)

  const openImpersonate = async () => {
    setMenu('imp')
    const r = await api.list('sys_user', { query: 'active=true^ORDERBYname', limit: 50 })
    setImpUsers(r.result)
  }

  return (
    <header className="sn-header" ref={ref}>
      <Link to={isAgent(user) ? '/' : '/sp'} className="sn-logo" aria-label="Home">
        service<span>now</span>
        <small>clone</small>
      </Link>
      <nav className="sn-header-menus">
        <button className={`sn-hmenu ${navOpen ? 'active' : ''}`} onClick={toggleNav} data-testid="menu-all">
          All
        </button>
        <div className="sn-hmenu-wrap">
          <button className={`sn-hmenu ${menu === 'fav' ? 'active' : ''}`} onClick={() => setMenu(menu === 'fav' ? '' : 'fav')}>
            Favorites <Icon name="chevronDown" size={14} />
          </button>
          {menu === 'fav' && (
            <div className="sn-dropdown">
              {FAVORITES.map((f) => (
                <Link key={f.label} to={f.to} onClick={close} className="sn-dropdown-item">
                  <Icon name="star" size={14} className="fav-star" /> {f.label}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="sn-hmenu-wrap">
          <button className={`sn-hmenu ${menu === 'hist' ? 'active' : ''}`} onClick={() => setMenu(menu === 'hist' ? '' : 'hist')}>
            History <Icon name="chevronDown" size={14} />
          </button>
          {menu === 'hist' && (
            <div className="sn-dropdown wide">
              {getHistory().length === 0 && <div className="sn-dropdown-empty">No recently viewed records</div>}
              {getHistory().map((h) => (
                <Link key={h.id} to={recordUrl(h.table, h.id)} onClick={close} className="sn-dropdown-item two-line">
                  <span>
                    <b>{h.title}</b> {h.subtitle}
                  </span>
                  <small>{timeAgo(new Date(h.at).toISOString().slice(0, 19).replace('T', ' '))}</small>
                </Link>
              ))}
            </div>
          )}
        </div>
      </nav>
      {title && <div className="sn-context-title">{title}</div>}
      <div className="sn-header-right">
        <form
          className="sn-global-search"
          onSubmit={(e) => {
            e.preventDefault()
            if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`)
          }}
        >
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Global search" />
        </form>
        <button className="sn-icon-btn" title="Help" onClick={() => navigate('/sp/kb')}>
          <Icon name="help" size={20} />
        </button>
        <NotificationBell />
        <div className="sn-hmenu-wrap">
          <button className="sn-avatar" onClick={() => setMenu(menu === 'user' ? '' : 'user')} title={String(user?.name ?? '')} data-testid="user-menu">
            {initials(String(user?.name ?? '?'))}
          </button>
          {(menu === 'user' || menu === 'imp') && (
            <div className="sn-dropdown right">
              <div className="sn-user-card">
                <div className="sn-avatar lg">{initials(String(user?.name ?? '?'))}</div>
                <div>
                  <b>{user?.name}</b>
                  <div className="muted">{user?.title}</div>
                  <div className="muted">Role: {user?.role}</div>
                </div>
              </div>
              {menu === 'user' ? (
                <>
                  <Link className="sn-dropdown-item" to={recordUrl('sys_user', String(user?.sys_id))} onClick={close}>
                    <Icon name="user" size={14} /> Profile
                  </Link>
                  <button className="sn-dropdown-item" onClick={openImpersonate}>
                    <Icon name="key" size={14} /> Impersonate user
                  </button>
                  <button
                    className="sn-dropdown-item"
                    onClick={() => {
                      logout()
                      navigate('/login')
                    }}
                  >
                    <Icon name="logout" size={14} /> Log out
                  </button>
                </>
              ) : (
                <div className="sn-imp-list">
                  <div className="sn-dropdown-label">Impersonate user</div>
                  {impUsers.map((u) => (
                    <button
                      key={u.sys_id}
                      className="sn-dropdown-item"
                      onClick={async () => {
                        const nu = await login(String(u.user_name), 'demo')
                        close()
                        navigate(isAgent(nu) ? '/' : '/sp')
                      }}
                    >
                      {u.name} <small className="muted">({u.role})</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function Navigator() {
  const { user } = useAuth()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const location = useLocation()
  const f = filter.trim().toLowerCase()
  const apps = NAV.filter((a) => !a.agentOnly || isAgent(user))
    .map((a) => ({
      ...a,
      modules: f && !a.label.toLowerCase().includes(f) ? a.modules.filter((m) => m.label.toLowerCase().includes(f)) : a.modules,
    }))
    .filter((a) => a.modules.length > 0)
  const current = location.pathname + location.search

  return (
    <aside className="sn-nav" data-testid="navigator">
      <div className="sn-nav-filter">
        <Icon name="filter" size={14} />
        <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter navigator" aria-label="Filter navigator" />
        {filter && (
          <button onClick={() => setFilter('')} aria-label="Clear filter">
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <div className="sn-nav-scroll">
        {apps.map((a) => {
          const isCollapsed = !f && collapsed[a.label]
          return (
            <div className="sn-nav-app" key={a.label}>
              <button className="sn-nav-app-title" onClick={() => setCollapsed({ ...collapsed, [a.label]: !collapsed[a.label] })}>
                <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} />
                {a.label}
              </button>
              {!isCollapsed &&
                a.modules.map((m) => (
                  <NavLink key={m.label} to={m.to} className={() => `sn-nav-module ${current === m.to ? 'active' : ''}`}>
                    {m.label}
                  </NavLink>
                ))}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

export function Layout() {
  const [title, setTitle] = useState('')
  const [navOpen, setNavOpen] = useState(true)
  return (
    <TitleCtx.Provider value={setTitle}>
      <div className="sn-app">
        <Header title={title} navOpen={navOpen} toggleNav={() => setNavOpen(!navOpen)} />
        <div className="sn-body">
          {navOpen && <Navigator />}
          <main className="sn-main">
            <Outlet />
          </main>
        </div>
      </div>
    </TitleCtx.Provider>
  )
}
