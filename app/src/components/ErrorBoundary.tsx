import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Button } from './ui/button'

/**
 * Catches a render that threw, so one bad frame cannot take the whole app down.
 *
 * This exists because everything on the feed comes off the wire: a payload the
 * app did not shape, from a backend that does not answer to it. A throw during
 * render unmounts the entire tree with nothing on screen, and the user is left
 * looking at a blank window with no idea whether they should restart. Here they
 * get an explanation and a way back.
 *
 * A class component because this is the one place a hook cannot do the job:
 * `componentDidCatch` has no hook equivalent.
 */

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged rather than swallowed: the boundary keeps the window usable, but
    // the cause is still worth having in the console.
    console.error('the app failed to render', error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="crash [display:flex] [flex-direction:column] [align-items:center] [justify-content:center] [gap:12px] [height:100vh] [padding:32px] [text-align:center] [color:var(--text)]">
        <Alert variant="destructive" className="crash-alert max-w-xl text-left">
          <AlertTitle className="crash-title text-base">Something went wrong.</AlertTitle>
          <AlertDescription className="crash-body max-w-[42ch] text-left">
            A message from the stream could not be shown. The app kept running, so
            reconnecting usually clears it.
          </AlertDescription>
        </Alert>
        <pre className="crash-detail [margin:0] [max-width:100%] [max-height:30vh] [overflow:auto] [padding:10px_12px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [font-size:12px] [text-align:left] [white-space:pre-wrap] [word-break:break-word]">{error.message}</pre>
        <div className="crash-actions [display:flex] [gap:8px]">
          <Button variant="secondary" className="btn [padding:9px_14px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)]" onClick={this.reset}>
            Try again
          </Button>
          <Button variant="secondary" className="btn btn-small [padding:4px_10px] [background:var(--panel-2)] [border:1px_solid_var(--line)] [border-radius:var(--radius)] [color:var(--text)] [font:inherit] [white-space:nowrap] [&:hover:not(:disabled)]:[border-color:var(--muted)] [font-size:12px]" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    )
  }
}
