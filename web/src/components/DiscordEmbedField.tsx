import { useState } from 'react'
import type { JSX } from 'react'
import { embedTemplate, type DiscordEmbedPayload } from '../embed'
import { EmbedBuilder } from './embed/EmbedBuilder'

/**
 * What a form holds for the embed: a payload, or - while the JSON tab has text
 * that does not parse - the message to show instead of submitting.
 */
export type EmbedDraft = DiscordEmbedPayload | string

/** Text to a payload, or a message for the form. Discord's own rules are checked by the server. */
export function parseEmbed(text: string): EmbedDraft {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return `Discord embed is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
  }
  const component = (value as { component?: { type?: unknown; components?: unknown } } | null)?.component
  if (component?.type !== 17 || !Array.isArray(component.components)) {
    return 'Discord embed must be { "component": { "type": 17, "components": [...] } }'
  }
  return value as DiscordEmbedPayload
}

interface Props {
  enabled: boolean
  /** Null until the embed is first turned on. */
  value: EmbedDraft | null
  /** URL new buttons and the starting template point at. */
  siteUrl: string
  onEnabledChange: (enabled: boolean) => void
  onChange: (value: EmbedDraft) => void
}

export function DiscordEmbedField({ enabled, value, siteUrl, onEnabledChange, onChange }: Props): JSX.Element {
  const [mode, setMode] = useState<'visual' | 'json'>('visual')
  const [jsonText, setJsonText] = useState('')
  const payload = typeof value === 'string' ? null : value

  const showJson = () => {
    if (payload) setJsonText(JSON.stringify(payload, null, 2))
    setMode('json')
  }

  return (
    <div className="field embed-field">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            onEnabledChange(e.target.checked)
            if (e.target.checked && value === null) onChange(embedTemplate(siteUrl))
          }}
        />
        Discord link embed
      </label>
      {enabled && (
        <>
          <div className="embed-field-head">
            <div className="seg" role="tablist" aria-label="Embed editor">
              <button type="button" role="tab" aria-selected={mode === 'visual'} className={mode === 'visual' ? 'on' : ''}
                disabled={typeof value === 'string'}
                title={typeof value === 'string' ? 'Fix the JSON first' : undefined}
                onClick={() => setMode('visual')}
              >
                Visual
              </button>
              <button type="button" role="tab" aria-selected={mode === 'json'} className={mode === 'json' ? 'on' : ''} onClick={showJson}>
                JSON
              </button>
            </div>
            <span className="hint">
              Injected as{' '}
              <a
                href="https://discord-anthony-embed-unfurl-components.mintlify.site/developers/link-previews/component-embeds"
                target="_blank"
                rel="noreferrer"
              >
                <code>&lt;script id="discord:component-embed"&gt;</code>
              </a>{' '}
              before <code>&lt;/head&gt;</code> on the next deploy, for generated static (nginx) builds.
            </span>
          </div>

          {mode === 'visual' && payload ? (
            <EmbedBuilder value={payload} onChange={onChange} siteUrl={siteUrl} />
          ) : (
            <>
              <textarea
                aria-label="Discord component embed payload"
                className="embed-json"
                value={jsonText}
                spellCheck={false}
                onChange={(e) => {
                  setJsonText(e.target.value)
                  onChange(parseEmbed(e.target.value))
                }}
              />
              {typeof value === 'string' && <span className="hint embed-error">{value}</span>}
            </>
          )}
        </>
      )}
    </div>
  )
}
