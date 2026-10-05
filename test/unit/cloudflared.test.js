/**
 * Unit tests for cloudflared lookup and asset selection on every platform.
 *
 * Set CF_DOWNLOAD=1 to also download and run the real build for this machine (CI does).
 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');
const { assetFor, binaryName, findCloudflared, installCloudflared, systemCandidates } = require('../../lib/cloudflared');

const exists = (files) => (file) => files.includes(file);

test('picks the right release asset per platform', () => {
	const cases = [
		['darwin', 'arm64', 'cloudflared-darwin-arm64.tgz', true],
		['darwin', 'x64', 'cloudflared-darwin-amd64.tgz', true],
		['win32', 'x64', 'cloudflared-windows-amd64.exe', false],
		['win32', 'arm64', 'cloudflared-windows-amd64.exe', false],
		['win32', 'ia32', 'cloudflared-windows-386.exe', false],
		['linux', 'x64', 'cloudflared-linux-amd64', false],
		['linux', 'arm64', 'cloudflared-linux-arm64', false],
		['linux', 'arm', 'cloudflared-linux-arm', false],
	];

	for (const [platform, arch, name, archive] of cases) {
		assert.deepStrictEqual(assetFor({ platform, arch }), { name, archive }, `${platform}/${arch}`);
	}

	assert.throws(() => assetFor({ platform: 'linux', arch: 'mips' }), /linux\/mips/);
	assert.throws(() => assetFor({ platform: 'freebsd', arch: 'x64' }), /freebsd/);
});

test('names the binary cloudflared.exe on Windows only', () => {
	assert.strictEqual(binaryName('win32'), 'cloudflared.exe');
	assert.strictEqual(binaryName('darwin'), 'cloudflared');
	assert.strictEqual(binaryName('linux'), 'cloudflared');
});

test('finds Homebrew on macOS even without it on PATH', () => {
	const target = { platform: 'darwin', arch: 'arm64', env: { PATH: '/usr/bin:/bin' } };

	assert.deepStrictEqual(findCloudflared(undefined, target, exists(['/opt/homebrew/bin/cloudflared'])), {
		path: '/opt/homebrew/bin/cloudflared',
		source: 'system',
	});
});

test('finds winget and Program Files installs on Windows', () => {
	const env = {
		LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
		ProgramFiles: 'C:\\Program Files',
		'ProgramFiles(x86)': 'C:\\Program Files (x86)',
	};
	const target = { platform: 'win32', arch: 'x64', env };

	assert.deepStrictEqual(systemCandidates(target), [
		'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe',
		'C:\\Program Files\\cloudflared\\cloudflared.exe',
		'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
	]);

	assert.strictEqual(
		findCloudflared(undefined, target, exists(['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'])).path,
		'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
	);
});

test('searches a Windows PATH (semicolons, "Path" key)', () => {
	const target = { platform: 'win32', arch: 'x64', env: { Path: 'C:\\Windows\\system32;C:\\tools\\bin' } };

	assert.strictEqual(findCloudflared(undefined, target, exists(['C:\\tools\\bin\\cloudflared.exe'])).path, 'C:\\tools\\bin\\cloudflared.exe');
});

test('finds package-manager installs on Linux', () => {
	const target = { platform: 'linux', arch: 'x64', env: { HOME: '/home/dev', PATH: '/usr/bin' } };

	assert.strictEqual(findCloudflared(undefined, target, exists(['/usr/bin/cloudflared'])).path, '/usr/bin/cloudflared');
	assert.strictEqual(findCloudflared(undefined, target, exists(['/home/dev/.local/bin/cloudflared'])).path, '/home/dev/.local/bin/cloudflared');
});

test('falls back to the managed copy, and prefers a system install over it', () => {
	const linux = { platform: 'linux', arch: 'x64', env: { PATH: '' } };
	const windows = { platform: 'win32', arch: 'x64', env: {} };

	assert.deepStrictEqual(findCloudflared('/data/cloudflared', linux, exists(['/data/cloudflared/cloudflared'])), {
		path: '/data/cloudflared/cloudflared',
		source: 'managed',
	});
	assert.strictEqual(
		findCloudflared('C:\\Data\\cloudflared', windows, exists(['C:\\Data\\cloudflared\\cloudflared.exe'])).path,
		'C:\\Data\\cloudflared\\cloudflared.exe'
	);
	assert.strictEqual(
		findCloudflared('/data/cloudflared', linux, exists(['/usr/bin/cloudflared', '/data/cloudflared/cloudflared'])).source,
		'system'
	);
	assert.strictEqual(findCloudflared('/data/cloudflared', linux, exists([])), null);
});

test('downloads, verifies and runs the real build for this machine', { skip: !process.env.CF_DOWNLOAD }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-managed-'));

	try {
		const installed = await installCloudflared(dir);
		assert.strictEqual(path.basename(installed.path), binaryName(process.platform));

		const version = execFileSync(installed.path, ['--version'], { encoding: 'utf8' });
		assert.match(version, new RegExp(`cloudflared version ${installed.version}`));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
