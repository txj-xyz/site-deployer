import { z } from 'zod'

/**
 * Discord component embeds: a Components V2 payload that Discord's crawler reads
 * from a `<script id="discord:component-embed">` tag in server-rendered HTML and
 * shows in place of the Open Graph unfurl.
 * https://discord-anthony-embed-unfurl-components.mintlify.site/developers/link-previews/component-embeds
 *
 * Discord rejects the whole payload on any unexpected key, so every object here is
 * `.strict()` and the limits are checked before a deploy ever bakes one in.
 */

/** The payload, as serialized into the page, may not exceed this many bytes. */
export const EMBED_MAX_BYTES = 3000
/** Including the top-level Container. */
export const EMBED_MAX_COMPONENTS = 40
/** Across every Media Gallery in the embed, not per gallery. */
export const EMBED_MAX_GALLERY_ITEMS = 10

const MEDIA_EXTENSIONS = ['.png', '.gif', '.jpg', '.jpeg', '.webp', '.avif', '.mp4', '.webm', '.mov']

const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')

const media = z
  .object({
    url: httpUrl.refine((u) => {
      const path = new URL(u).pathname.toLowerCase()
      return MEDIA_EXTENSIONS.some((ext) => path.endsWith(ext))
    }, `must end in one of ${MEDIA_EXTENSIONS.join(' ')}`),
  })
  .strict()

const emoji = z
  .object({ id: z.string().optional(), name: z.string().optional(), animated: z.boolean().optional() })
  .strict()

/** Only link buttons are allowed; `id`, `custom_id` and `sku_id` invalidate the payload. */
const button = z
  .object({
    type: z.literal(2),
    style: z.literal(5),
    url: httpUrl,
    label: z.string().min(1).max(80).optional(),
    emoji: emoji.optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.label !== undefined || b.emoji !== undefined, 'a button needs a label or an emoji')

const textDisplay = z.object({ type: z.literal(10), content: z.string().min(1) }).strict()

const thumbnail = z
  .object({
    type: z.literal(11),
    media,
    description: z.string().max(1024).optional(),
    spoiler: z.boolean().optional(),
  })
  .strict()

const actionRow = z.object({ type: z.literal(1), components: z.array(button).min(1).max(5) }).strict()

const section = z
  .object({
    type: z.literal(9),
    components: z.array(textDisplay).min(1).max(3),
    accessory: z.union([button, thumbnail]),
  })
  .strict()

const mediaGallery = z
  .object({
    type: z.literal(12),
    items: z
      .array(
        z
          .object({ media, description: z.string().max(1024).optional(), spoiler: z.boolean().optional() })
          .strict(),
      )
      .min(1)
      .max(EMBED_MAX_GALLERY_ITEMS),
  })
  .strict()

const separator = z
  .object({ type: z.literal(14), divider: z.boolean().optional(), spacing: z.union([z.literal(1), z.literal(2)]).optional() })
  .strict()

const child = z.union([actionRow, section, textDisplay, thumbnail, mediaGallery, separator])

const container = z
  .object({
    type: z.literal(17),
    accent_color: z.number().int().min(0).max(0xffffff).nullable().optional(),
    spoiler: z.boolean().optional(),
    components: z.array(child).min(1),
  })
  .strict()

export const discordEmbedPayload = z.object({ component: container }).strict()
export type DiscordEmbedPayload = z.infer<typeof discordEmbedPayload>

/** Every component in the tree, including the Container and section accessories. */
function countComponents(p: DiscordEmbedPayload): { components: number; galleryItems: number } {
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

/**
 * The payload as it goes into the page. Characters that could end the `<script>`
 * element, or that nginx would read as a variable or string delimiter, are written
 * as JSON `\u` escapes - Discord decodes them back, and the size limit counts them.
 */
export function serializeEmbed(p: DiscordEmbedPayload): string {
  return JSON.stringify(p).replace(/[<>&$']/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function embedScriptTag(p: DiscordEmbedPayload): string {
  return `<script id="discord:component-embed" type="application/json">${serializeEmbed(p)}</script>`
}

/** The zod schema plus the limits that span the whole tree. */
export const discordEmbed = discordEmbedPayload.superRefine((p, ctx) => {
  const { components, galleryItems } = countComponents(p)
  if (components > EMBED_MAX_COMPONENTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${components} components; Discord allows at most ${EMBED_MAX_COMPONENTS} including the container`,
    })
  }
  if (galleryItems > EMBED_MAX_GALLERY_ITEMS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${galleryItems} media gallery items; Discord allows at most ${EMBED_MAX_GALLERY_ITEMS} across the embed`,
    })
  }
  const bytes = Buffer.byteLength(serializeEmbed(p), 'utf8')
  if (bytes > EMBED_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `payload is ${bytes} bytes once escaped; Discord allows at most ${EMBED_MAX_BYTES}`,
    })
  }
})
