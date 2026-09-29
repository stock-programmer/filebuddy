import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const logRoot = path.join(appRoot, '.my-agent');
mkdirSync(logRoot, { recursive: true });
const launchLog = path.join(logRoot, 'launcher.log');
const record = (message) => appendFileSync(launchLog, `${new Date().toISOString()} ${message}\n`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Keep build/app output off the console: Windows text-selection mode can block writes to it.
record('Building client');
const buildLog = openSync(path.join(logRoot, 'build.log'), 'w');
try {
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, ['scripts/build.mjs'], {
      cwd: appRoot,
      env,
      windowsHide: true,
      stdio: ['ignore', buildLog, buildLog],
    });
    build.once('error', reject);
    build.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Build exited with ${code}`))));
  });
} catch (error) {
  record(`Build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  closeSync(buildLog);
}

if (!process.exitCode) {
  const stdout = openSync(path.join(logRoot, 'client.stdout.log'), 'a');
  const stderr = openSync(path.join(logRoot, 'client.stderr.log'), 'a');
  try {
    const executable = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const client = spawn(executable, [appRoot], {
      cwd: appRoot,
      env,
      detached: true,
      // This is the user's GUI, not a console helper. SW_HIDE can suppress its first ShowWindow.
      windowsHide: false,
      stdio: ['ignore', stdout, stderr],
    });
    await new Promise((resolve, reject) => {
      client.once('spawn', resolve);
      client.once('error', reject);
    });
    record(`Client launched pid=${client.pid}`);
    client.unref();
  } catch (error) {
    record(`Launch failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}
