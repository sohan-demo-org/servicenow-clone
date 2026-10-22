import { useEffect, useRef, useState } from 'react'
import { api } from '../api.ts'
import type { Rec } from '../api.ts'
import { initials } from '../util.ts'
import '../notifications.css'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  /** Work notes are internal, so only fulfillers are suggested. */
  agentsOnly?: boolean
  className?: string
  testId?: string
}

interface Token {
  start: number
  end: number
  query: string
}

const TOKEN_RE = /(^|[\s(])@([\w.-]{0,40})$/

export function MentionTextarea({ value, onChange, placeholder, rows = 3, agentsOnly, className, testId }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [token, setToken] = useState<Token | null>(null)
  const [options, setOptions] = useState<Rec[]>([])
  const [active, setActive] = useState(0)

  const detect = (text: string, caret: number) => {
    const m = TOKEN_RE.exec(text.slice(0, caret))
    setToken(m ? { start: caret - m[2].length - 1, end: caret, query: m[2] } : null)
  }

  const query = token?.query
  useEffect(() => {
    if (query === undefined) return
    let stale = false
    const q = query.replace(/[\^,]/g, '')
    const parts = ['active=true', agentsOnly ? 'roleINitil,admin' : '', q ? `user_nameSTARTSWITH${q}^ORnameLIKE${q}` : '', 'ORDERBYname'].filter(Boolean)
    api.list('sys_user', { query: parts.join('^'), limit: 6 }).then(
      (r) => {
        if (stale) return
        setOptions(r.result)
        setActive(0)
      },
      () => {},
    )
    return () => {
      stale = true
    }
  }, [query, agentsOnly])

  const open = token !== null && options.length > 0

  const select = (u: Rec) => {
    if (!token) return
    const insert = `@${u.user_name} `
    const next = value.slice(0, token.start) + insert + value.slice(token.end)
    onChange(next)
    setToken(null)
    const caret = token.start + insert.length
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="sn-mention-wrap">
      <textarea
        ref={ref}
        className={className}
        rows={rows}
        placeholder={placeholder}
        value={value}
        data-testid={testId}
        onChange={(e) => {
          onChange(e.target.value)
          detect(e.target.value, e.target.selectionStart)
        }}
        onClick={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setTimeout(() => setToken(null), 150)}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            select(options[active])
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setToken(null)
          }
        }}
      />
      {open && (
        <div className="sn-mention-menu" role="listbox" data-testid="mention-menu">
          <div className="sn-mention-menu-label">{agentsOnly ? 'Mention a fulfiller' : 'Mention a user'}</div>
          {options.map((u, i) => (
            <button
              key={u.sys_id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`sn-mention-option ${i === active ? 'active' : ''}`}
              data-testid="mention-option"
              onMouseDown={(e) => {
                e.preventDefault()
                select(u)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="sn-avatar">{initials(String(u.name ?? ''))}</span>
              <span>
                {u.name}
                <small>
                  @{u.user_name}
                  {u.title ? ` · ${u.title}` : ''}
                </small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
