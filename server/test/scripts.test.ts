import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const scriptsDir = resolve(import.meta.dirname, '../scripts');
const servePath = resolve(scriptsDir, 'serve.sh');
const deployPath = resolve(scriptsDir, 'deploy-vps.sh');
const scripts = { 'serve.sh': servePath, 'deploy-vps.sh': deployPath };

const read = (path: string) => readFileSync(path, 'utf8');
const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;

describe.each(Object.entries(scripts))('%s', (_name, path) => {
  test('passes bash -n', () => {
    const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  test('is executable', () => {
    expect(() => accessSync(path, constants.X_OK)).not.toThrow();
  });

  test('uses strict mode and never sources .env', () => {
    const text = read(path);
    expect(text).toMatch(/^set -euo pipefail$/m);
    expect(text).not.toMatch(/^\s*(source|\.)\s+\S*\.env\b/m);
    expect(text).not.toMatch(/source\s+.*\.env/);
  });

  test.skipIf(!hasShellcheck)('passes shellcheck', () => {
    const result = spawnSync('shellcheck', [path], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('serve.sh', () => {
  const text = read(servePath);

  test('runs server/src/main.ts through the local tsx binary', () => {
    expect(text).toContain('server/node_modules/.bin/tsx');
    expect(text).toContain('server/src/main.ts');
  });

  test('supports the build and API-only switches', () => {
    expect(text).toContain('SKIP_WEB_BUILD');
    expect(text).toContain('SKIP_WEB');
    expect(text).toContain('pnpm -F @nad/web build');
    expect(text).toContain('web/dist/index.html');
  });

  test('execs directly under pm2 and loops with caffeinate on the laptop', () => {
    expect(text).toContain('pm_id');
    expect(text).toMatch(/exec "\$TSX"/);
    expect(text).toContain('caffeinate -dis');
    expect(text).toContain('server exited, restarting in 1s');
  });
});

describe('deploy-vps.sh', () => {
  const text = read(deployPath);

  test.each([
    'node_modules',
    'data',
    '.env',
    'contracts/out',
    'contracts/cache',
    '.git',
    'contracts/lib',
    'contracts/broadcast',
    '.coord',
    '.superpowers',
    '.claude',
    '.remember',
    'marketing',
  ])('rsync excludes %s', (entry) => {
    expect(text).toMatch(new RegExp(`--exclude[= ]'?/?${entry.replace(/[./]/g, '\\$&')}'?(\\s|\\\\|$)`, 'm'));
  });

  test('contains the required remote commands and values', () => {
    for (const needle of [
      '--frozen-lockfile',
      'pnpm@12.10.1',
      '--filter server...',
      'pm2 save',
      'PORT=8090',
      '--name nadgacha',
      'rsync -az --delete',
      '0xAlvary3',
      'nadgacha.43-134-58-217.sslip.io',
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  test('never uses destructive or broad pm2/rsync operations', () => {
    expect(text).not.toContain('--delete-excluded');
    expect(text).not.toMatch(/pm2 (delete|kill|update)/);
    expect(text).not.toMatch(/pm2 \w+ all\b/);
    expect(text).not.toMatch(/ all\b/);
  });

  test('installs through the pinned pnpm via npx, never the global one', () => {
    expect(text).toContain('npx -y pnpm@12.10.1');
  });
});
