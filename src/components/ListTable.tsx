import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TABLES, getField } from '../../shared/schema.ts'
import { api } from '../api.ts'
import type { Rec } from '../api.ts'
import { displayValue, recordUrl } from '../util.ts'
import { Icon } from './Icon.tsx'

export function PriorityDot({ value }: { value: string }) {
  return <span className={`sn-pri-dot p${value}`} />
}

export function StateBadge({ table, field, rec }: { table: string; field: string; rec: Rec }) {
  const v = String(rec[field] ?? '')
  return <span className={`sn-state s-${table}-${v}`}>{displayValue(table, rec, field)}</span>
}

export function Cell({ table, field, rec }: { table: string; field: string; rec: Rec }) {
  const def = getField(table, field)
  const text = displayValue(table, rec, field)
  if (!text) return <span className="muted"> </span>
  if (field === 'priority') {
    return (
      <span className="sn-pri">
        <PriorityDot value={String(rec.priority)} /> {text}
      </span>
    )
  }
  if (field === 'state' || field === 'approval' || field === 'stage' || field === 'workflow_state' || field === 'operational_status') {
    return <StateBadge table={table} field={field} rec={rec} />
  }
  if (def?.type === 'reference' && def.ref && rec[field]) {
    return (
      <Link className="sn-link-subtle" to={recordUrl(def.ref, String(rec[field]))} onClick={(e) => e.stopPropagation()}>
        {text}
      </Link>
    )
  }
  if (def?.type === 'boolean') return <span>{text === 'true' ? 'true' : 'false'}</span>
  return <span title={text.length > 60 ? text : undefined}>{text.length > 80 ? `${text.slice(0, 80)}…` : text}</span>
}

interface MiniListProps {
  table: string
  query: string
  newQuery?: string
}

/** Compact embedded list used for related lists on forms. */
export function MiniList({ table, query, newQuery }: MiniListProps) {
  const def = TABLES[table]
  const [rows, setRows] = useState<Rec[] | null>(null)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    let live = true
    api.list(table, { query, limit: 10 }).then((r) => {
      if (!live) return
      setRows(r.result)
      setTotal(r.total)
    })
    return () => {
      live = false
    }
  }, [table, query])
  const cols = def.listFields.slice(0, 7)
  return (
    <div className="sn-related-list">
      <div className="sn-related-bar">
        <Link className="sn-btn" to={recordUrl(table, '-1', newQuery ? `sysparm_query=${encodeURIComponent(newQuery)}` : undefined)}>
          New
        </Link>
        <span className="muted">
          {total} {total === 1 ? 'record' : 'records'}
        </span>
        <Link className="sn-link" to={`/list/${table}?sysparm_query=${encodeURIComponent(query)}`}>
          View all <Icon name="chevronRight" size={12} />
        </Link>
      </div>
      <table className="sn-table compact">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{getField(table, c)?.label ?? c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === null && (
            <tr>
              <td colSpan={cols.length} className="muted">
                Loading…
              </td>
            </tr>
          )}
          {rows?.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="sn-empty">
                No records to display
              </td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={r.sys_id}>
              {cols.map((c, i) => (
                <td key={c}>
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
    </div>
  )
}
