// ONE BOUNDARY PER TRICK PART (M94 review).
//
// Without one, a part that throws while it draws reaches the router's error page and takes the whole
// Chat with it. This is the class component the job needs (React has no hook for it): it catches the
// error of the part inside it and draws what the part's place says. A view draws the placeholder ("this
// Collie cannot draw this part"); a belt mark and a status item draw nothing, so the row they sit in
// keeps its other items. Nothing is drawn that a healthy part would not draw.
//
// The boundary clears itself when `resetKey` changes, so a new rev of the part gets a new try. The part's
// `rev` and id are the key, as `${partKey}@${rev}`.

import { Component, type ReactNode } from "react";

import { Placeholder } from "./render";

interface TrickBoundaryProps {
  /** What to draw after a failure: the placeholder for a view, nothing for a mark or a status item. */
  fallback: "placeholder" | "none";
  /** Drawn after a failure instead of `fallback`: a stand-in built only from values that cannot throw. */
  fallbackNode?: ReactNode;
  /**
   * What the part is, as a string (`${partKey}@${rev}`) or as the object the store replaces when it changes
   * (a trick's entry). A new value gives the part a new try; it is compared, never read, so it cannot throw.
   */
  resetKey: string | object;
  children: ReactNode;
}

interface TrickBoundaryState {
  /** The `resetKey` the state was last made under. */
  key: string | object;
  failed: boolean;
}

export class TrickBoundary extends Component<TrickBoundaryProps, TrickBoundaryState> {
  state: TrickBoundaryState = { key: this.props.resetKey, failed: false };

  static getDerivedStateFromError(): Partial<TrickBoundaryState> {
    return { failed: true };
  }

  // A new rev or id is a new part: forget the failure and try it.
  static getDerivedStateFromProps(props: TrickBoundaryProps, state: TrickBoundaryState): Partial<TrickBoundaryState> | null {
    return Object.is(props.resetKey, state.key) ? null : { key: props.resetKey, failed: false };
  }

  componentDidCatch(error: Error): void {
    console.warn("[tricks] a part failed to draw:", error.message);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallbackNode !== undefined) return this.props.fallbackNode;
    return this.props.fallback === "placeholder" ? <Placeholder /> : null;
  }
}
