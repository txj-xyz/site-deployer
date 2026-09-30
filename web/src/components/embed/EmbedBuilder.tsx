import { useState } from 'react'
import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from 'react'
import {
  CHILD_LABELS,
  EMBED_MAX_BYTES,
  EMBED_MAX_COMPONENTS,
  EMBED_MAX_GALLERY_ITEMS,
  MAX_ROW_BUTTONS,
  MAX_SECTION_TEXTS,
  colorToHex,
  countEmbed,
  embedBytes,
  embedProblems,
  hexToColor,
  isVideo,
  newButton,
  newChild,
  type ChildType,
  type DiscordEmbedPayload,
  type EmbedButton,
  type EmbedChild,
  type GalleryItem,
  type Thumbnail,
} from '../../embed'
import { DiscordMarkdown } from './DiscordMarkdown'

interface Props {
  value: DiscordEmbedPayload
  onChange: (value: DiscordEmbedPayload) => void
  /** Default URL for new buttons. */
  siteUrl: string
}

const ADDABLE: ChildType[] = [10, 9, 1, 12, 11, 14]

/** Sets an optional string key, removing it when blank so no empty field is sent. */
function withOpt<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | '' | undefined): T {
  const next = { ...obj }
  if (value === '' || value === undefined || value === false) delete next[key]
  else next[key] = value as T[K]
  return next
}

/**
 * WYSIWYG editor for a Discord component embed. The left side is a preview styled
 * like Discord: click a block to select it, and text blocks become editable in
 * place. The right side inspects the selection, or the container when nothing is.
 */
