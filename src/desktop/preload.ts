import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppCommand, AppEvent, ClientAPI } from '../app/contracts.js';
const allowed: AppCommand[] = [
  'snapshot',
  'session.create',
  'session.select',
  'session.titleFromDraft',
  'session.rename',
  'session.delete',
  'files.pick',
  'files.remove',
  'chat.send',
  'chat.stop',
  'changes.get',
  'changes.diff',
  'results.export',
  'results.apply',
  'trace.export',
  'session.compact',
  'workspace.restore',
  'delivery.restore',
];
const api: ClientAPI = {
  invoke(command, payload = {}) {
    if (!allowed.includes(command)) return Promise.reject(new Error('Unsupported action'));
    return ipcRenderer.invoke('xuwu:command', command, payload);
  },
  onEvent(listener) {
    const handler = (_: unknown, event: AppEvent) => listener(event);
    ipcRenderer.on('xuwu:event', handler);
    return () => ipcRenderer.removeListener('xuwu:event', handler);
  },
  importDropped(files) {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return ipcRenderer.invoke('xuwu:command', 'files.import', { paths });
  },
};
contextBridge.exposeInMainWorld('xuwu', api);
