import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { loadConfig } from './config.js';
import type { AppController } from './app/controller.js';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { registerIPC } from './desktop/ipc.js';

const appRoot = app.getAppPath();
const config = loadConfig({ envFile: path.join(appRoot, '.env') });
app.setName('FileBuddy');
// Preserve the existing profile and single-instance lock across the brand change.
const profileRoot = config.workspace.dataDir
  ? path.join(config.workspace.dataDir, 'electron-profile')
  : path.join(app.getPath('appData'), 'Xuwu 文件助手');
mkdirSync(profileRoot, { recursive: true });
app.setPath('userData', profileRoot);
let controller: AppController | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.restore();
    mainWindow?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      const dataRoot = path.resolve(
        config.workspace.dataDir ||
          (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(appRoot, '.my-agent')),
      );
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      const uiPath = path.join(appRoot, 'dist', 'ui', 'index.html');
      mainWindow = new BrowserWindow({
        width: 1440,
        height: 930,
        minWidth: 1080,
        minHeight: 700,
        backgroundColor: '#f7f6f2',
        title: 'FileBuddy',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: path.join(appRoot, 'dist', 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
      const backendReady: Promise<AppController> = import(
        pathToFileURL(path.join(appRoot, 'dist', 'backend.js')).href
      ).then(async (backend) => {
        controller = new backend.AppController(
          dataRoot,
          appRoot,
          (event: unknown) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('xuwu:event', event);
          },
          config,
        );
        await controller!.initialize();
        return controller!;
      });
      registerIPC(mainWindow, backendReady, uiPath);
      mainWindow.once('ready-to-show', () => mainWindow?.show());
      await mainWindow.loadFile(uiPath);
      void backendReady
        .then(() => console.log(`LOCAL_APP_READY data=${dataRoot}`))
        .catch((error) => console.error('Backend initialization failed:', error.message));
      app.on('before-quit', (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        if (controller) void controller.dispose().finally(() => app.quit());
        else app.quit();
      });
      app.on('window-all-closed', () => app.quit());
    })
    .catch((error) => {
      console.error('Application startup failed:', error.message);
      app.quit();
    });
}
