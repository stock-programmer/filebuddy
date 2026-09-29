import path from 'node:path';
import fs from 'node:fs/promises';

export class WorkspaceError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkspaceError('CANCELLED', '操作已取消，尚未提交的写入未执行。');
}
export function inside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function normalizeRelative(input: string, allowRoot = false): string {
  if (typeof input !== 'string' || input.includes('\0') || input.includes(':') || /^[\\/]/.test(input))
    throw new WorkspaceError('PATH_DENIED', '只允许工作区内的相对路径。');
  const parts = input.replaceAll('\\', '/').split('/');
  if (
    parts.some(
      (p) =>
        p === '..' ||
        (p !== '.' && /[. ]$/.test(p)) ||
        /[<>"|?*\x00-\x1f]/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new WorkspaceError('PATH_DENIED', 'PATH_DENIED：路径包含不支持或越界的部分。');
  const rel = parts.filter((p) => p && p !== '.').join('/');
  if (!rel && !allowRoot) throw new WorkspaceError('PATH_DENIED', '不能对工作区根执行此操作。');
  return rel;
}
export async function assertNoLinks(absolute: string): Promise<void> {
  const parsed = path.parse(path.resolve(absolute));
  let cursor = parsed.root;
  for (const part of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch (error: any) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1))
      throw new WorkspaceError('LINK_DENIED', '不支持符号链接、junction、硬链接或特殊文件。');
  }
}
export async function resolveSafe(root: string, relative: string, allowRoot = false): Promise<string> {
  const clean = normalizeRelative(relative, allowRoot);
  const absolute = path.resolve(root, clean);
  if (!inside(root, absolute)) throw new WorkspaceError('PATH_DENIED', '路径超出工作区。');
  await assertNoLinks(absolute);
  return absolute;
}
export function sensitiveName(name: string): boolean {
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /^(id_rsa|id_ed25519|credentials|credentials\.json)$/i.test(name) ||
    /\.(pem|key|p12|pfx)$/i.test(name) ||
    ['.ssh', '.aws', '.azure', '.git', 'node_modules'].includes(name.toLowerCase())
  );
}
export function assertPublicPath(relative: string): void {
  if (relative.replaceAll('\\', '/').split('/').some(sensitiveName))
    throw new WorkspaceError('SENSITIVE_PATH', '敏感文件或系统目录默认不允许导入或操作。');
}
