import { appendFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function digest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    .digest('hex');
}

/** Trace is an allowlisted summary; file contents and credentials stay out of it. */
export function safeError(error: unknown, secrets: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  return message
    .replace(/(?:Bearer\s+)[\w.\-]+/gi, 'Bearer [redacted]')
    .replace(/(?:sk-|sess-)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/([A-Z]:[\\/])[^\s\n"']+/gi, '[local-path]')
    .replace(/(api[_-]?key|authorization|token|password)\s*[=:]\s*[^,\s]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function sanitize(value: unknown, key = '', secrets: readonly string[] = []): unknown {
  if (/^(apiKey|authorization|password|secret|credential|headers|sourcePath)$/i.test(key))
    return '[redacted]';
  // Numeric stream character counts (e.g. characters.text) are safe metadata.
  if (/^(content|oldText|newText|prompt|text|arguments)$/i.test(key) && typeof value !== 'number')
    return { sha256: digest(value), bytes: Buffer.byteLength(JSON.stringify(value) ?? '') };
  if (typeof value === 'string') return safeError(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, '', secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k, secrets)]));
  return value;
}

export class TraceWriter {
  readonly path: string;
  constructor(
    readonly dataRoot: string,
    readonly sessionId: string,
    readonly runId: string,
    private readonly secrets: readonly string[] = [],
  ) {
    this.path = join(dataRoot, 'traces', sessionId, `${runId}.jsonl`);
    mkdirSync(dirname(this.path), { recursive: true });
  }
  record(type: string, data: Record<string, unknown> = {}, parentId?: string): string {
    const eventId = randomUUID();
    appendFileSync(
      this.path,
      JSON.stringify({
        time: new Date().toISOString(),
        eventId,
        parentId,
        sessionId: this.sessionId,
        runId: this.runId,
        appVersion: '0.1.0',
        piVersion: '0.87.1',
        type,
        ...(sanitize(data, '', this.secrets) as object),
      }) + '\n',
      'utf8',
    );
    return eventId;
  }
  exportTo(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(this.path, target);
  }
  redact(error: unknown): string {
    return safeError(error, this.secrets);
  }
}
