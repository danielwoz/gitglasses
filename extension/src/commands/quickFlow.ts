// Minimal multi-step flow runner for the git command palette. Steps consume
// the accumulated state and return next/back/cancel; back rewinds to the
// previous step with the state that step originally saw. Pure (no vscode
// imports) so tests drive it with fake steps.

export type StepOutcome<S> =
  | { type: 'next'; state: S }
  | { type: 'back' }
  | { type: 'cancel' };

export type Step<S> = (state: S) => StepOutcome<S> | Promise<StepOutcome<S>>;

export type FlowResult<S> =
  | { status: 'completed'; state: S }
  | { status: 'cancelled' }
  | { status: 'backedOut' };

export function next<S>(state: S): StepOutcome<S> {
  return { type: 'next', state };
}

export function back<S>(): StepOutcome<S> {
  return { type: 'back' };
}

export function cancel<S>(): StepOutcome<S> {
  return { type: 'cancel' };
}

/** Runs steps in order. Back at the first step reports backedOut so callers
 *  can return to whatever preceded the flow (e.g. the root command picker). */
export async function runFlow<S>(initial: S, steps: readonly Step<S>[]): Promise<FlowResult<S>> {
  // entryStates[i] is the state step i sees; rewinding truncates past it.
  const entryStates: S[] = [initial];
  let index = 0;
  while (index < steps.length) {
    const outcome = await steps[index](entryStates[index]);
    if (outcome.type === 'cancel') return { status: 'cancelled' };
    if (outcome.type === 'back') {
      if (index === 0) return { status: 'backedOut' };
      index -= 1;
      entryStates.length = index + 1;
      continue;
    }
    entryStates[index + 1] = outcome.state;
    index += 1;
  }
  return { status: 'completed', state: entryStates[index] };
}
