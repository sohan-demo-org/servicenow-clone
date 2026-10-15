import { useState } from 'react'
import { TABLES, getField } from '../../shared/schema.ts'
import { OPERATORS } from '../query.ts'
import type { Condition } from '../query.ts'
import { ReferenceInput } from './ReferenceInput.tsx'
import { Icon } from './Icon.tsx'

interface Props {
  table: string
  initial: Condition[]
  refNames: Record<string, string>
  onRun: (conds: Condition[]) => void
  onClose: () => void
}

export function FilterBuilder({ table, initial, refNames, onRun, onClose }: Props) {
  const def = TABLES[table]
  const blank = (): Condition => ({ field: def.listFields[0], op: '=', value: '' })
  const [conds, setConds] = useState<Condition[]>(initial.length ? initial : [blank()])
  const [names, setNames] = useState(refNames)
  const set = (i: number, patch: Partial<Condition>) => setConds(conds.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const fields = def.fields.filter((f) => f.type !== 'text' || f.name === 'description')

  return (
    <div className="sn-filter" data-testid="filter-builder">
      <div className="sn-filter-head">
        <b>Condition builder</b>
        <div className="sn-filter-actions">
          <button className="sn-btn primary" onClick={() => onRun(conds.filter((c) => c.field))} data-testid="filter-run">
            Run
          </button>
          <button className="sn-btn" onClick={() => setConds([blank()])}>
            Clear all
          </button>
          <button className="sn-icon-btn dark" onClick={onClose} aria-label="Close filter">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      {conds.map((c, i) => {
        const f = getField(table, c.field)
        const noValue = OPERATORS.find((o) => o.op === c.op)?.noValue
        return (
          <div className="sn-filter-row" key={i}>
            <span className="sn-filter-join">{i === 0 ? 'All of these conditions must be met' : c.or ? 'or' : 'and'}</span>
            <select className="sn-input" value={c.field} onChange={(e) => set(i, { field: e.target.value, value: '' })} aria-label="Field">
              {fields.map((fd) => (
                <option key={fd.name} value={fd.name}>
                  {fd.label}
                </option>
              ))}
            </select>
            <select className="sn-input" value={c.op} onChange={(e) => set(i, { op: e.target.value })} aria-label="Operator">
              {OPERATORS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {noValue ? (
              <span className="sn-filter-novalue" />
            ) : f?.type === 'choice' && (c.op === '=' || c.op === '!=') ? (
              <select className="sn-input" value={c.value} onChange={(e) => set(i, { value: e.target.value })} aria-label="Value">
                <option value="">-- None --</option>
                {f.choices?.map((ch) => (
                  <option key={ch.value} value={ch.value}>
                    {ch.label}
                  </option>
                ))}
              </select>
            ) : f?.type === 'boolean' ? (
              <select className="sn-input" value={c.value} onChange={(e) => set(i, { value: e.target.value })} aria-label="Value">
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : f?.type === 'reference' && f.ref && (c.op === '=' || c.op === '!=') ? (
              <ReferenceInput
                table={f.ref}
                value={c.value}
                display={names[c.value] ?? (c.value === 'javascript:gs.getUserID()' ? '(me)' : '')}
                onChange={(id, dv) => {
                  setNames({ ...names, [id]: dv })
                  set(i, { value: id })
                }}
              />
            ) : (
              <input className="sn-input" value={c.value} onChange={(e) => set(i, { value: e.target.value })} aria-label="Value" />
            )}
            <button className="sn-btn small" onClick={() => setConds([...conds.slice(0, i + 1), { ...blank(), or: false }, ...conds.slice(i + 1)])}>
              AND
            </button>
            <button className="sn-btn small" onClick={() => setConds([...conds.slice(0, i + 1), { ...blank(), field: c.field, or: true }, ...conds.slice(i + 1)])}>
              OR
            </button>
            <button className="sn-icon-btn dark" onClick={() => setConds(conds.filter((_, j) => j !== i))} aria-label="Remove condition">
              <Icon name="close" size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