export function EmbedBuilder({ value, onChange, siteUrl }: Props): JSX.Element {
  const [selected, setSelected] = useState<number | null>(null)
  const blocks = value.component.components
  const problems = embedProblems(value)
  const { components, galleryItems } = countEmbed(value)
  const bytes = embedBytes(value)

  const setContainer = (patch: Partial<DiscordEmbedPayload['component']>) =>
    onChange({ component: { ...value.component, ...patch } })
  const setBlocks = (next: EmbedChild[]) => setContainer({ components: next })
  const updateBlock = (i: number, c: EmbedChild) => setBlocks(blocks.map((b, j) => (j === i ? c : b)))

  const move = (i: number, delta: number) => {
    const j = i + delta
    if (j < 0 || j >= blocks.length) return
    const next = [...blocks]
    const [b] = next.splice(i, 1)
    if (b) next.splice(j, 0, b)
    setBlocks(next)
    setSelected(j)
  }
  const remove = (i: number) => {
    setBlocks(blocks.filter((_, j) => j !== i))
    setSelected(null)
  }
  const duplicate = (i: number) => {
    const b = blocks[i]
    if (!b) return
    const next = [...blocks]
    next.splice(i + 1, 0, structuredClone(b))
    setBlocks(next)
    setSelected(i + 1)
  }
  const insert = (type: ChildType) => {
    const at = selected === null ? blocks.length : selected + 1
    const next = [...blocks]
    next.splice(at, 0, newChild(type, siteUrl))
    setBlocks(next)
    setSelected(at)
  }

  const accent = value.component.accent_color
  const selectedBlock = selected === null ? undefined : blocks[selected]
  const globalProblems = problems.get(-1) ?? []

  return (
    <div className="eb">
      <div className="eb-stage">
        <div className="eb-meters">
          <Meter label="components" used={components} max={EMBED_MAX_COMPONENTS} />
          <Meter label="gallery" used={galleryItems} max={EMBED_MAX_GALLERY_ITEMS} />
          <Meter label="bytes" used={bytes} max={EMBED_MAX_BYTES} />
        </div>

        <div className="dc-msg" onClick={() => setSelected(null)}>
          <div
            className={`dc-container ${selected === null ? 'is-selected' : ''}`}
            style={{ '--dc-accent': accent == null ? 'transparent' : colorToHex(accent) } as CSSProperties}
          >
            {value.component.spoiler && <span className="dc-tag">spoiler</span>}
            {blocks.length === 0 && <div className="dc-empty">Empty embed. Add a block below.</div>}
            {blocks.map((b, i) => (
              <BlockFrame
                key={i}
                label={CHILD_LABELS[b.type]}
                selected={selected === i}
                invalid={problems.has(i)}
                first={i === 0}
                last={i === blocks.length - 1}
                onSelect={() => setSelected(i)}
                onMove={(d) => move(i, d)}
                onDuplicate={() => duplicate(i)}
                onRemove={() => remove(i)}
              >
                <BlockPreview block={b} editing={selected === i} onChange={(c) => updateBlock(i, c)} />
              </BlockFrame>
            ))}
          </div>
        </div>

        <div className="eb-add">
          <span className="dim">Add{selected !== null ? ' below selection' : ''}:</span>
          {ADDABLE.map((t) => (
            <button key={t} type="button" className="ghost" onClick={() => insert(t)}>
              + {CHILD_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="eb-inspector">
        {selected === null || !selectedBlock ? (
          <>
            <h4>Container</h4>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={accent != null}
                onChange={(e) => setContainer({ accent_color: e.target.checked ? 0x5865f2 : null })}
              />
              Accent colour
            </label>
            {accent != null && (
              <input
                type="color"
                aria-label="Accent colour"
                value={colorToHex(accent)}
                onChange={(e) => setContainer({ accent_color: hexToColor(e.target.value) })}
              />
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={Boolean(value.component.spoiler)}
                onChange={(e) => setContainer(withOpt(value.component, 'spoiler', e.target.checked))}
              />
              Hide the whole embed behind a spoiler
            </label>
            <span className="hint">Click a block in the preview to edit it.</span>
          </>
        ) : (
          <>
            <h4>{CHILD_LABELS[selectedBlock.type]}</h4>
            <BlockInspector
              block={selectedBlock}
              siteUrl={siteUrl}
              galleryRoom={EMBED_MAX_GALLERY_ITEMS - galleryItems}
              onChange={(c) => updateBlock(selected, c)}
            />
            {(problems.get(selected) ?? []).map((p) => (
              <div key={p} className="eb-problem">
                {p}
              </div>
            ))}
          </>
        )}
        {globalProblems.map((p) => (
          <div key={p} className="eb-problem">
            {p}
          </div>
        ))}
      </div>
    </div>
  )
}

function Meter({ label, used, max }: { label: string; used: number; max: number }): JSX.Element {
  const state = used > max ? 'over' : used > max * 0.85 ? 'near' : ''
  return (
    <span className={`eb-meter ${state}`}>
      {used.toLocaleString()}/{max.toLocaleString()} {label}
    </span>
  )
}

function BlockFrame(props: {
  label: string
  selected: boolean
  invalid: boolean
  first: boolean
  last: boolean
  onSelect: () => void
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
  children: ReactNode
}): JSX.Element {
  const stop = (f: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    f()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      props.onSelect()
    }
  }
  return (
    <div
      className={`eb-block ${props.selected ? 'is-selected' : ''} ${props.invalid ? 'is-invalid' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${props.label} block`}
      aria-pressed={props.selected}
      onClick={stop(props.onSelect)}
      onKeyDown={onKey}
    >
      <div className="eb-toolbar">
        <span>{props.label}</span>
        <button type="button" title="Move up" disabled={props.first} onClick={stop(() => props.onMove(-1))}>
          ↑
        </button>
        <button type="button" title="Move down" disabled={props.last} onClick={stop(() => props.onMove(1))}>
          ↓
        </button>
        <button type="button" title="Duplicate" onClick={stop(props.onDuplicate)}>
          ⧉
        </button>
        <button type="button" title="Delete" className="danger" onClick={stop(props.onRemove)}>
          ✕
        </button>
      </div>
      {props.children}
    </div>
  )
}

/** A text display: rendered markdown, or a textarea in place while its block is selected. */
function InlineText({ content, editing, onChange }: { content: string; editing: boolean; onChange: (s: string) => void }) {
  if (!editing) {
    return content.trim() ? <DiscordMarkdown text={content} /> : <div className="dc-placeholder">Empty text</div>
  }
  return (
    <textarea
      className="eb-inline-text"
      aria-label="Text (Discord markdown)"
      value={content}
      rows={Math.max(2, content.split('\n').length)}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      autoFocus
    />
  )
}

function Media({ url, spoiler, className }: { url: string; spoiler?: boolean; className?: string }): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const cls = `dc-media ${spoiler ? 'dc-blur' : ''} ${className ?? ''}`
  if (!url || failedUrl === url) {
    return <div className={`${cls} dc-media-empty`}>{url ? 'cannot load' : 'no image'}</div>
  }
  return isVideo(url) ? (
    <video className={cls} src={url} muted onError={() => setFailedUrl(url)} />
  ) : (
    <img className={cls} src={url} alt="" onError={() => setFailedUrl(url)} />
  )
}

function ButtonPreview({ b }: { b: EmbedButton }): JSX.Element {
  return (
    <span className={`dc-btn ${b.disabled ? 'is-disabled' : ''}`}>
      {b.emoji?.name && <span>{b.emoji.name}</span>}
      {b.label && <span>{b.label}</span>}
      <span aria-hidden="true" className="dc-btn-ext">
        ↗
      </span>
    </span>
  )
}

function BlockPreview({
  block,
  editing,
  onChange,
}: {
  block: EmbedChild
  editing: boolean
  onChange: (c: EmbedChild) => void
}): JSX.Element {
  switch (block.type) {
    case 10:
      return <InlineText content={block.content} editing={editing} onChange={(content) => onChange({ ...block, content })} />
    case 9:
      return (
        <div className="dc-section">
          <div className="dc-section-body">
            {block.components.map((t, j) => (
              <InlineText
                key={j}
                content={t.content}
                editing={editing}
                onChange={(content) =>
                  onChange({ ...block, components: block.components.map((x, k) => (k === j ? { ...x, content } : x)) })
                }
              />
            ))}
          </div>
          <div className="dc-section-accessory">
            {block.accessory.type === 2 ? (
              <ButtonPreview b={block.accessory} />
            ) : (
              <Media url={block.accessory.media.url} spoiler={block.accessory.spoiler} className="dc-thumb" />
            )}
          </div>
        </div>
      )
    case 1:
      return (
        <div className="dc-row">
          {block.components.map((b, j) => (
            <ButtonPreview key={j} b={b} />
          ))}
        </div>
      )
    case 12:
      return (
        <div className={`dc-gallery n${Math.min(block.items.length, 5)}`}>
          {block.items.map((it, j) => (
            <Media key={j} url={it.media.url} spoiler={it.spoiler} />
          ))}
        </div>
      )
    case 11:
      return <Media url={block.media.url} spoiler={block.spoiler} className="dc-thumb" />
    case 14:
      return <div className={`dc-sep ${block.spacing === 2 ? 'large' : ''} ${block.divider === false ? 'invisible' : ''}`} />
  }
}

function Text(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; multiline?: boolean }) {
  return (
    <div className="field">
      <label>
        {props.label}
        {props.multiline ? (
          <textarea value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
        ) : (
          <input value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
        )}
      </label>
    </div>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function ButtonFields({ b, onChange }: { b: EmbedButton; onChange: (b: EmbedButton) => void }): JSX.Element {
  return (
    <>
      <Text label="Label" value={b.label ?? ''} onChange={(v) => onChange(withOpt(b, 'label', v))} />
      <Text label="URL" value={b.url} placeholder="https://" onChange={(url) => onChange({ ...b, url })} />
      <Text
        label="Emoji (optional)"
        value={b.emoji?.name ?? ''}
        placeholder="none, or a unicode emoji"
        onChange={(name) => onChange(withOpt(b, 'emoji', name ? { name } : undefined))}
      />
      <Check label="Disabled" checked={Boolean(b.disabled)} onChange={(v) => onChange(withOpt(b, 'disabled', v))} />
    </>
  )
}

function MediaFields<T extends GalleryItem | Thumbnail>({ m, onChange }: { m: T; onChange: (m: T) => void }): JSX.Element {
  return (
    <>
      <Text
        label="Image or video URL"
        value={m.media.url}
        placeholder="https://example.com/hero.webp"
        onChange={(url) => onChange({ ...m, media: { url } })}
      />
      <Text label="Alt text (optional)" value={m.description ?? ''} onChange={(v) => onChange(withOpt(m, 'description', v))} />
      <Check label="Spoiler" checked={Boolean(m.spoiler)} onChange={(v) => onChange(withOpt(m, 'spoiler', v))} />
    </>
  )
}

/** A repeated sub-item with its own remove button, used for buttons, texts and images. */
function Item({ title, onRemove, children }: { title: string; onRemove?: () => void; children: ReactNode }) {
  return (
    <div className="eb-item">
      <div className="eb-item-head">
        <strong>{title}</strong>
        {onRemove && (
          <button type="button" className="ghost danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

function BlockInspector({
  block,
  siteUrl,
  galleryRoom,
  onChange,
}: {
  block: EmbedChild
  siteUrl: string
  galleryRoom: number
  onChange: (c: EmbedChild) => void
}): JSX.Element {
  switch (block.type) {
    case 10:
      return (
        <>
          <Text label="Text" multiline value={block.content} onChange={(content) => onChange({ ...block, content })} />
          <MarkdownHint />
        </>
      )
    case 9: {
      const acc = block.accessory
      return (
        <>
          {block.components.map((t, j) => (
            <Item
              key={j}
              title={`Text ${j + 1}`}
              onRemove={
                block.components.length > 1
                  ? () => onChange({ ...block, components: block.components.filter((_, k) => k !== j) })
                  : undefined
              }
            >
              <Text
                label="Markdown"
                multiline
                value={t.content}
                onChange={(content) =>
                  onChange({ ...block, components: block.components.map((x, k) => (k === j ? { ...x, content } : x)) })
                }
              />
            </Item>
          ))}
          {block.components.length < MAX_SECTION_TEXTS && (
            <button
              type="button"
              className="ghost"
              onClick={() => onChange({ ...block, components: [...block.components, { type: 10, content: 'More text' }] })}
            >
              + Text
            </button>
          )}
          <div className="field">
            <label>
              Beside the text
              <select
                value={acc.type}
                onChange={(e) =>
                  onChange({
                    ...block,
                    accessory: e.target.value === '2' ? newButton(siteUrl) : { type: 11, media: { url: '' } },
                  })
                }
              >
                <option value="2">Link button</option>
                <option value="11">Thumbnail image</option>
              </select>
            </label>
          </div>
          {acc.type === 2 ? (
            <ButtonFields b={acc} onChange={(b) => onChange({ ...block, accessory: b })} />
          ) : (
            <MediaFields m={acc} onChange={(m) => onChange({ ...block, accessory: m })} />
          )}
          <MarkdownHint />
        </>
      )
    }
    case 1:
      return (
        <>
          {block.components.map((b, j) => (
            <Item
              key={j}
              title={`Button ${j + 1}`}
              onRemove={() => onChange({ ...block, components: block.components.filter((_, k) => k !== j) })}
            >
              <ButtonFields
                b={b}
                onChange={(nb) => onChange({ ...block, components: block.components.map((x, k) => (k === j ? nb : x)) })}
              />
            </Item>
          ))}
          {block.components.length < MAX_ROW_BUTTONS && (
            <button
              type="button"
              className="ghost"
              onClick={() => onChange({ ...block, components: [...block.components, newButton(siteUrl)] })}
            >
              + Button
            </button>
          )}
          <span className="hint">Link buttons only, up to {MAX_ROW_BUTTONS} per row.</span>
        </>
      )
    case 12:
      return (
        <>
          {block.items.map((it, j) => (
            <Item key={j} title={`Image ${j + 1}`} onRemove={() => onChange({ ...block, items: block.items.filter((_, k) => k !== j) })}>
              <MediaFields m={it} onChange={(m) => onChange({ ...block, items: block.items.map((x, k) => (k === j ? m : x)) })} />
            </Item>
          ))}
          <button
            type="button"
            className="ghost"
            disabled={galleryRoom <= 0}
            onClick={() => onChange({ ...block, items: [...block.items, { media: { url: '' } }] })}
          >
            + Image
          </button>
          <span className="hint">
            {EMBED_MAX_GALLERY_ITEMS} images at most across every gallery. png, gif, jpg, webp, avif, mp4, webm or mov.
          </span>
        </>
      )
    case 11:
      return <MediaFields m={block} onChange={onChange} />
    case 14:
      return (
        <>
          <Check label="Show a line" checked={block.divider !== false} onChange={(v) => onChange({ ...block, divider: v })} />
          <div className="field">
            <label>
              Spacing
              <select
                value={block.spacing ?? 1}
                onChange={(e) => onChange({ ...block, spacing: e.target.value === '2' ? 2 : 1 })}
              >
                <option value="1">Small</option>
                <option value="2">Large</option>
              </select>
            </label>
          </div>
        </>
      )
  }
}

function MarkdownHint(): JSX.Element {
  return (
    <span className="hint">
      <code># H1</code> <code>## H2</code> <code>-# small</code> <code>**bold**</code> <code>*italic*</code>{' '}
      <code>||spoiler||</code> <code>[text](https://…)</code> <code>- list</code>
    </span>
  )
}
