import type { JSX, ReactNode } from 'react'

/**
 * The subset of Discord markdown a Text Display renders: headings, `-#` subtext,
 * quotes, bullet lists, and inline bold/italic/underline/strike/spoiler/code/links.
 * Builds React nodes rather than HTML, so payload text can never inject markup.
 */

const INLINE =
  /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|~~(.+?)~~|\|\|(.+?)\|\||`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push(rest)
      break
    }
    if (m.index > 0) out.push(rest.slice(0, m.index))
    const k = `${key}-${n++}`
    const [, bold, under, ital, ital2, strike, spoiler, code, linkText, linkUrl, bare] = m
    if (bold !== undefined) out.push(<strong key={k}>{inline(bold, k)}</strong>)
    else if (under !== undefined) out.push(<u key={k}>{inline(under, k)}</u>)
    else if (ital !== undefined || ital2 !== undefined) out.push(<em key={k}>{inline(ital ?? ital2 ?? '', k)}</em>)
    else if (strike !== undefined) out.push(<s key={k}>{inline(strike, k)}</s>)
    else if (spoiler !== undefined) out.push(<span key={k} className="dc-spoiler">{inline(spoiler, k)}</span>)
    else if (code !== undefined) out.push(<code key={k}>{code}</code>)
    else if (linkText !== undefined && linkUrl !== undefined) {
      out.push(
        <a key={k} href={linkUrl} target="_blank" rel="noreferrer">
          {inline(linkText, k)}
        </a>,
      )
    } else if (bare !== undefined) {
      out.push(
        <a key={k} href={bare} target="_blank" rel="noreferrer">
          {bare}
        </a>,
      )
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

export function DiscordMarkdown({ text }: { text: string }): JSX.Element {
  const blocks: ReactNode[] = []
  let list: ReactNode[] = []
  const flushList = () => {
    if (list.length) blocks.push(<ul key={`ul-${blocks.length}`}>{list}</ul>)
    list = []
  }

  text.split('\n').forEach((line, i) => {
    const k = `l${i}`
    const bullet = /^\s*[-*] (.*)$/.exec(line)
    if (bullet) {
      list.push(<li key={k}>{inline(bullet[1] ?? '', k)}</li>)
      return
    }
    flushList()
    const heading = /^(#{1,3}) (.*)$/.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 1
      const body = inline(heading[2] ?? '', k)
      blocks.push(
        level === 1 ? <h1 key={k}>{body}</h1> : level === 2 ? <h2 key={k}>{body}</h2> : <h3 key={k}>{body}</h3>,
      )
    } else if (line.startsWith('-# ')) {
      blocks.push(<small key={k}>{inline(line.slice(3), k)}</small>)
    } else if (line.startsWith('> ')) {
      blocks.push(<blockquote key={k}>{inline(line.slice(2), k)}</blockquote>)
    } else if (line.trim() === '') {
      blocks.push(<br key={k} />)
    } else {
      blocks.push(<p key={k}>{inline(line, k)}</p>)
    }
  })
  flushList()
  return <div className="dc-md">{blocks}</div>
}
