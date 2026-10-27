import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { TABLES } from '../../shared/schema.ts'
import { ApiError, api } from '../api.ts'
import type { Rec } from '../api.ts'
import { AuthProvider } from '../auth.tsx'
import { FormPage } from './FormPage.tsx'

vi.mock('../api.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../api.ts')>()
  return {
    ...mod,
    api: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      journal: vi.fn(),
      approve: vi.fn(),
      list: vi.fn(),
      addJournal: vi.fn(),
    },
  }
})

const m = vi.mocked(api)

const ITIL: Rec = { sys_id: 'u-itil', name: 'Beth Anglin', user_name: 'beth.anglin', role: 'itil' }
const END_USER: Rec = { sys_id: 'u-end', name: 'Joe Employee', user_name: 'joe', role: 'user' }

type Fields = Record<string, string | number | null>
const asRec = (r: object) => r as unknown as Rec

const incident = (over: Fields = {}): Rec =>
  asRec({
    sys_id: 'inc1',
    number: 'INC0010001',
    state: '2',
    impact: '3',
    urgency: '3',
    priority: '5',
    short_description: 'Email is down',
    caller_id: 'u-end',
    close_code: null,
    close_notes: null,
    problem_id: null,
    _dv: { caller_id: 'Joe Employee' },
    ...over,
  })

const change = (over: Fields = {}): Rec => ({
  sys_id: 'chg1',
  number: 'CHG0030001',
  state: '-3',
  approval: 'requested',
  type: 'normal',
  short_description: 'Patch mail servers',
  requested_by: 'u-itil',
  ...over,
})

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname + loc.search}</div>
}

