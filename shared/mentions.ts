/** `@user.name` mentions in journal text, matched against sys_user.user_name. Not preceded by a word char, so emails don't match. */
const MENTION_SRC = '(^|[^\\w.@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)'

export function parseMentions(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(new RegExp(MENTION_SRC, 'gi'))) out.add(m[2].toLowerCase())
  return [...out]
}

export interface TextPart {
  text: string
  mention?: string
}

export function splitMentions(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(MENTION_SRC, 'gi'))) {
    const at = (m.index ?? 0) + m[1].length
    if (at > last) parts.push({ text: text.slice(last, at) })
    parts.push({ text: `@${m[2]}`, mention: m[2].toLowerCase() })
    last = at + m[2].length + 1
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
