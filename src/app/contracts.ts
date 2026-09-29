export type RunStatus =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'ready_for_review'
  | 'cancelled'
  | 'budget_exhausted'
  | 'failed';
export interface SessionSummary {
  id: string;
  title: string;
  titleSource?: 'default' | 'draft' | 'auto' | 'manual';
  createdAt: string;
  updatedAt: string;
}
export interface ImportedItem {
  id: string;
  name: string;
  sourcePath: string;
  workPath: string;
  kind: 'file' | 'directory';
  fileCount: number;
  warnings: string[];
}
export interface Change {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  isDirectory: boolean;
  originalPath?: string;
  canApply: boolean;
  reason?: string;
}
export interface FileDiff {
  before: string;
  after: string;
  patch: string;
  expectedHash?: string;
  beforeState: 'text' | 'missing' | 'unavailable';
  afterState: 'text' | 'missing' | 'unavailable';
  notice?: string;
  beforeFormat?: string;
  afterFormat?: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'notice';
  text: string;
  createdAt: string;
}
export interface ModelProgress {
  requestId: string;
  modelCall: number;
  kind: 'conversation' | 'compaction';
  phase: 'waiting' | 'thinking' | 'answering' | 'tool_arguments' | 'receiving' | 'finished';
  startedAt: string;
  firstEventAt?: string;
  firstContentAt?: string;
  lastEventAt?: string;
  lastContentAt?: string;
  eventCounts: Record<string, number>;
  characters: { text: number; thinking: number; toolArguments: number };
}
export interface RunView {
  id: string;
  status: RunStatus;
  startedAt: string;
  elapsedMs: number;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  tokenLimit: number | null;
  lastActivity: string;
  error?: string;
  modelProgress?: ModelProgress;
}
export interface AppSnapshot {
  sessions: SessionSummary[];
  current: SessionSummary | null;
  items: ImportedItem[];
  messages: ChatMessage[];
  changes: Change[];
  run: RunView | null;
  model: { name: string; provider: string; configured: boolean };
  warnings: string[];
}
export type AppEvent =
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'text_delta'; text: string; runId: string }
  | { type: 'activity'; text: string };
export type AppCommand =
  | 'snapshot'
  | 'session.create'
  | 'session.select'
  | 'session.titleFromDraft'
  | 'session.rename'
  | 'session.delete'
  | 'files.pick'
  | 'files.import'
  | 'files.remove'
  | 'chat.send'
  | 'chat.stop'
  | 'changes.get'
  | 'changes.diff'
  | 'results.export'
  | 'results.apply'
  | 'trace.export'
  | 'session.compact'
  | 'workspace.restore'
  | 'delivery.restore';
export interface ClientAPI {
  invoke(command: AppCommand, payload?: Record<string, unknown>): Promise<any>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  importDropped(files: File[]): Promise<any>;
}
declare global {
  interface Window {
    xuwu: ClientAPI;
  }
}
