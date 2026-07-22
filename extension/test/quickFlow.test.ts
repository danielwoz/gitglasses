import { describe, expect, it } from 'vitest';
import { Step, back, cancel, next, runFlow } from '../src/commands/quickFlow';

interface State {
  values: string[];
}

describe('runFlow', () => {
  it('completes a linear flow accumulating state', async () => {
    const steps: Step<State>[] = [
      (state) => next({ values: [...state.values, 'a'] }),
      (state) => next({ values: [...state.values, 'b'] }),
      (state) => next({ values: [...state.values, 'c'] }),
    ];
    const result = await runFlow({ values: [] }, steps);
    expect(result).toEqual({ status: 'completed', state: { values: ['a', 'b', 'c'] } });
  });

  it('reports cancelled when a step cancels', async () => {
    const result = await runFlow<State>({ values: [] }, [
      (state) => next({ values: [...state.values, 'a'] }),
      () => cancel(),
    ]);
    expect(result).toEqual({ status: 'cancelled' });
  });

  it('reports backedOut when the first step goes back', async () => {
    const result = await runFlow<State>({ values: [] }, [() => back()]);
    expect(result).toEqual({ status: 'backedOut' });
  });

  it('rewinds to the previous step with its original entry state', async () => {
    const seenByStep2: string[][] = [];
    let step3Calls = 0;
    const steps: Step<State>[] = [
      (state) => next({ values: [...state.values, 'a'] }),
      (state) => {
        seenByStep2.push(state.values);
        return next({ values: [...state.values, 'b'] });
      },
      (state) => {
        step3Calls += 1;
        return step3Calls === 1 ? back() : next({ values: [...state.values, 'c'] });
      },
    ];
    const result = await runFlow({ values: [] }, steps);
    // Step 2 ran twice, both times with the state produced by step 1 only.
    expect(seenByStep2).toEqual([['a'], ['a']]);
    expect(result).toEqual({ status: 'completed', state: { values: ['a', 'b', 'c'] } });
  });

  it('supports going back multiple steps in a row', async () => {
    const calls: number[] = [];
    let backsRemaining = 2;
    const steps: Step<State>[] = [
      (state) => {
        calls.push(1);
        return next({ values: [...state.values, '1'] });
      },
      (state) => {
        calls.push(2);
        return next({ values: [...state.values, '2'] });
      },
      (state) => {
        calls.push(3);
        if (backsRemaining > 0) {
          backsRemaining -= 1;
          return back();
        }
        return next({ values: [...state.values, '3'] });
      },
    ];
    // Step 3 backs to step 2, which advances again; the second back repeats
    // that cycle before step 3 finally completes.
    const result = await runFlow({ values: [] }, steps);
    expect(result.status).toBe('completed');
    expect(calls).toEqual([1, 2, 3, 2, 3, 2, 3]);
  });

  it('completes immediately with no steps', async () => {
    const result = await runFlow({ values: ['seed'] }, []);
    expect(result).toEqual({ status: 'completed', state: { values: ['seed'] } });
  });

  it('supports async steps', async () => {
    const result = await runFlow<State>({ values: [] }, [
      async (state) => next({ values: [...state.values, 'async'] }),
    ]);
    expect(result).toEqual({ status: 'completed', state: { values: ['async'] } });
  });
});
