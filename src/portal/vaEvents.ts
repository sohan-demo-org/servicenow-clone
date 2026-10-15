export const VA_OPEN_EVENT = 'va:open'

/** Open the Virtual Agent from anywhere in the portal, optionally sending a first message. */
export function openVirtualAgent(text?: string) {
  window.dispatchEvent(new CustomEvent(VA_OPEN_EVENT, { detail: { text } }))
}

export const VA_TICKET_CREATED_EVENT = 'va:ticket-created'
