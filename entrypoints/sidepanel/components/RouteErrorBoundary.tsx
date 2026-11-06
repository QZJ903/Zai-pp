import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Last-resort boundary for the side panel body.
 *
 * Without one, any render-time throw unmounts the whole React tree: the panel goes
 * blank and the only way out is to close and reopen it. That is not hypothetical here —
 * `t()` throws on a missing key (`core/i18n/runtime.ts`), and the shipped code has a
 * number of dynamic keys cast with `as LocaleMessageKey`, which is exactly the shape that
 * once crashed the MCP page on open.
 *
 * The top-level tab strip lives outside this boundary, so navigation keeps working even
 * when the body is broken. The boundary does not reset itself when the user switches
 * tabs, though, so the "reload" action is part of the contract, not decoration.
 */
interface RouteErrorBoundaryProps {
  children: ReactNode;
  title: string;
  reloadLabel: string;
}

interface RouteErrorBoundaryState {
  failed: boolean;
}

export default class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.log('[Zai++] A side panel page failed to render.', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ds-empty-state" role="alert">
        <p className="ds-empty-state-title">{this.props.title}</p>
        <button
          type="button"
          className="ds-btn-secondary px-3 py-2 text-[11px] font-medium mt-2"
          style={{ borderRadius: 'var(--radius-ctrl)' }}
          onClick={() => window.location.reload()}
        >
          {this.props.reloadLabel}
        </button>
      </div>
    );
  }
}
