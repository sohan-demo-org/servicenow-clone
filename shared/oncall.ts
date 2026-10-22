export interface OnCallPerson {
  sys_id: string
  name: string
}

export interface OnCallRota {
  sys_id: string
  name: string
  rotation_type: string
  handoff_time: string
  timezone: string
}

export interface OnCallOverride {
  sys_id: string
  member: string
  name: string
  start: string
  end: string
  reason: string
}

export interface OnCallShift {
  start: string
  end: string
  member: string
  name: string
}

export interface OnCallSegment extends OnCallShift {
  override: OnCallOverride | null
}

export interface OnCallNow {
  group: OnCallPerson
  rota: OnCallRota
  primary: OnCallPerson
  secondary: OnCallPerson | null
  manager: OnCallPerson | null
  scheduled: OnCallPerson
  override: OnCallOverride | null
  shift_start: string
  shift_end: string
  escalation: (OnCallPerson & { level: string })[]
}

export interface OnCallSchedule {
  group: OnCallPerson
  rota: OnCallRota
  members: (OnCallPerson & { order: number })[]
  from: string
  to: string
  shifts: OnCallShift[]
  overrides: OnCallOverride[]
  segments: OnCallSegment[]
  current: OnCallNow
}
