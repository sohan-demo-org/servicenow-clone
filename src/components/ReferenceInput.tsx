import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.ts'
import type { Rec } from '../api.ts'
import { TABLES } from '../../shared/schema.ts'
import { Icon } from './Icon.tsx'
import { recordUrl } from '../util.ts'

interface Props {
  table: string
  value: string
  display: string
  onChange: (id: string, display: string) => void
  refQuery?: string
  readOnly?: boolean
  id?: string
  placeholder?: string
}

export function ReferenceInput({ table, value, display, onChange, refQuery, readOnly, id, placeholder }: Props) {
  const def = TABLES[table]
  const [text, setText] = useState(display)
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<Rec[]>([])
  const [active, setActive] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => setText(display), [display])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      const q = [text ? `${def.displayField}LIKE${text}` : '', refQuery ?? '', `ORDERBY${def.displayField}`].filter(Boolean).join('^')
      const r = await api.list(table, { query: q, limit: 12 })
      setResults(r.result)
      setActive(0)
    }, 150)
    return () => clearTimeout(t)
  }, [text, open, table, refQuery, def.displayField])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) {
        setOpen(false)
        setText(display)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [display])

  const choose = (r: Rec | null) => {
    onChange(r?.sys_id ?? '', r ? String(r[def.displayField] ?? '') : '')
    setText(r ? String(r[def.displayField] ?? '') : '')
    setOpen(false)
  }

  const secondary = (r: Rec) => {
    if (table === 'sys_user') return String(r.email ?? '')
    if (table === 'cmdb_ci') return String(r.ip_address || r.os || '')
    if (table === 'sys_user_group') return ''
    return String(r.short_description ?? '')
  }

  return (
    <div className="sn-ref" ref={wrap}>
      <input
        id={id}
        className="sn-input"
        value={text}
        readOnly={readOnly}
        placeholder={placeholder}
        autoComplete="off"
        onFocus={() => !readOnly && setOpen(true)}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          if (!e.target.value) onChange('', '')
        }}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive(Math.min(active + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive(Math.max(active - 1, 0))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (results[active]) choose(results[active])
          } else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {!readOnly && (
        <button type="button" className="sn-ref-btn" tabIndex={-1} onClick={() => setOpen(!open)} title={`Look up ${def.label}`}>
          <Icon name="search" size={14} />
        </button>
      )}
      {value && (
        <Link className="sn-ref-btn info" to={recordUrl(table, value)} title={`Open ${def.label}`}>
          <Icon name="info" size={14} />
        </Link>
      )}
      {open && !readOnly && (
        <div className="sn-ref-dropdown" role="listbox">
          {results.length === 0 && <div className="sn-ref-empty">No matches</div>}
          {results.map((r, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === active}
              key={r.sys_id}
              className={`sn-ref-option ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <span>{String(r[def.displayField] ?? '')}</span>
              <small>{secondary(r)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
