import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { TABLES } from '../../shared/schema.ts'
import { api } from '../api.ts'
import type { Rec } from '../api.ts'
import { usePageTitle } from '../components/Layout.tsx'
import { Cell } from '../components/ListTable.tsx'
import { displayValue, recordUrl } from '../util.ts'

export function SearchPage() {
  const [sp] = useSearchParams()
  const q = sp.get('q') ?? ''
  const [groups, setGroups] = useState<{ table: string; label: string; total: number; records: Rec[] }[] | null>(null)
  usePageTitle(`Search: ${q}`)
  useEffect(() => {
    setGroups(null)
    api.search(q).then(setGroups)
  }, [q])
  return (
    <div className="sn-page-pad">
      <h1 className="sn-h1">Search results for “{q}”</h1>
      {groups === null && <div className="muted">Searching…</div>}
      {groups?.length === 0 && <div className="sn-empty-state">No results found. Try a different keyword.</div>}
      {groups?.map((g) => {
        const def = TABLES[g.table]
        const cols = def.listFields.slice(1, 5)
        return (
          <section className="sn-search-group" key={g.table}>
            <h2>
              {g.label} <span className="muted">({g.total})</span>
            </h2>
            <table className="sn-table compact">
              <tbody>
                {g.records.map((r) => (
                  <tr key={r.sys_id}>
                    <td>
                      <Link className="sn-link" to={recordUrl(g.table, r.sys_id)}>
                        {displayValue(g.table, r, def.displayField)}
                      </Link>
                    </td>
                    {cols.map((c) => (
                      <td key={c}>
                        <Cell table={g.table} field={c} rec={r} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )
      })}
    </div>
  )
}
