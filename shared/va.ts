export type VaAction =
  | { type: 'menu'; greet?: boolean }
  | { type: 'solved' }
  | { type: 'create_incident'; short_description: string; urgency?: string }

export interface VaRequest {
  text?: string
  action?: VaAction
}

export interface VaCard {
  kind: 'kb' | 'item' | 'ticket' | 'created'
  title: string
  subtitle: string
  to: string
  badge?: string
  icon?: string
}

export interface VaMessage {
  text: string
  cards?: VaCard[]
}

/** Quick reply: sends `text` as the user, triggers `action`, or navigates to `link`. */
export interface VaChip {
  label: string
  text?: string
  action?: VaAction
  link?: string
}

export interface VaReply {
  messages: VaMessage[]
  chips: VaChip[]
}
