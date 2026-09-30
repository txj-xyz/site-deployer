/**
 * Discord component-embed types and helpers for the dashboard's visual builder.
 * The server (`server/discord/embed.ts`) is the authority on validity; the checks
 * here exist so the builder can flag problems while you type.
 */

export const EMBED_MAX_BYTES = 3000
export const EMBED_MAX_COMPONENTS = 40
export const EMBED_MAX_GALLERY_ITEMS = 10
export const MAX_ROW_BUTTONS = 5
export const MAX_SECTION_TEXTS = 3

const MEDIA_EXTENSIONS = ['.png', '.gif', '.jpg', '.jpeg', '.webp', '.avif', '.mp4', '.webm', '.mov']
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov']

export interface UnfurledMedia {
  url: string
}
export interface EmbedButton {
  type: 2
  style: 5
  url: string
  label?: string
  emoji?: { id?: string; name?: string; animated?: boolean }
  disabled?: boolean
}
export interface TextDisplay {
  type: 10
  content: string
}
export interface Thumbnail {
  type: 11
  media: UnfurledMedia
  description?: string
  spoiler?: boolean
}
export interface ActionRow {
  type: 1
  components: EmbedButton[]
}
export interface Section {
  type: 9
  components: TextDisplay[]
  accessory: EmbedButton | Thumbnail
}
export interface GalleryItem {
  media: UnfurledMedia
  description?: string
  spoiler?: boolean
}
export interface MediaGallery {
  type: 12
  items: GalleryItem[]
}
export interface Separator {
  type: 14
  divider?: boolean
  spacing?: 1 | 2
}

export type EmbedChild = ActionRow | Section | TextDisplay | Thumbnail | MediaGallery | Separator

export interface DiscordEmbedPayload {
  component: {
    type: 17
    accent_color?: number | null
    spoiler?: boolean
    components: EmbedChild[]
  }
}

export type ChildType = EmbedChild['type']

export const CHILD_LABELS: Record<ChildType, string> = {
  10: 'Text',
  9: 'Section',
  1: 'Buttons',
  12: 'Gallery',
  11: 'Thumbnail',
  14: 'Separator',
}

export function newButton(url: string): EmbedButton {
  return { type: 2, style: 5, url, label: 'Open' }
}

export function newChild(type: ChildType, url: string): EmbedChild {
  switch (type) {
    case 10:
      return { type: 10, content: 'Some **markdown** text' }
    case 9:
      return {
        type: 9,
        components: [{ type: 10, content: '## Heading\nA line of description.' }],
        accessory: newButton(url),
      }
    case 1:
      return { type: 1, components: [newButton(url)] }
    case 12:
      return { type: 12, items: [{ media: { url: '' } }] }
    case 11:
      return { type: 11, media: { url: '' } }
    case 14:
      return { type: 14, divider: true, spacing: 1 }
  }
}

/** A starting point: a titled section with a link button, then a divider and a note. */
export function embedTemplate(url: string): DiscordEmbedPayload {
  return {
    component: {
      type: 17,
      accent_color: 0x5865f2,
      components: [
        {
          type: 9,
          components: [{ type: 10, content: `# **[My site](${url})**\nA short description of the page.` }],
          accessory: { type: 2, style: 5, url, label: 'Open' },
        },
        { type: 14, divider: true, spacing: 1 },
        { type: 10, content: '-# Deployed with site-deployer' },
      ],
    },
  }
}

/** Same escaping as the server's serializeEmbed, so the byte count matches what ships. */
export function embedBytes(p: DiscordEmbedPayload): number {
  const escaped = JSON.stringify(p).replace(/[<>&$']/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return new TextEncoder().encode(escaped).length
}

export function countEmbed(p: DiscordEmbedPayload): { components: number; galleryItems: number } {
  let components = 1
  let galleryItems = 0
  for (const c of p.component.components) {
    components++
    if (c.type === 1) components += c.components.length
    if (c.type === 9) components += c.components.length + 1
    if (c.type === 12) galleryItems += c.items.length
  }
  return { components, galleryItems }
}

/** Lowercased URL path, or null when the URL does not parse. */
function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname.toLowerCase()
  } catch {
    return null
  }
}

export function isVideo(url: string): boolean {
  const path = pathOf(url)
  return path !== null && VIDEO_EXTENSIONS.some((e) => path.endsWith(e))
}

function urlProblem(url: string, media: boolean): string | null {
  if (!url) return 'needs a URL'
  if (!/^https?:\/\//i.test(url)) return 'URL must start with http:// or https://'
  if (url.length > 2048) return 'URL is longer than 2,048 characters'
  const path = pathOf(url)
  if (media && !(path && MEDIA_EXTENSIONS.some((e) => path.endsWith(e)))) {
    return `media URL must end in ${MEDIA_EXTENSIONS.join(' ')}`
  }
  return null
}

function buttonProblems(b: EmbedButton, where: string): string[] {
  const out: string[] = []
  const u = urlProblem(b.url, false)
  if (u) out.push(`${where}: ${u}`)
  if (!b.label && !b.emoji?.name && !b.emoji?.id) out.push(`${where}: needs a label or an emoji`)
  if (b.label && b.label.length > 80) out.push(`${where}: label is longer than 80 characters`)
  return out
}

/** Problems per top-level block index, plus `-1` for ones that span the embed. */
export function embedProblems(p: DiscordEmbedPayload): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const add = (i: number, msgs: string[]) => {
    if (msgs.length) out.set(i, [...(out.get(i) ?? []), ...msgs])
  }

  if (p.component.components.length === 0) add(-1, ['add at least one block'])
  const { components, galleryItems } = countEmbed(p)
  if (components > EMBED_MAX_COMPONENTS) add(-1, [`${components} components; the limit is ${EMBED_MAX_COMPONENTS}`])
  if (galleryItems > EMBED_MAX_GALLERY_ITEMS) {
    add(-1, [`${galleryItems} gallery images; the limit is ${EMBED_MAX_GALLERY_ITEMS} across the embed`])
  }
  const bytes = embedBytes(p)
  if (bytes > EMBED_MAX_BYTES) add(-1, [`${bytes} bytes; the limit is ${EMBED_MAX_BYTES}`])

  p.component.components.forEach((c, i) => {
    switch (c.type) {
      case 10:
        if (!c.content.trim()) add(i, ['text is empty'])
        break
      case 9:
        c.components.forEach((t, j) => {
          if (!t.content.trim()) add(i, [`text ${j + 1} is empty`])
        })
        if (c.accessory.type === 2) add(i, buttonProblems(c.accessory, 'button'))
        else {
          const u = urlProblem(c.accessory.media.url, true)
          if (u) add(i, [`thumbnail ${u}`])
        }
        break
      case 1:
        if (c.components.length === 0) add(i, ['add at least one button'])
        c.components.forEach((b, j) => add(i, buttonProblems(b, `button ${j + 1}`)))
        break
      case 12:
        if (c.items.length === 0) add(i, ['add at least one image'])
        c.items.forEach((it, j) => {
          const u = urlProblem(it.media.url, true)
          if (u) add(i, [`image ${j + 1} ${u}`])
        })
        break
      case 11: {
        const u = urlProblem(c.media.url, true)
        if (u) add(i, [`thumbnail ${u}`])
        break
      }
      case 14:
        break
    }
  })
  return out
}

export function colorToHex(n: number): string {
  return `#${n.toString(16).padStart(6, '0')}`
}

export function hexToColor(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16)
}
