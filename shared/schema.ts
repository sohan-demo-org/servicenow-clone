export type FieldType =
  | 'string'
  | 'text'
  | 'choice'
  | 'reference'
  | 'datetime'
  | 'integer'
  | 'boolean'
  | 'currency'

export interface Choice {
  value: string
  label: string
}

export interface FieldDef {
  name: string
  label: string
  type: FieldType
  choices?: Choice[]
  ref?: string
  readOnly?: boolean
  mandatory?: boolean
  refQuery?: string
}

export interface FormSection {
  title?: string
  left: string[]
  right: string[]
  full?: string[]
}

export interface RelatedList {
  table: string
  field: string
  label: string
}

export interface TableDef {
  name: string
  label: string
  plural: string
  prefix?: string
  displayField: string
  fields: FieldDef[]
  listFields: string[]
  form: FormSection[]
  tabs?: FormSection[]
  related?: RelatedList[]
  journal?: boolean
  defaultSort?: string
}

const c = (...pairs: [string, string][]): Choice[] => pairs.map(([value, label]) => ({ value, label }))

export const IMPACT = c(['1', '1 - High'], ['2', '2 - Medium'], ['3', '3 - Low'])
export const URGENCY = IMPACT
export const PRIORITY = c(
  ['1', '1 - Critical'],
  ['2', '2 - High'],
  ['3', '3 - Moderate'],
  ['4', '4 - Low'],
  ['5', '5 - Planning'],
)

export const INCIDENT_STATE = c(
  ['1', 'New'],
  ['2', 'In Progress'],
  ['3', 'On Hold'],
  ['6', 'Resolved'],
  ['7', 'Closed'],
  ['8', 'Canceled'],
)

export const PROBLEM_STATE = c(
  ['101', 'New'],
  ['102', 'Assess'],
  ['103', 'Root Cause Analysis'],
  ['104', 'Fix in Progress'],
  ['106', 'Resolved'],
  ['107', 'Closed'],
)

export const CHANGE_STATE = c(
  ['-5', 'New'],
  ['-4', 'Assess'],
  ['-3', 'Authorize'],
  ['-2', 'Scheduled'],
  ['-1', 'Implement'],
  ['0', 'Review'],
  ['3', 'Closed'],
  ['4', 'Canceled'],
)

