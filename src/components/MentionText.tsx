import { splitMentions } from '../../shared/mentions.ts'

export function MentionText({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {splitMentions(text).map((p, i) =>
        p.mention ? (
          <span key={i} className="sn-mention" data-testid="mention">
            {p.text}
          </span>
        ) : (
          p.text
        ),
      )}
    </div>
  )
}
