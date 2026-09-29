import { lstat, readFile, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createExtensionRuntime,
  loadSkillsFromDir,
  type ResourceLoader,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import { digest, type TraceWriter } from '../observability/trace.js';
import { DEFAULT_CONFIG, type WorkspaceConfig } from '../config.js';
import { readTextPage } from '../workspace/text-page.js';

/** Explicit resources mean an imported .pi, AGENTS.md or extension is never executed. */
export class TrustedResources implements ResourceLoader {
  private system = '';
  private skills: Skill[] = [];
  private readonly extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  private allowed = new Map<string, { path: string; skill: string }>();
  constructor(
    readonly appRoot: string,
    readonly config: WorkspaceConfig = DEFAULT_CONFIG.workspace,
  ) {}
  async reload(): Promise<void> {
    this.system = await readFile(join(this.appRoot, 'instructions', 'system.md'), 'utf8');
    const root = join(this.appRoot, 'skills');
    this.skills = loadSkillsFromDir({ dir: root, source: 'application' }).skills;
    this.allowed.clear();
    const visit = async (directory: string, skill: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) {
          if (item.name !== 'scripts') await visit(path, skill);
        } else if (item.isFile() && /\.(md|txt|json|csv|yaml|yml)$/i.test(item.name))
          this.allowed.set(resolve(path).toLowerCase(), { path, skill });
      }
    };
    for (const skill of this.skills) {
      const info = await lstat(skill.baseDir);
      if (info.isSymbolicLink()) throw new Error('应用 skill 目录不得使用符号链接');
      await visit(skill.baseDir, skill.name);
    }
  }
  getExtensions() {
    return this.extensions;
  }
  getSkills() {
    return { skills: this.skills, diagnostics: [] };
  }
  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }
  getThemes() {
    return { themes: [], diagnostics: [] };
  }
  getAgentsFiles() {
    return { agentsFiles: [] };
  }
  getSystemPrompt() {
    return this.system;
  }
  getSystemPromptSource() {
    return { path: join(this.appRoot, 'instructions', 'system.md') };
  }
  getAppendSystemPrompt() {
    return [];
  }
  getAppendSystemPromptSources() {
    return [];
  }
  extendResources(): void {
    throw new Error('只允许应用内登记的资源');
  }
  describe() {
    return this.skills.map(({ name, description }) => ({ name, description }));
  }
  async readSkill(
    path: string,
    startLine: number,
    maxLines: number,
    trace?: TraceWriter,
    toolCallId?: string,
    startColumn = 0,
  ): Promise<unknown | undefined> {
    if (!isAbsolute(path)) return undefined;
    const entry = this.allowed.get(resolve(path).toLowerCase());
    if (!entry) return undefined;
    const root = resolve(this.appRoot, 'skills');
    const resolved = await realpath(entry.path);
    const rel = relative(root, resolved);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('SKILL_PATH_REJECTED');
    let current = root;
    if ((await lstat(current)).isSymbolicLink()) throw new Error('SKILL_LINK_REJECTED');
    for (const part of relative(root, entry.path).split(sep)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('SKILL_LINK_REJECTED');
    }
    const info = await lstat(entry.path);
    if (info.size > this.config.skills.maxFileBytes)
      throw new Error(`SKILL_TOO_LARGE: 技能资料最多 ${this.config.skills.maxFileBytes} 字节`);
    const text = await readFile(entry.path, 'utf8');
    const page = readTextPage(text, { startLine, startColumn, maxLines }, this.config.read);
    trace?.record(
      'skill_load',
      {
        skill: entry.skill,
        resource: relative(root, entry.path).replaceAll('\\', '/'),
        hash: digest(text),
        startLine,
        returnedLines: page.content.split('\n').length,
      },
      toolCallId,
    );
    return {
      path: entry.path,
      hash: digest(text),
      ...page,
      trustedSkill: true,
    };
  }
}