export const APPROVAL = c(
  ['not requested', 'Not Yet Requested'],
  ['requested', 'Requested'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
)

export const INCIDENT_CATEGORY = c(
  ['inquiry', 'Inquiry / Help'],
  ['software', 'Software'],
  ['hardware', 'Hardware'],
  ['network', 'Network'],
  ['database', 'Database'],
  ['security', 'Security'],
)

export const SUBCATEGORY: Record<string, Choice[]> = {
  inquiry: c(['antivirus', 'Antivirus'], ['email', 'Email'], ['internal application', 'Internal Application']),
  software: c(['email', 'Email'], ['os', 'Operating System'], ['vpn client', 'VPN Client'], ['erp', 'ERP']),
  hardware: c(['cpu', 'CPU'], ['disk', 'Disk'], ['keyboard', 'Keyboard'], ['memory', 'Memory'], ['monitor', 'Monitor'], ['mouse', 'Mouse']),
  network: c(['dhcp', 'DHCP'], ['dns', 'DNS'], ['ip address', 'IP Address'], ['vpn', 'VPN'], ['wireless', 'Wireless']),
  database: c(['db2', 'DB2'], ['oracle', 'Oracle'], ['postgres', 'PostgreSQL'], ['sql server', 'MS SQL Server']),
  security: c(['phishing', 'Phishing'], ['malware', 'Malware'], ['access', 'Access Violation']),
}

const ALL_SUBCATEGORIES: Choice[] = Object.values(SUBCATEGORY)
  .flat()
  .filter((ch, i, arr) => arr.findIndex((o) => o.value === ch.value) === i)

export const RITM_STAGE = c(
  ['waiting_for_approval', 'Waiting for Approval'],
  ['request_approved', 'Request Approved'],
  ['fulfillment', 'Fulfillment'],
  ['delivery', 'Delivery'],
  ['complete', 'Completed'],
)

export const RITM_STATE = c(['1', 'Open'], ['2', 'Work in Progress'], ['3', 'Closed Complete'], ['4', 'Closed Incomplete'])

export const PRIORITY_MATRIX: Record<string, string> = {
  '1-1': '1',
  '1-2': '2',
  '1-3': '3',
  '2-1': '2',
  '2-2': '3',
  '2-3': '4',
  '3-1': '3',
  '3-2': '4',
  '3-3': '5',
}

export function calcPriority(impact?: string | null, urgency?: string | null): string {
  return PRIORITY_MATRIX[`${impact ?? '3'}-${urgency ?? '3'}`] ?? '5'
}

/** SLA resolution targets in hours, keyed by priority. */
export const SLA_HOURS: Record<string, number> = { '1': 4, '2': 8, '3': 24, '4': 72, '5': 120 }

const sysFields: FieldDef[] = [
  { name: 'sys_created_on', label: 'Created', type: 'datetime', readOnly: true },
  { name: 'sys_created_by', label: 'Created by', type: 'string', readOnly: true },
  { name: 'sys_updated_on', label: 'Updated', type: 'datetime', readOnly: true },
  { name: 'sys_updated_by', label: 'Updated by', type: 'string', readOnly: true },
]

export const TABLES: Record<string, TableDef> = {
  incident: {
    name: 'incident',
    label: 'Incident',
    plural: 'Incidents',
    prefix: 'INC',
    displayField: 'number',
    journal: true,
    defaultSort: 'ORDERBYDESCsys_created_on',
    fields: [
      { name: 'number', label: 'Number', type: 'string', readOnly: true },
      { name: 'caller_id', label: 'Caller', type: 'reference', ref: 'sys_user', mandatory: true },
      { name: 'category', label: 'Category', type: 'choice', choices: INCIDENT_CATEGORY },
      { name: 'subcategory', label: 'Subcategory', type: 'choice', choices: ALL_SUBCATEGORIES },
      { name: 'cmdb_ci', label: 'Configuration item', type: 'reference', ref: 'cmdb_ci' },
      { name: 'contact_type', label: 'Channel', type: 'choice', choices: c(['email', 'Email'], ['phone', 'Phone'], ['self-service', 'Self-service'], ['walk-in', 'Walk-in'], ['chat', 'Chat']) },
      { name: 'state', label: 'State', type: 'choice', choices: INCIDENT_STATE },
      { name: 'impact', label: 'Impact', type: 'choice', choices: IMPACT },
      { name: 'urgency', label: 'Urgency', type: 'choice', choices: URGENCY },
      { name: 'priority', label: 'Priority', type: 'choice', choices: PRIORITY, readOnly: true },
      { name: 'assignment_group', label: 'Assignment group', type: 'reference', ref: 'sys_user_group' },
      { name: 'assigned_to', label: 'Assigned to', type: 'reference', ref: 'sys_user', refQuery: 'roleINitil,admin' },
      { name: 'short_description', label: 'Short description', type: 'string', mandatory: true },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'problem_id', label: 'Problem', type: 'reference', ref: 'problem' },
      { name: 'rfc', label: 'Change Request', type: 'reference', ref: 'change_request' },
      { name: 'close_code', label: 'Resolution code', type: 'choice', choices: c(['Solved (Permanently)', 'Solved (Permanently)'], ['Solved (Work Around)', 'Solved (Work Around)'], ['Not Solved (Not Reproducible)', 'Not Solved (Not Reproducible)'], ['Closed/Resolved by Caller', 'Closed/Resolved by Caller']) },
      { name: 'close_notes', label: 'Resolution notes', type: 'text' },
      { name: 'opened_at', label: 'Opened', type: 'datetime', readOnly: true },
      { name: 'resolved_at', label: 'Resolved', type: 'datetime', readOnly: true },
      ...sysFields,
    ],
    listFields: ['number', 'opened_at', 'short_description', 'caller_id', 'priority', 'state', 'category', 'assignment_group', 'assigned_to', 'sys_updated_on'],
    form: [
      {
        left: ['number', 'caller_id', 'category', 'subcategory', 'cmdb_ci', 'contact_type'],
        right: ['state', 'impact', 'urgency', 'priority', 'assignment_group', 'assigned_to'],
        full: ['short_description', 'description'],
      },
    ],
    tabs: [
      { title: 'Related Records', left: ['problem_id'], right: ['rfc'] },
      { title: 'Resolution Information', left: ['close_code', 'resolved_at'], right: ['opened_at'], full: ['close_notes'] },
    ],
  },
  problem: {
    name: 'problem',
    label: 'Problem',
    plural: 'Problems',
    prefix: 'PRB',
    displayField: 'number',
    journal: true,
    defaultSort: 'ORDERBYDESCsys_created_on',
    fields: [
      { name: 'number', label: 'Number', type: 'string', readOnly: true },
      { name: 'category', label: 'Category', type: 'choice', choices: INCIDENT_CATEGORY },
      { name: 'cmdb_ci', label: 'Configuration item', type: 'reference', ref: 'cmdb_ci' },
      { name: 'state', label: 'State', type: 'choice', choices: PROBLEM_STATE },
      { name: 'impact', label: 'Impact', type: 'choice', choices: IMPACT },
      { name: 'urgency', label: 'Urgency', type: 'choice', choices: URGENCY },
      { name: 'priority', label: 'Priority', type: 'choice', choices: PRIORITY, readOnly: true },
      { name: 'assignment_group', label: 'Assignment group', type: 'reference', ref: 'sys_user_group' },
      { name: 'assigned_to', label: 'Assigned to', type: 'reference', ref: 'sys_user', refQuery: 'roleINitil,admin' },
      { name: 'known_error', label: 'Known error', type: 'boolean' },
      { name: 'short_description', label: 'Problem statement', type: 'string', mandatory: true },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'cause_notes', label: 'Cause notes', type: 'text' },
      { name: 'fix_notes', label: 'Fix notes', type: 'text' },
      { name: 'workaround', label: 'Workaround', type: 'text' },
      ...sysFields,
    ],
    listFields: ['number', 'short_description', 'priority', 'state', 'category', 'known_error', 'assignment_group', 'assigned_to', 'sys_updated_on'],
    form: [
      {
        left: ['number', 'category', 'cmdb_ci', 'known_error'],
        right: ['state', 'impact', 'urgency', 'priority', 'assignment_group', 'assigned_to'],
        full: ['short_description', 'description'],
      },
    ],
    tabs: [{ title: 'Analysis Information', left: [], right: [], full: ['workaround', 'cause_notes', 'fix_notes'] }],
    related: [{ table: 'incident', field: 'problem_id', label: 'Incidents' }],
  },
  change_request: {
    name: 'change_request',
    label: 'Change Request',
    plural: 'Change Requests',
    prefix: 'CHG',
    displayField: 'number',
    journal: true,
    defaultSort: 'ORDERBYDESCsys_created_on',
    fields: [
      { name: 'number', label: 'Number', type: 'string', readOnly: true },
      { name: 'requested_by', label: 'Requested by', type: 'reference', ref: 'sys_user', mandatory: true },
      { name: 'category', label: 'Category', type: 'choice', choices: c(['hardware', 'Hardware'], ['software', 'Software'], ['network', 'Network'], ['database', 'Database'], ['other', 'Other']) },
      { name: 'cmdb_ci', label: 'Configuration item', type: 'reference', ref: 'cmdb_ci' },
      { name: 'type', label: 'Type', type: 'choice', choices: c(['normal', 'Normal'], ['standard', 'Standard'], ['emergency', 'Emergency']) },
      { name: 'state', label: 'State', type: 'choice', choices: CHANGE_STATE },
      { name: 'risk', label: 'Risk', type: 'choice', choices: c(['1', 'Very High'], ['2', 'High'], ['3', 'Moderate'], ['4', 'Low']) },
      { name: 'impact', label: 'Impact', type: 'choice', choices: IMPACT },
      { name: 'approval', label: 'Approval', type: 'choice', choices: APPROVAL, readOnly: true },
      { name: 'assignment_group', label: 'Assignment group', type: 'reference', ref: 'sys_user_group' },
      { name: 'assigned_to', label: 'Assigned to', type: 'reference', ref: 'sys_user', refQuery: 'roleINitil,admin' },
      { name: 'short_description', label: 'Short description', type: 'string', mandatory: true },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'justification', label: 'Justification', type: 'text' },
      { name: 'implementation_plan', label: 'Implementation plan', type: 'text' },
      { name: 'backout_plan', label: 'Backout plan', type: 'text' },
      { name: 'test_plan', label: 'Test plan', type: 'text' },
      { name: 'start_date', label: 'Planned start date', type: 'datetime' },
      { name: 'end_date', label: 'Planned end date', type: 'datetime' },
      ...sysFields,
    ],
    listFields: ['number', 'short_description', 'type', 'state', 'risk', 'approval', 'assignment_group', 'start_date', 'end_date'],
    form: [
      {
        left: ['number', 'requested_by', 'category', 'cmdb_ci', 'type'],
        right: ['state', 'risk', 'impact', 'approval', 'assignment_group', 'assigned_to'],
        full: ['short_description', 'description'],
      },
    ],
    tabs: [
      { title: 'Planning', left: [], right: [], full: ['justification', 'implementation_plan', 'backout_plan', 'test_plan'] },
      { title: 'Schedule', left: ['start_date'], right: ['end_date'] },
    ],
    related: [{ table: 'incident', field: 'rfc', label: 'Incidents Fixed By Change' }],
  },
  sc_req_item: {
    name: 'sc_req_item',
    label: 'Requested Item',
    plural: 'Requested Items',
    prefix: 'RITM',
    displayField: 'number',
    journal: true,
    defaultSort: 'ORDERBYDESCsys_created_on',
    fields: [
      { name: 'number', label: 'Number', type: 'string', readOnly: true },
      { name: 'cat_item', label: 'Item', type: 'reference', ref: 'sc_cat_item', mandatory: true },
      { name: 'requested_for', label: 'Requested for', type: 'reference', ref: 'sys_user', mandatory: true },
      { name: 'quantity', label: 'Quantity', type: 'integer' },
      { name: 'price', label: 'Price', type: 'currency', readOnly: true },
      { name: 'stage', label: 'Stage', type: 'choice', choices: RITM_STAGE },
      { name: 'state', label: 'State', type: 'choice', choices: RITM_STATE },
      { name: 'approval', label: 'Approval', type: 'choice', choices: APPROVAL },
      { name: 'assignment_group', label: 'Assignment group', type: 'reference', ref: 'sys_user_group' },
      { name: 'assigned_to', label: 'Assigned to', type: 'reference', ref: 'sys_user', refQuery: 'roleINitil,admin' },
      { name: 'short_description', label: 'Short description', type: 'string' },
      { name: 'variables', label: 'Variables', type: 'text', readOnly: true },
      ...sysFields,
    ],
    listFields: ['number', 'cat_item', 'requested_for', 'quantity', 'price', 'stage', 'state', 'approval', 'assignment_group', 'sys_created_on'],
    form: [
      {
        left: ['number', 'cat_item', 'requested_for', 'quantity', 'price'],
        right: ['stage', 'state', 'approval', 'assignment_group', 'assigned_to'],
        full: ['short_description', 'variables'],
      },
    ],
  },
  sc_cat_item: {
    name: 'sc_cat_item',
    label: 'Catalog Item',
    plural: 'Catalog Items',
    displayField: 'name',
    defaultSort: 'ORDERBYname',
    fields: [
      { name: 'name', label: 'Name', type: 'string', mandatory: true },
      { name: 'category', label: 'Category', type: 'choice', choices: c(['hardware', 'Hardware'], ['software', 'Software'], ['access', 'Access'], ['services', 'Services']) },
      { name: 'price', label: 'Price', type: 'currency' },
      { name: 'delivery_time', label: 'Delivery time', type: 'string' },
      { name: 'icon', label: 'Icon', type: 'string' },
      { name: 'active', label: 'Active', type: 'boolean' },
      { name: 'short_description', label: 'Short description', type: 'string' },
      { name: 'description', label: 'Description', type: 'text' },
      { name: 'fulfillment_group', label: 'Fulfillment group', type: 'reference', ref: 'sys_user_group' },
      ...sysFields,
    ],
    listFields: ['name', 'category', 'price', 'delivery_time', 'active', 'fulfillment_group'],
    form: [
      { left: ['name', 'category', 'price', 'icon'], right: ['active', 'delivery_time', 'fulfillment_group'], full: ['short_description', 'description'] },
    ],
    related: [{ table: 'sc_req_item', field: 'cat_item', label: 'Requested Items' }],
  },
  kb_knowledge: {
    name: 'kb_knowledge',
    label: 'Knowledge Article',
    plural: 'Knowledge Articles',
    prefix: 'KB',
    displayField: 'number',
    defaultSort: 'ORDERBYDESCsys_view_count',
    fields: [
      { name: 'number', label: 'Number', type: 'string', readOnly: true },
      { name: 'short_description', label: 'Short description', type: 'string', mandatory: true },
      { name: 'kb_category', label: 'Category', type: 'choice', choices: c(['email', 'Email'], ['network', 'Network & VPN'], ['hardware', 'Hardware'], ['software', 'Software'], ['security', 'Security'], ['hr', 'HR & Policies']) },
      { name: 'workflow_state', label: 'Workflow', type: 'choice', choices: c(['draft', 'Draft'], ['review', 'Review'], ['published', 'Published'], ['retired', 'Retired']) },
      { name: 'author', label: 'Author', type: 'reference', ref: 'sys_user' },
      { name: 'sys_view_count', label: 'View count', type: 'integer', readOnly: true },
      { name: 'rating', label: 'Rating', type: 'integer', readOnly: true },
      { name: 'text', label: 'Article body', type: 'text' },
      ...sysFields,
    ],
    listFields: ['number', 'short_description', 'kb_category', 'workflow_state', 'author', 'sys_view_count', 'rating', 'sys_updated_on'],
    form: [{ left: ['number', 'kb_category', 'author'], right: ['workflow_state', 'sys_view_count', 'rating'], full: ['short_description', 'text'] }],
  },
  cmdb_ci: {
    name: 'cmdb_ci',
    label: 'Configuration Item',
    plural: 'Configuration Items',
    displayField: 'name',
    defaultSort: 'ORDERBYname',
    fields: [
      { name: 'name', label: 'Name', type: 'string', mandatory: true },
      { name: 'sys_class_name', label: 'Class', type: 'choice', choices: c(['cmdb_ci_server', 'Server'], ['cmdb_ci_appl', 'Application'], ['cmdb_ci_database', 'Database'], ['cmdb_ci_netgear', 'Network Gear'], ['cmdb_ci_computer', 'Computer'], ['cmdb_ci_service', 'Business Service']) },
      { name: 'operational_status', label: 'Operational status', type: 'choice', choices: c(['1', 'Operational'], ['2', 'Non-Operational'], ['3', 'Repair in Progress'], ['6', 'Retired']) },
      { name: 'environment', label: 'Environment', type: 'choice', choices: c(['production', 'Production'], ['staging', 'Staging'], ['development', 'Development'], ['test', 'Test']) },
      { name: 'ip_address', label: 'IP Address', type: 'string' },
      { name: 'os', label: 'Operating System', type: 'string' },
      { name: 'location', label: 'Location', type: 'string' },
      { name: 'owned_by', label: 'Owned by', type: 'reference', ref: 'sys_user' },
      { name: 'support_group', label: 'Support group', type: 'reference', ref: 'sys_user_group' },
      { name: 'short_description', label: 'Description', type: 'text' },
      ...sysFields,
    ],
    listFields: ['name', 'sys_class_name', 'operational_status', 'environment', 'ip_address', 'os', 'location', 'support_group'],
    form: [
      { left: ['name', 'sys_class_name', 'operational_status', 'environment', 'location'], right: ['ip_address', 'os', 'owned_by', 'support_group'], full: ['short_description'] },
    ],
    related: [
      { table: 'incident', field: 'cmdb_ci', label: 'Incidents' },
      { table: 'problem', field: 'cmdb_ci', label: 'Problems' },
      { table: 'change_request', field: 'cmdb_ci', label: 'Change Requests' },
    ],
  },
  sys_user: {
    name: 'sys_user',
    label: 'User',
    plural: 'Users',
    displayField: 'name',
    defaultSort: 'ORDERBYname',
    fields: [
      { name: 'user_name', label: 'User ID', type: 'string', mandatory: true },
      { name: 'name', label: 'Name', type: 'string', mandatory: true },
      { name: 'title', label: 'Title', type: 'string' },
      { name: 'department', label: 'Department', type: 'string' },
      { name: 'email', label: 'Email', type: 'string' },
      { name: 'phone', label: 'Business phone', type: 'string' },
      { name: 'location', label: 'Location', type: 'string' },
      { name: 'role', label: 'Role', type: 'choice', choices: c(['admin', 'admin'], ['itil', 'itil'], ['user', 'user (self-service)']) },
      { name: 'active', label: 'Active', type: 'boolean' },
      ...sysFields,
    ],
    listFields: ['user_name', 'name', 'title', 'department', 'email', 'role', 'location', 'active'],
    form: [{ left: ['user_name', 'name', 'title', 'department', 'role'], right: ['email', 'phone', 'location', 'active'] }],
    related: [
      { table: 'incident', field: 'caller_id', label: 'Incidents (Caller)' },
      { table: 'incident', field: 'assigned_to', label: 'Incidents (Assigned)' },
      { table: 'sc_req_item', field: 'requested_for', label: 'Requested Items' },
    ],
  },
  sys_user_group: {
    name: 'sys_user_group',
    label: 'Group',
    plural: 'Groups',
    displayField: 'name',
    defaultSort: 'ORDERBYname',
    fields: [
      { name: 'name', label: 'Name', type: 'string', mandatory: true },
      { name: 'manager', label: 'Manager', type: 'reference', ref: 'sys_user' },
      { name: 'email', label: 'Group email', type: 'string' },
      { name: 'description', label: 'Description', type: 'text' },
      ...sysFields,
    ],
    listFields: ['name', 'manager', 'email', 'description'],
    form: [{ left: ['name', 'manager'], right: ['email'], full: ['description'] }],
    related: [
      { table: 'incident', field: 'assignment_group', label: 'Incidents' },
      { table: 'change_request', field: 'assignment_group', label: 'Change Requests' },
    ],
  },
  sys_notification: {
    name: 'sys_notification',
    label: 'Notification',
    plural: 'Notifications',
    displayField: 'message',
    defaultSort: 'ORDERBYDESCsys_created_on',
    fields: [
      { name: 'recipient', label: 'Recipient', type: 'reference', ref: 'sys_user', mandatory: true },
      { name: 'type', label: 'Type', type: 'choice', choices: c(['assigned', 'Assigned to me'], ['state_change', 'State change'], ['mention', 'Mention'], ['comment', 'Comment']) },
      { name: 'source_table', label: 'Table', type: 'string' },
      { name: 'document_id', label: 'Document', type: 'string' },
      { name: 'document_number', label: 'Number', type: 'string' },
      { name: 'message', label: 'Message', type: 'string' },
      { name: 'actor', label: 'From', type: 'reference', ref: 'sys_user' },
      { name: 'read', label: 'Read', type: 'boolean' },
      ...sysFields,
    ],
    listFields: ['sys_created_on', 'recipient', 'type', 'document_number', 'message', 'actor', 'read'],
    form: [{ left: ['recipient', 'type', 'actor', 'read'], right: ['source_table', 'document_number', 'document_id', 'sys_created_on'], full: ['message'] }],
  },
}

export function getField(table: string, field: string): FieldDef | undefined {
  return TABLES[table]?.fields.find((f) => f.name === field)
}

export function choiceLabel(table: string, field: string, value: string | null | undefined): string {
  if (value == null || value === '') return ''
  const def = getField(table, field)
  return def?.choices?.find((ch) => ch.value === value)?.label ?? value
}
