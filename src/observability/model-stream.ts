import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ModelProgress } from '../app/contracts.js';

/** Statistics over Pi events, never response bodies or raw network byte timings. */
export class ModelStreamMetrics {
  readonly eventCounts: Record<string, number> = {};
  readonly characters = { text: 0, thinking: 0, toolArguments: 0 };
  firstEvent?: number;
  lastEvent?: number;
  firstContent?: number;
  lastContent?: number;
  maxContentGapMs = 0;
  phase: ModelProgress['phase'] = 'waiting';

  constructor(readonly started: number) {}

  observe(event: AssistantMessageEvent, now = Date.now()): boolean {
    this.firstEvent ??= now;
    this.lastEvent = now;
    this.eventCounts[event.type] = (this.eventCounts[event.type] ?? 0) + 1;
    const key =
      event.type === 'thinking_delta'
        ? 'thinking'
        : event.type === 'text_delta'
          ? 'text'
          : event.type === 'toolcall_delta'
            ? 'toolArguments'
            : undefined;
    // Local start events, empty deltas and block markers do not prove useful progress.
    if (!key || !('delta' in event) || !event.delta.length) return false;
    this.maxContentGapMs = Math.max(this.maxContentGapMs, now - (this.lastContent ?? this.started));
    this.firstContent ??= now;
    this.lastContent = now;
    this.characters[key] += event.delta.length;
    this.phase = key === 'thinking' ? 'thinking' : key === 'text' ? 'answering' : 'tool_arguments';
    return true;
  }

  snapshot(now = Date.now()) {
    const iso = (value?: number) => (value === undefined ? null : new Date(value).toISOString());
    return {
      measurementScope: 'pi_stream_events',
      firstEventAt: iso(this.firstEvent),
      firstEventLatencyMs: this.firstEvent === undefined ? null : this.firstEvent - this.started,
      firstContentAt: iso(this.firstContent),
      firstContentLatencyMs: this.firstContent === undefined ? null : this.firstContent - this.started,
      lastEventAt: iso(this.lastEvent),
      lastContentAt: iso(this.lastContent),
      eventCounts: { ...this.eventCounts },
      characters: { ...this.characters },
      maxContentGapMs: Math.max(this.maxContentGapMs, now - (this.lastContent ?? this.started)),
      idleForMs: now - (this.lastContent ?? this.started),
    };
  }
}

/** Abort must settle the host even if a provider never settles its own promise. */
export function abortable<T>(pending: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(new Error(String(signal.reason ?? 'Request aborted')));
    };
    if (signal.aborted) {
      // Observe a late rejection without allowing it to escape as unhandled.
      void Promise.resolve(pending).catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(pending).then(
      (result) => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) aborted();
        else resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