function renderForm(path: string, user: Rec | null = ITIL) {
  if (user) localStorage.setItem('sn-clone-user', JSON.stringify(user))
  const table = path.split('/')[2]
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/list/${table}`, path]} initialIndex={1}>
        <Routes>
          <Route path="/record/:table/:id" element={<FormPage />} />
          <Route path="*" element={null} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </AuthProvider>,
  )
}

const location = () => screen.getByTestId('location').textContent
const field = (name: string) => document.getElementById(`f-${name}`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
const titlebar = () => document.querySelector('.sn-titlebar-right') as HTMLElement
const buttonLabels = () => within(titlebar()).queryAllByRole('button').map((b) => b.textContent?.trim())
const click = (name: string | RegExp) => userEvent.click(within(titlebar()).getByRole('button', { name }))
const errorText = async () => (await screen.findByTestId('msg-error')).textContent
const successText = async () => (await screen.findByTestId('msg-success')).textContent

async function openRecord(table: string, r: Rec, user: Rec | null = ITIL) {
  m.get.mockImplementation(async (t, id) => (t === table && id === r.sys_id ? r : { sys_id: id, name: `name-${id}` }))
  renderForm(`/record/${table}/${r.sys_id}`, user)
  await screen.findByText(String(r.number), { selector: '.sn-form-title b' })
}

beforeEach(() => {
  localStorage.clear()
  m.journal.mockResolvedValue([])
  m.list.mockResolvedValue({ result: [], total: 0 })
  m.get.mockImplementation(async (_t, id) => ({ sys_id: id, name: `name-${id}`, number: `NUM-${id}` }))
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

describe('FormPage new record', () => {
  it('blocks submit with a mandatory-field error when caller is missing', async () => {
    renderForm('/record/incident/-1')
    await userEvent.type(field('short_description'), 'Printer jammed')
    await click('Submit')

    expect(await errorText()).toBe('The following mandatory fields are not filled in: Caller')
    expect(field('caller_id').closest('.sn-field')?.classList.contains('invalid')).toBe(true)
    expect(m.create).not.toHaveBeenCalled()
    expect(location()).toBe('/record/incident/-1')
  })

  it('creates the incident with defaults plus non-empty fields and navigates to the new record', async () => {
    m.create.mockResolvedValue(incident({ sys_id: 'new1', number: 'INC0010099', state: '1' }))
    renderForm('/record/incident/-1?sysparm_query=caller_id=u-end')
    await waitFor(() => expect(m.get).toHaveBeenCalledWith('sys_user', 'u-end'))
    await userEvent.type(field('short_description'), 'Printer jammed')
    await click('Submit')

    await waitFor(() => expect(location()).toBe('/record/incident/new1'))
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.create).toHaveBeenCalledWith('incident', {
      state: '1',
      impact: '3',
      urgency: '3',
      priority: '5',
      contact_type: 'phone',
      caller_id: 'u-end',
      short_description: 'Printer jammed',
    })
  })

  it('recalculates priority from impact and urgency before submit', async () => {
    m.create.mockResolvedValue(incident({ sys_id: 'new2' }))
    renderForm('/record/incident/-1?sysparm_query=caller_id=u-end^short_description=VPN down')
    await userEvent.selectOptions(field('impact') as HTMLSelectElement, '1')
    await userEvent.selectOptions(field('urgency') as HTMLSelectElement, '1')
    await click('Submit')

    await waitFor(() => expect(m.create).toHaveBeenCalled())
    expect(m.create.mock.calls[0][1]).toMatchObject({ impact: '1', urgency: '1', priority: '1' })
  })

  it('shows the API error and stays on the form when create fails', async () => {
    m.create.mockRejectedValue(new ApiError('Mandatory fields missing', 'Caller is mandatory'))
    renderForm('/record/incident/-1?sysparm_query=caller_id=u-end^short_description=VPN down')
    await click('Submit')

    expect(await errorText()).toBe('Mandatory fields missing: Caller is mandatory')
    expect(location()).toMatch(/^\/record\/incident\/-1\?/)
  })

  const DEFAULTS: Record<string, Record<string, string>> = {
    incident: { state: '1', impact: '3', urgency: '3', priority: '5', contact_type: 'phone' },
    problem: { state: '101', impact: '3', urgency: '3', priority: '5' },
    change_request: { state: '-5', type: 'normal', risk: '3', impact: '3', approval: 'not requested', requested_by: ITIL.sys_id },
    kb_knowledge: { workflow_state: 'draft', author: ITIL.sys_id },
    sc_req_item: { requested_for: ITIL.sys_id, quantity: '1', state: '1' },
    sc_cat_item: { active: 'true' },
    sys_user: { active: 'true' },
  }

  it.each(Object.keys(DEFAULTS))('submits the per-table defaults for a new %s', async (table) => {
    const filled: Record<string, string> = {}
    for (const f of TABLES[table].fields) if (f.mandatory && !f.readOnly && !(f.name in DEFAULTS[table])) filled[f.name] = `v-${f.name}`
    const q = Object.entries(filled)
      .map(([k, v]) => `${k}=${v}`)
      .join('^')
    m.create.mockResolvedValue({ sys_id: 'created', number: 'X0001', name: 'X' })
    renderForm(`/record/${table}/-1${q ? `?sysparm_query=${encodeURIComponent(q)}` : ''}`)
    await click('Submit')

    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1))
    expect(m.create).toHaveBeenCalledWith(table, { ...DEFAULTS[table], ...filled })
    await waitFor(() => expect(location()).toBe(`/record/${table}/created`))
  })

  it('pre-fills the current user name for requested_by on a new change', async () => {
    renderForm('/record/change_request/-1')
    await waitFor(() => expect((field('requested_by') as HTMLInputElement).value).toBe('Beth Anglin'))
  })
})

describe('FormPage update/save', () => {
  it('sends only the edited field on Update and navigates back', async () => {
    m.update.mockResolvedValue(incident({ short_description: 'Email is down for all users' }))
    await openRecord('incident', incident())
    await userEvent.type(field('short_description'), ' for all users')
    expect(screen.getByText('● unsaved changes')).toBeTruthy()
    await click('Update')

    await waitFor(() => expect(location()).toBe('/list/incident'))
    expect(m.update).toHaveBeenCalledTimes(1)
    expect(m.update).toHaveBeenCalledWith('incident', 'inc1', { short_description: 'Email is down for all users' })
  })

  it('sends impact and recomputed priority when impact changes', async () => {
    m.update.mockResolvedValue(incident({ impact: '1', priority: '3' }))
    await openRecord('incident', incident())
    await userEvent.selectOptions(field('impact') as HTMLSelectElement, '1')
    await click('Save')

    await waitFor(() => expect(m.update).toHaveBeenCalled())
    expect(m.update).toHaveBeenCalledWith('incident', 'inc1', { impact: '1', priority: '3' })
  })

  it('does not send a field that was edited back to its original value', async () => {
    m.update.mockResolvedValue(incident())
    await openRecord('incident', incident())
    await userEvent.type(field('short_description'), 'X')
    await userEvent.type(field('short_description'), '{Backspace}')
    await click('Update')

    await waitFor(() => expect(location()).toBe('/list/incident'))
    expect(m.update).not.toHaveBeenCalled()
  })

  it('navigates back without calling the API when nothing changed', async () => {
    await openRecord('incident', incident())
    await click('Update')

    await waitFor(() => expect(location()).toBe('/list/incident'))
    expect(m.update).not.toHaveBeenCalled()
  })

  it('Save with no changes stays on the form and makes no API call', async () => {
    await openRecord('incident', incident())
    await click('Save')

    expect(location()).toBe('/record/incident/inc1')
    expect(m.update).not.toHaveBeenCalled()
  })

  it('Save stays on the form, reloads the journal and shows a success message', async () => {
    m.update.mockResolvedValue(incident({ short_description: 'Email is down!' }))
    await openRecord('incident', incident())
    const journalCalls = m.journal.mock.calls.length
    await userEvent.type(field('short_description'), '!')
    await click('Save')

    expect(await successText()).toBe('Incident INC0010001 updated')
    expect(location()).toBe('/record/incident/inc1')
    expect(m.journal.mock.calls.length).toBe(journalCalls + 1)
    expect(screen.queryByText('● unsaved changes')).toBeNull()
  })

  it('shows message and detail when update fails and keeps the edit', async () => {
    m.update.mockRejectedValue(new ApiError('Operation failed', 'Record is locked'))
    await openRecord('incident', incident())
    await userEvent.type(field('short_description'), '!')
    await click('Save')

    expect(await errorText()).toBe('Operation failed: Record is locked')
    expect(field('short_description').value).toBe('Email is down!')
    expect(screen.getByText('● unsaved changes')).toBeTruthy()
  })

  it('blocks update when a mandatory field is cleared', async () => {
    await openRecord('incident', incident())
    await userEvent.clear(field('short_description'))
    await click('Update')

    expect(await errorText()).toBe('The following mandatory fields are not filled in: Short description')
    expect(m.update).not.toHaveBeenCalled()
  })
})

describe('FormPage resolve', () => {
  it('requires resolution code and notes before calling the API', async () => {
    await openRecord('incident', incident())
    await click('Resolve')

    expect(await errorText()).toBe('The following mandatory fields are not filled in: Resolution code, Resolution notes')
    expect(m.update).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Resolution Information' }).getAttribute('aria-selected')).toBe('true')
    expect(field('close_code').closest('.sn-field')?.classList.contains('invalid')).toBe(true)
    expect(field('close_notes').closest('.sn-field')?.classList.contains('invalid')).toBe(true)
  })

  it('sends state 6 with the resolution fields and shows the resolved message', async () => {
    m.update.mockResolvedValue(incident({ state: '6', close_code: 'Solved (Permanently)', close_notes: 'Restarted MTA' }))
    await openRecord('incident', incident())
    await userEvent.click(screen.getByRole('tab', { name: 'Resolution Information' }))
    await userEvent.selectOptions(field('close_code') as HTMLSelectElement, 'Solved (Permanently)')
    await userEvent.type(field('close_notes'), 'Restarted MTA')
    await click('Resolve')

    expect(await successText()).toBe('Incident INC0010001 resolved')
    expect(m.update).toHaveBeenCalledTimes(1)
    expect(m.update).toHaveBeenCalledWith('incident', 'inc1', { close_code: 'Solved (Permanently)', close_notes: 'Restarted MTA', state: '6' })
    expect(buttonLabels()).toContain('Reopen Incident')
    expect(buttonLabels()).not.toContain('Resolve')
  })
})

describe('FormPage create problem', () => {
  it('creates a problem from the incident, links it, then navigates to it', async () => {
    const inc = incident({ description: 'Long text', category: 'software', cmdb_ci: 'ci1', impact: '2', urgency: '1', assignment_group: 'g1' })
    m.create.mockResolvedValue({ sys_id: 'prb1', number: 'PRB0040001' })
    m.update.mockResolvedValue(asRec({ ...inc, problem_id: 'prb1' }))
    await openRecord('incident', inc)
    await click('Create Problem')

    await waitFor(() => expect(location()).toBe('/record/problem/prb1'))
    expect(m.create).toHaveBeenCalledWith('problem', {
      short_description: 'Email is down',
      description: 'Long text',
      category: 'software',
      cmdb_ci: 'ci1',
      impact: '2',
      urgency: '1',
      assignment_group: 'g1',
    })
    expect(m.update).toHaveBeenCalledWith('incident', 'inc1', { problem_id: 'prb1', work_notes: 'Problem PRB0040001 created from this incident.' })
    expect(m.create.mock.invocationCallOrder[0]).toBeLessThan(m.update.mock.invocationCallOrder[0])
  })

  it('reports the orphaned problem when linking the incident fails', async () => {
    m.create.mockResolvedValue({ sys_id: 'prb1', number: 'PRB0040001' })
    m.update.mockRejectedValue(new ApiError('Operation failed', 'Server error'))
    await openRecord('incident', incident())
    await click('Create Problem')

    expect(await errorText()).toBe('Problem PRB0040001 was created but could not be linked to this incident: Operation failed: Server error')
    expect(location()).toBe('/record/incident/inc1')
  })

  it('shows the error and skips linking when problem creation fails', async () => {
    m.create.mockRejectedValue(new ApiError('Mandatory fields missing', 'Problem statement is mandatory'))
    await openRecord('incident', incident())
    await click('Create Problem')

    expect(await errorText()).toBe('Mandatory fields missing: Problem statement is mandatory')
    expect(m.update).not.toHaveBeenCalled()
    expect(location()).toBe('/record/incident/inc1')
  })
})

describe('FormPage approve/reject', () => {
  it.each([
    ['Approve', 'approved'],
    ['Reject', 'rejected'],
  ] as const)('%s calls the approval API and shows the decision', async (label, decision) => {
    m.approve.mockResolvedValue(change({ approval: decision, state: decision === 'approved' ? '-2' : '-5' }))
    await openRecord('change_request', change())
    await click(label)

    expect(await successText()).toBe(`Change Request CHG0030001 ${decision}`)
    expect(m.approve).toHaveBeenCalledWith('change_request', 'chg1', decision)
    expect(buttonLabels()).not.toContain('Approve')
  })

  it('shows an error message when approval fails', async () => {
    m.approve.mockRejectedValue(new ApiError('Not allowed', 'Record is not awaiting approval'))
    await openRecord('change_request', change())
    await click('Approve')

    expect(await errorText()).toBe('Not allowed: Record is not awaiting approval')
    expect(screen.queryByTestId('msg-success')).toBeNull()
    expect(buttonLabels()).toContain('Approve')
  })
})

describe('FormPage delete', () => {
  it('deletes after confirmation and navigates to the list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    m.remove.mockResolvedValue(undefined)
    await openRecord('incident', incident())
    await click('Delete')

    await waitFor(() => expect(location()).toBe('/list/incident'))
    expect(confirm).toHaveBeenCalledWith('Delete this Incident?')
    expect(m.remove).toHaveBeenCalledWith('incident', 'inc1')
  })

  it('does nothing when confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openRecord('incident', incident())
    await click('Delete')

    expect(m.remove).not.toHaveBeenCalled()
    expect(location()).toBe('/record/incident/inc1')
  })

  it('shows an error message and stays when delete fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    m.remove.mockRejectedValue(new ApiError('Forbidden', 'Record is referenced'))
    await openRecord('incident', incident())
    await click('Delete')

    expect(await errorText()).toBe('Forbidden: Record is referenced')
    expect(location()).toBe('/record/incident/inc1')
  })
})

describe('FormPage action buttons', () => {
  it('open incident: agent sees Resolve, Create Problem and Delete', async () => {
    await openRecord('incident', incident())
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Resolve', 'Create Problem', 'Delete'])
  })

  it('incident already linked to a problem hides Create Problem', async () => {
    await openRecord('incident', incident({ problem_id: 'prb9' }))
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Resolve', 'Delete'])
  })

  it('resolved incident shows Reopen, which sends state 2', async () => {
    m.update.mockResolvedValue(incident({ state: '2' }))
    await openRecord('incident', incident({ state: '6', close_code: 'Solved (Permanently)', close_notes: 'done' }))
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Reopen Incident', 'Delete'])
    await click('Reopen Incident')

    expect(await successText()).toBe('Incident reopened')
    expect(m.update).toHaveBeenCalledWith('incident', 'inc1', { state: '2' })
  })

  it.each(['7', '8'])('incident in state %s shows neither Resolve nor Reopen', async (state) => {
    await openRecord('incident', incident({ state }))
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Delete'])
  })

  it('non-agent sees only Update and Save on an incident', async () => {
    await openRecord('incident', incident(), END_USER)
    expect(buttonLabels()).toEqual(['Update', 'Save'])
  })

  it('requested change: itil sees Approve/Reject, end user does not', async () => {
    await openRecord('change_request', change())
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Approve', 'Reject', 'Delete'])
    cleanup()
    localStorage.clear()
    await openRecord('change_request', change(), END_USER)
    expect(buttonLabels()).toEqual(['Update', 'Save'])
  })

  it('requested item awaiting approval shows Approve/Reject for agents', async () => {
    await openRecord('sc_req_item', { sys_id: 'ritm1', number: 'RITM0010001', approval: 'requested', state: '1', cat_item: 'c1', requested_for: 'u-end' })
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Approve', 'Reject', 'Delete'])
  })

  it.each([
    ['-5', 'not requested', 'Request Approval', '-3', 'Approval requested from the Change Advisory Board'],
    ['-4', 'not requested', 'Request Approval', '-3', 'Approval requested from the Change Advisory Board'],
    ['-2', 'approved', 'Implement', '-1', 'Change Request CHG0030001 updated'],
    ['-1', 'approved', 'Review', '0', 'Change Request CHG0030001 updated'],
    ['0', 'approved', 'Close', '3', 'Change Request CHG0030001 updated'],
  ])('change in state %s (%s) shows %s and moves to state %s', async (state, approval, label, nextState, msg) => {
    m.update.mockResolvedValue(change({ state: nextState, approval }))
    await openRecord('change_request', change({ state, approval }))
    expect(buttonLabels()).toEqual(['Update', 'Save', label, 'Delete'])
    await click(label)

    expect(await successText()).toBe(msg)
    expect(m.update).toHaveBeenCalledWith('change_request', 'chg1', { state: nextState })
  })

  it('approved change in assess does not offer Request Approval', async () => {
    await openRecord('change_request', change({ state: '-4', approval: 'approved' }))
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Delete'])
  })

  it('draft article shows Publish, which sets workflow_state published', async () => {
    const kb = { sys_id: 'kb1', number: 'KB0010001', workflow_state: 'draft', short_description: 'How to VPN', author: 'u-itil' }
    m.update.mockResolvedValue({ ...kb, workflow_state: 'published' })
    await openRecord('kb_knowledge', kb)
    expect(buttonLabels()).toEqual(['Update', 'Save', 'Publish', 'Delete'])
    expect(within(titlebar()).getByRole('link', { name: 'View Article' }).getAttribute('href')).toBe('/sp/kb/kb1')
    await click('Publish')

    expect(await successText()).toBe('Article published')
    expect(m.update).toHaveBeenCalledWith('kb_knowledge', 'kb1', { workflow_state: 'published' })
    expect(buttonLabels()).not.toContain('Publish')
  })

  it('new record shows only Submit', async () => {
    renderForm('/record/incident/-1')
    expect(buttonLabels()).toEqual(['Submit'])
  })
})
