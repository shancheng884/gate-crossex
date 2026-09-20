import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dataDir = resolve(process.env.GCT_DATA_DIR ?? join(root, '.local-data'));
const configPath = process.env.GCT_REMOTE_CONFIG ?? join(dataDir, 'remote.json');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function positivePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return port;
}

function remoteConfig() {
  const file = readJson(configPath) ?? {};
  const target = process.env.GCT_REMOTE_SSH_TARGET ?? file.target
    ?? (file.user && file.host ? `${file.user}@${file.host}` : null);
  if (!target || /[\r\n]/.test(target)) {
    throw new Error(`Remote SSH target is missing. Create ${configPath} from deploy/remote.json.example or set GCT_REMOTE_SSH_TARGET.`);
  }
  return {
    target,
    sshPort: positivePort(process.env.GCT_REMOTE_SSH_PORT ?? file.sshPort ?? 22, 'sshPort'),
    localPort: positivePort(process.env.GCT_REMOTE_LOCAL_PORT ?? file.localPort ?? 17840, 'localPort'),
    remotePort: positivePort(process.env.GCT_REMOTE_PORT ?? file.remotePort ?? 17840, 'remotePort'),
    identityFile: process.env.GCT_REMOTE_IDENTITY_FILE ?? file.identityFile ?? null,
  };
}

async function fetchHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
  return response.ok;
}

function openBrowser(url) {
  if (process.env.GCT_NO_OPEN === '1') return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const opener = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  opener.unref();
}

const config = remoteConfig();
try {
  if (await fetchHealth(config.localPort)) {
    throw new Error(`Local port ${config.localPort} is already serving a Gate CrossEx backend. Close the existing tunnel first.`);
  }
} catch (error) {
  if (error instanceof Error && error.message.includes('already serving')) throw error;
}

const args = [
  '-N',
  '-T',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-L', `127.0.0.1:${config.localPort}:127.0.0.1:${config.remotePort}`,
  '-p', String(config.sshPort),
];
if (config.identityFile) args.push('-i', config.identityFile);
args.push(config.target);

const ssh = spawn('ssh', args, { stdio: 'inherit', windowsHide: true });
let stopping = false;
let opened = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  ssh.kill('SIGTERM');
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const startedAt = Date.now();
while (!stopping && !opened && Date.now() - startedAt < 30_000) {
  if (ssh.exitCode !== null) throw new Error(`SSH tunnel exited before the VPS became healthy (code ${ssh.exitCode}).`);
  try {
    if (await fetchHealth(config.localPort)) {
      opened = true;
      const url = `http://127.0.0.1:${config.localPort}`;
      console.log(`Remote Gate CrossEx is ready: ${url}`);
      console.log(`SSH target: ${config.target}`);
      console.log('Press Ctrl+C to close the tunnel.');
      openBrowser(url);
      break;
    }
  } catch {
    // SSH and the VPS service are still starting.
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
}
if (!opened) {
  stop();
  throw new Error('Timed out waiting for the VPS Gate CrossEx service. Check systemctl status and journalctl on the VPS.');
}

await new Promise((resolveExit, rejectExit) => {
  ssh.once('error', rejectExit);
  ssh.once('exit', (code, signal) => {
    if (!stopping && code !== 0) rejectExit(new Error(`SSH tunnel exited (${signal ?? code}).`));
    else resolveExit();
  });
});
