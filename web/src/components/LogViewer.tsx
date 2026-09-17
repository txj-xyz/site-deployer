import { useEffect, useRef, useState } from 'react'
import { useDeploymentLogs } from '../hooks'
import { StatusPill } from './StatusPill'
import type { DeployStatus } from '../api'
import type { JSX } from 'react'

interface Props {
  deploymentId: string | null
  /** Status known from polling; the stream's own status event wins once it arrives. */
  fallbackStatus?: DeployStatus | null
  onTerminal?: (status: DeployStatus) => void
}

export function LogViewer({ deploymentId, fallbackStatus, onTerminal }: Props): JSX.Element {
  const { lines, status, connected } = useDeploymentLogs(deploymentId)
  const boxRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)

  // Auto-scroll, but stop fighting the user the moment they scroll up to read
  // something. Resumes when they return to the bottom.
  useEffect(() => {
    const box = boxRef.current
    if (box && stickToBottom) box.scrollTop = box.scrollHeight
  }, [lines, stickToBottom])

  useEffect(() => {
    if (status && onTerminal) onTerminal(status)
  }, [status, onTerminal])

  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    setStickToBottom(atBottom)
  }

  if (!deploymentId) {
    return <div className="empty-state">Select a deployment to see its log.</div>
  }

  return (
    <>
      <div className="card-head">
        <StatusPill status={status ?? fallbackStatus} />
        <span className="dim" style={{ fontSize: 12 }}>
          {connected ? 'streaming' : 'closed'} · {lines.length} lines
          {!stickToBottom && ' · scroll paused'}
        </span>
      </div>
      <div className="console" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <div className="empty">waiting for output…</div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`l-${line.stream}`}>
              {line.line}
            </div>
          ))
        )}
      </div>
    </>
  )
}
