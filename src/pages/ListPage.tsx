import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { TABLES, getField } from '../../shared/schema.ts'
import { api } from '../api.ts'
import type { Rec } from '../api.ts'
import { Cell } from '../components/ListTable.tsx'
import { FilterBuilder } from '../components/FilterBuilder.tsx'
import { Icon } from '../components/Icon.tsx'
import { usePageTitle } from '../components/Layout.tsx'
import { buildQuery, describeCondition, parseQuery, refNamesFromRows } from '../query.ts'
import type { Condition } from '../query.ts'
import { displayValue, recordUrl } from '../util.ts'
import { useAuth } from '../auth.tsx'

const PAGE = 20

export function ListPage() {
  const { table = '' } = useParams()
  const def = TABLES[table]
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const query = sp.get('sysparm_query') ?? ''
  const offset = Number(sp.get('sysparm_first_row') ?? 0)
  const [rows, setRows] = useState<Rec[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showFilter, setShowFilter] = useState(false)
  const [searchField, setSearchField] = useState(def?.displayField ?? 'number')
  const [searchText, setSearchText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; field: string; rec: Rec } | null>(null)
  const [refNames, setRefNames] = useState<Record<string, string>>({})
  const [reload, setReload] = useState(0)
  usePageTitle(def?.plural ?? '')

  const { conditions, order } = useMemo(() => parseQuery(query), [query])

  useEffect(() => {
    if (!def) return
    let live = true
    setLoading(true)
    api.list(table, { query, limit: PAGE, offset }).then((r) => {
      if (!live) return
      setRows(r.result)
      setTotal(r.total)
      setRefNames((prev) => ({ ...prev, ...refNamesFromRows(r.result) }))
      setLoading(false)
      setSelected(new Set())
    })
    return () => {
      live = false
    }
  }, [table, query, offset, def, reload])

  useEffect(() => {
    setSearchField(def?.displayField ?? 'number')
    setShowFilter(false)
  }, [table, def])

  useEffect(() => {
    const unresolved = conditions.filter((c) => getField(table, c.field)?.type === 'reference' && c.value && !refNames[c.value] && c.value !== 'javascript:gs.getUserID()')
    for (const c of unresolved) {
      const ref = getField(table, c.field)?.ref
      if (!ref) continue
      api
        .get(ref, c.value)
        .then((r) => setRefNames((p) => ({ ...p, [c.value]: String(r[TABLES[ref].displayField] ?? c.value) })))
        .catch(() => {})
    }
  }, [conditions, table, refNames])

  useEffect(() => {
    if (!ctxMenu) return
    const h = () => setCtxMenu(null)
    window.addEventListener('click', h)
    return () => window.removeEventListener('click', h)
  }, [ctxMenu])

  if (!def) return <div className="sn-page-pad">Unknown table “{table}”.</div>

  const go = (conds: Condition[], ord: string[] = order) => {
    const q = buildQuery(conds, ord)
    const next = new URLSearchParams()
    if (q) next.set('sysparm_query', q)
    setSp(next)
  }

  const sortBy = (field: string) => {
    const cur = order[0]
    const ord = cur === `ORDERBY${field}` ? [`ORDERBYDESC${field}`] : [`ORDERBY${field}`]
    go(conditions, ord)
  }

  const page = (o: number) => {
    const next = new URLSearchParams(sp)
    next.set('sysparm_first_row', String(Math.max(0, o)))
    setSp(next)
  }

  const runSearch = () => {
    if (!searchText.trim()) return
    const f = getField(table, searchField)
    const op = f?.type === 'choice' || f?.type === 'reference' ? '=' : 'LIKE'
    let value = searchText.trim()
    if (f?.type === 'choice') value = f.choices?.find((c) => c.label.toLowerCase() === value.toLowerCase() || c.value === value)?.value ?? value
    go([...conditions, { field: searchField, op: f?.type === 'reference' ? 'LIKE' : op, value }])
    setSearchText('')
  }

  const bulk = async (action: string) => {
    const ids = [...selected]
    if (!ids.length) return
    if (action === 'delete') {
      if (!confirm(`Delete ${ids.length} record(s)?`)) return
      await Promise.all(ids.map((id) => api.remove(table, id)))
    } else if (action === 'assign_me' && user) {
      await Promise.all(ids.map((id) => api.update(table, id, { assigned_to: user.sys_id })))
    }
    setReload((n) => n + 1)
  }

  const cols = def.listFields
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.sys_id))
  const sortField = order[0]?.replace(/^ORDERBY(DESC)?/, '')
  const sortDesc = order[0]?.startsWith('ORDERBYDESC')

  return (
    <div className="sn-list-page">
      <div className="sn-titlebar">
        <button className="sn-icon-btn dark" title="List controls">
          <Icon name="menu" size={18} />
        </button>
        <h1>{def.plural}</h1>
        <button className="sn-btn" onClick={() => navigate(recordUrl(table, '-1'))} data-testid="list-new">
          New
        </button>
        <div className="sn-list-search">
          <select className="sn-input" value={searchField} onChange={(e) => setSearchField(e.target.value)} aria-label="Search field">
            {def.fields
              .filter((f) => f.type !== 'text')
              .map((f) => (
                <option key={f.name} value={f.name}>
                  {f.label}
                </option>
              ))}
          </select>
          <input
            className="sn-input"
            placeholder="Search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            aria-label="Search list"
            data-testid="list-search"
          />
        </div>
        <div className="sn-titlebar-right">
          {def.fields.some((f) => f.name === 'assigned_to') && (
            <select className="sn-input" value="" onChange={(e) => bulk(e.target.value)} disabled={!selected.size} aria-label="Actions on selected rows">
              <option value="">Actions on selected rows…</option>
              <option value="assign_me">Assign to me</option>
              <option value="delete">Delete</option>
            </select>
          )}
          <span className="sn-pager-text">
            {total === 0 ? '0' : `${offset + 1} to ${Math.min(offset + PAGE, total)}`} of {total}
          </span>
          <button className="sn-icon-btn dark" disabled={offset === 0} onClick={() => page(0)} aria-label="First page">
            «
          </button>
          <button className="sn-icon-btn dark" disabled={offset === 0} onClick={() => page(offset - PAGE)} aria-label="Previous page">
            <Icon name="chevronLeft" size={16} />
          </button>
          <button className="sn-icon-btn dark" disabled={offset + PAGE >= total} onClick={() => page(offset + PAGE)} aria-label="Next page">
            <Icon name="chevronRight" size={16} />
          </button>
          <button className="sn-icon-btn dark" disabled={offset + PAGE >= total} onClick={() => page(Math.floor((total - 1) / PAGE) * PAGE)} aria-label="Last page">
            »
          </button>
        </div>
      </div>

      <div className="sn-breadcrumb-bar">
        <button className={`sn-icon-btn dark ${showFilter ? 'on' : ''}`} onClick={() => setShowFilter(!showFilter)} title="Show / hide filter" data-testid="filter-toggle">
          <Icon name="filter" size={16} />
        </button>
        <div className="sn-breadcrumbs" data-testid="breadcrumbs">
          <button className="sn-crumb" onClick={() => go([], order)}>
            All
          </button>
          {conditions.map((c, i) => (
            <span key={i} className="sn-crumb-wrap">
              <span className="sn-crumb-sep">&gt;</span>
              <button className="sn-crumb" onClick={() => go(conditions.slice(0, i + 1))} title="Remove conditions to the right">
                {describeCondition(table, c, refNames)}
              </button>
            </span>
          ))}
        </div>
      </div>

      {showFilter && (
        <FilterBuilder
          table={table}
          initial={conditions}
          refNames={refNames}
          onClose={() => setShowFilter(false)}
          onRun={(conds) => {
            go(conds)
            setShowFilter(false)
          }}
        />
      )}

      <div className="sn-table-wrap">
        <table className="sn-table" data-testid="list-table">
          <thead>
            <tr>
              <th className="chk">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.sys_id)))}
                  aria-label="Select all"
                />
              </th>
              <th className="chk" />
              {cols.map((c) => (
                <th key={c} onClick={() => sortBy(c)} className="sortable">
                  {getField(table, c)?.label ?? c}
                  {sortField === c && <span className="sn-sort">{sortDesc ? '▼' : '▲'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={cols.length + 2} className="sn-empty">
                  No records to display
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.sys_id} className={selected.has(r.sys_id) ? 'selected' : ''}>
                <td className="chk">
                  <input
                    type="checkbox"
                    checked={selected.has(r.sys_id)}
                    onChange={() => {
                      const s = new Set(selected)
                      if (s.has(r.sys_id)) s.delete(r.sys_id)
                      else s.add(r.sys_id)
                      setSelected(s)
                    }}
                    aria-label={`Select ${displayValue(table, r, def.displayField)}`}
                  />
                </td>
                <td className="chk">
                  <Link to={recordUrl(table, r.sys_id)} className="sn-preview" title="Open record">
                    <Icon name="info" size={14} />
                  </Link>
                </td>
                {cols.map((c, i) => (
                  <td
                    key={c}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setCtxMenu({ x: e.clientX, y: e.clientY, field: c, rec: r })
                    }}
                  >
                    {i === 0 ? (
                      <Link className="sn-link" to={recordUrl(table, r.sys_id)}>
                        {displayValue(table, r, c) || '(empty)'}
                      </Link>
                    ) : (
                      <Cell table={table} field={c} rec={r} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="sn-loading">Loading…</div>}
      </div>

      {ctxMenu && (
        <div className="sn-context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            onClick={() => {
              const v = ctxMenu.rec[ctxMenu.field]
              go([...conditions, v == null || v === '' ? { field: ctxMenu.field, op: 'ISEMPTY', value: '' } : { field: ctxMenu.field, op: '=', value: String(v) }])
            }}
          >
            Show Matching
          </button>
          <button
            onClick={() => {
              const v = ctxMenu.rec[ctxMenu.field]
              go([...conditions, v == null || v === '' ? { field: ctxMenu.field, op: 'ISNOTEMPTY', value: '' } : { field: ctxMenu.field, op: '!=', value: String(v) }])
            }}
          >
            Filter Out
          </button>
          <button onClick={() => navigator.clipboard?.writeText(displayValue(table, ctxMenu.rec, ctxMenu.field))}>Copy</button>
        </div>
      )}
    </div>
  )
}
