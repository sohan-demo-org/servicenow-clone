import { listUrl, recordUrl } from './util.ts'

export interface NavModule {
  label: string
  to: string
}

export interface NavApp {
  label: string
  modules: NavModule[]
  agentOnly?: boolean
}

const ACTIVE_INC = 'stateNOTIN6,7,8'
const ME = 'javascript:gs.getUserID()'

export const NAV: NavApp[] = [
  {
    label: 'Self-Service',
    modules: [
      { label: 'Service Portal', to: '/sp' },
      { label: 'My Incidents', to: listUrl('incident', `caller_id=${ME}`) },
      { label: 'My Requests', to: listUrl('sc_req_item', `requested_for=${ME}`) },
      { label: 'Knowledge', to: '/sp/kb' },
    ],
  },
  {
    label: 'Dashboards',
    agentOnly: true,
    modules: [{ label: 'ITSM Overview', to: '/' }],
  },
  {
    label: 'Incident',
    agentOnly: true,
    modules: [
      { label: 'Create New', to: recordUrl('incident', '-1') },
      { label: 'Assigned to me', to: listUrl('incident', `assigned_to=${ME}^${ACTIVE_INC}`) },
      { label: 'Open', to: listUrl('incident', ACTIVE_INC) },
      { label: 'Open - Unassigned', to: listUrl('incident', `assigned_toISEMPTY^${ACTIVE_INC}`) },
      { label: 'Resolved', to: listUrl('incident', 'state=6') },
      { label: 'All', to: listUrl('incident') },
    ],
  },
  {
    label: 'Problem',
    agentOnly: true,
    modules: [
      { label: 'Create New', to: recordUrl('problem', '-1') },
      { label: 'Open', to: listUrl('problem', 'stateNOTIN106,107') },
      { label: 'Known Errors', to: listUrl('problem', 'known_error=true') },
      { label: 'All', to: listUrl('problem') },
    ],
  },
  {
    label: 'Change',
    agentOnly: true,
    modules: [
      { label: 'Create New', to: recordUrl('change_request', '-1') },
      { label: 'Open', to: listUrl('change_request', 'stateNOTIN3,4') },
      { label: 'Awaiting Approval', to: listUrl('change_request', 'approval=requested') },
      { label: 'Scheduled', to: listUrl('change_request', 'state=-2^ORDERBYstart_date') },
      { label: 'All', to: listUrl('change_request') },
    ],
  },
  {
    label: 'Service Catalog',
    modules: [
      { label: 'Catalog', to: '/sp/catalog' },
      { label: 'Requested Items', to: listUrl('sc_req_item') },
      { label: 'Maintain Items', to: listUrl('sc_cat_item') },
    ],
  },
  {
    label: 'Knowledge',
    modules: [
      { label: 'Published', to: listUrl('kb_knowledge', 'workflow_state=published') },
      { label: 'Create New', to: recordUrl('kb_knowledge', '-1') },
      { label: 'All', to: listUrl('kb_knowledge') },
    ],
  },
  {
    label: 'Configuration',
    agentOnly: true,
    modules: [
      { label: 'Servers', to: listUrl('cmdb_ci', 'sys_class_name=cmdb_ci_server') },
      { label: 'Applications', to: listUrl('cmdb_ci', 'sys_class_name=cmdb_ci_appl') },
      { label: 'Databases', to: listUrl('cmdb_ci', 'sys_class_name=cmdb_ci_database') },
      { label: 'Network Gear', to: listUrl('cmdb_ci', 'sys_class_name=cmdb_ci_netgear') },
      { label: 'All CIs', to: listUrl('cmdb_ci') },
    ],
  },
  {
    label: 'User Administration',
    agentOnly: true,
    modules: [
      { label: 'Users', to: listUrl('sys_user') },
      { label: 'Groups', to: listUrl('sys_user_group') },
    ],
  },
]
