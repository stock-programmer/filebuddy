import { dialog, ipcMain, type BrowserWindow } from 'electron';
import type { AppCommand } from '../app/contracts.js';
import type { AppController } from '../app/controller.js';
import { pathToFileURL } from 'node:url';

function string(value: unknown, name: string, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效。`);
  return value;
}
function strings(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 200 ||
    value.some((v) => typeof v !== 'string' || v.length > 10000)
  )
    throw new Error(`${name}无效。`);
  return value;
}
export function registerIPC(window: BrowserWindow, backendReady: Promise<AppController>, uiPath: string) {
  ipcMain.handle('xuwu:command', async (event, rawCommand: unknown, raw: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame?.url !== pathToFileURL(uiPath).href
    )
      throw new Error('不允许的调用来源。');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数无效。');
    const payload = raw as Record<string, unknown>;
    const command = rawCommand as AppCommand;
    const controller = await backendReady;
    switch (command) {
      case 'snapshot':
        return controller.snapshot();
      case 'session.create':
        return controller.create(typeof payload.title === 'string' ? payload.title : undefined);
      case 'session.select':
        return controller.select(string(payload.id, '会话'));
      case 'session.titleFromDraft':
        if (
          typeof payload.text !== 'string' ||
          payload.text.length > controller.agent.getTaskCharacterLimit()
        )
          throw new Error('任务草稿无效。');
        return controller.titleFromDraft(string(payload.id, '会话'), payload.text);
      case 'session.rename':
        return controller.renameSession(string(payload.id, '会话'), string(payload.title, '会话名称'));
      case 'session.delete': {
        const id = string(payload.id, '会话');
        const target = (await controller.snapshot()).sessions.find((session) => session.id === id);
        if (!target) throw new Error('此会话已不存在，请刷新后重试。');
        const confirmed = await dialog.showMessageBox(window, {
          type: 'warning',
          title: '删除会话',
          message: `删除会话“${target.title}”？`,
          detail: '会话历史、运行记录、工作副本和未导出的修改将被删除，无法撤销。原始文件不受影响。',
          buttons: ['取消', '删除会话'],
          defaultId: 0,
          cancelId: 0,
        });
        if (confirmed.response === 1) await controller.deleteSession(id);
        return controller.snapshot();
      }
      case 'files.pick': {
        const directory = payload.kind === 'directory';
        const selected = await dialog.showOpenDialog(window, {
          title: directory ? '添加目录' : '添加文件',
          properties: directory ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
        });
        if (!selected.canceled && selected.filePaths.length) await controller.importPaths(selected.filePaths);
        return controller.snapshot();
      }
      case 'files.import':
        await controller.importPaths(strings(payload.paths, '文件路径'));
        return controller.snapshot();
      case 'files.remove':
        await controller.removeItem(string(payload.id, '材料'));
        return controller.snapshot();
      case 'chat.send': {
        const text = string(payload.text, '任务', controller.agent.getTaskCharacterLimit());
        void controller.send(text).catch((error) => {
          window.webContents.send('xuwu:event', {
            type: 'activity',
            text: `运行停止：${error instanceof Error ? error.message : String(error)}`,
          });
        });
        return { queued: true };
      }
      case 'chat.stop':
        await controller.stop();
        return controller.snapshot();
      case 'session.compact':
        await controller.compact();
        return controller.snapshot();
      case 'changes.get':
        return controller.changes();
      case 'changes.diff':
        return controller.diff(string(payload.path, '文件'));
      case 'workspace.restore':
        await controller.restore(
          string(payload.path, '文件'),
          typeof payload.expectedHash === 'string' ? payload.expectedHash : undefined,
        );
        return controller.snapshot();
      case 'results.export': {
        const save = await dialog.showSaveDialog(window, {
          title: '导出处理结果',
          defaultPath: '文件处理结果.zip',
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        });
        if (save.canceled || !save.filePath) return { cancelled: true };
        return controller.export(save.filePath);
      }
      case 'results.apply': {
        return controller.withDelivery(async (service) => {
          const paths = payload.paths === undefined ? undefined : strings(payload.paths, '变更清单');
          const preview = await service.preview(paths);
          if (preview.conflicts.length)
            throw new Error(
              `检测到原件冲突，请先处理：\n${preview.conflicts.map((x) => `${x.path}: ${x.reason}`).join('\n')}`,
            );
          if (!preview.changes.length) throw new Error('没有可以应用回原件的变更。');
          const selected = await dialog.showMessageBox(window, {
            type: 'warning',
            title: '确认应用回原件',
            message: `将 ${preview.changes.length} 项变更应用回原始文件？`,
            detail:
              preview.changes
                .map(
                  (change) =>
                    `${change.kind === 'deleted' ? '删除' : change.kind === 'added' ? '新增' : '修改'}：${change.originalPath ?? change.path}`,
                )
                .join('\n')
                .slice(0, 14000) + '\n\n执行前会再次检查原件并建立备份。',
            buttons: ['取消', '确认应用'],
            defaultId: 0,
            cancelId: 0,
          });
          if (selected.response !== 1) return { cancelled: true };
          const result = await service.apply(preview.token);
          controller.recordDelivery('apply', result);
          await controller.changes();
          await controller.publish();
          return result;
        });
      }
      case 'delivery.restore': {
        return controller.withDelivery(async (service) => {
          const confirmed = await dialog.showMessageBox(window, {
            type: 'warning',
            title: '恢复原件备份',
            message: '撤销这次写回，并从备份恢复原件？',
            detail: '原件若已被外部修改，将拒绝覆盖。',
            buttons: ['取消', '确认恢复'],
            defaultId: 0,
            cancelId: 0,
          });
          if (confirmed.response !== 1) return { cancelled: true };
          const result = await service.restoreDelivery(string(payload.id, '交付记录'));
          controller.recordDelivery('restore', result);
          await controller.changes();
          await controller.publish();
          return result;
        });
      }
      case 'trace.export': {
        const save = await dialog.showSaveDialog(window, {
          title: '导出运行记录',
          defaultPath: '运行记录.jsonl',
          filters: [{ name: 'JSONL 运行记录', extensions: ['jsonl'] }],
        });
        if (save.canceled || !save.filePath) return { cancelled: true };
        return controller.exportTrace(save.filePath);
      }
      default:
        throw new Error('不支持的操作。');
    }
  });
}
