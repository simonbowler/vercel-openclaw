import { wait } from "@/server/store/store";

export type PollContinue<TState> = {
  done: false;
  state?: TState;
  delayMs?: number;
};

export type PollDone<TResult> = {
  done: true;
  result: TResult;
};

export type PollStepResult<TResult, TState> =
  | PollContinue<TState>
  | PollDone<TResult>;

export type PollUntilOptions<TResult, TState = undefined> = {
  label: string;
  timeoutMs: number;
  initialDelayMs: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  state?: TState;
  sleep?: (ms: number) => Promise<void>;
  step: (context: {
    attempt: number;
    elapsedMs: number;
    state: TState | undefined;
  }) => Promise<PollStepResult<TResult, TState>>;
  timeoutError: (context: {
    attempt: number;
    elapsedMs: number;
    state: TState | undefined;
  }) => Error;
};

export async function pollUntil<TResult, TState = undefined>(
  options: PollUntilOptions<TResult, TState>,
): Promise<TResult> {
  const sleep = options.sleep ?? wait;
  const startedAt = Date.now();
  let attempt = 0;
  let state = options.state;
  let nextDelayMs = options.initialDelayMs;

  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= options.timeoutMs) {
      throw options.timeoutError({ attempt, elapsedMs, state });
    }

    attempt += 1;
    const step = await options.step({ attempt, elapsedMs, state });

    if (step.done) {
      return step.result;
    }

    if (step.state !== undefined) {
      state = step.state;
    }

    const requestedDelayMs = step.delayMs ?? nextDelayMs;
    const cappedDelayMs = Math.min(
      requestedDelayMs,
      options.maxDelayMs ?? requestedDelayMs,
    );
    const remainingMs = options.timeoutMs - (Date.now() - startedAt);

    if (remainingMs <= 0) {
      throw options.timeoutError({
        attempt,
        elapsedMs: Date.now() - startedAt,
        state,
      });
    }

    await sleep(Math.min(cappedDelayMs, remainingMs));

    nextDelayMs = Math.min(
      Math.round(cappedDelayMs * (options.backoffMultiplier ?? 1)),
      options.maxDelayMs ?? Number.MAX_SAFE_INTEGER,
    );
  }
}
