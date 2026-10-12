import { Component, type ErrorInfo, type ReactNode } from 'react'

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
      <div className="crash">
        <h1 className="crash-title">Something went wrong.</h1>
        <p className="crash-body">
          A message from the stream could not be shown. The app kept running, so
          reconnecting usually clears it.
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <div className="crash-actions">
          <button className="btn" onClick={this.reset}>
            Try again
          </button>
          <button className="btn btn-small" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}