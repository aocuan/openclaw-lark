import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
const fromRoot = (relativePath) => pathToFileURL(path.join(rootDir, relativePath)).href;

const distDir = 'dist/src';
const rawModulePath = path.join(rootDir, `${distDir}/card/builder.js`);
const testableModulePath = path.join(rootDir, 'test/.tmp/builder.footer-runtime.testable.mjs');
fs.mkdirSync(path.dirname(testableModulePath), { recursive: true });
fs.writeFileSync(
  testableModulePath,
  fs
    .readFileSync(rawModulePath, 'utf8')
    .replaceAll("'./markdown-style'", `'${fromRoot(`${distDir}/card/markdown-style.js`)}'`)
    .replaceAll("'./reply-dispatcher-types'", `'${fromRoot(`${distDir}/card/reply-dispatcher-types.js`)}'`),
  'utf8',
);
const moduleUnderTest = pathToFileURL(testableModulePath).href;

const { compactNumber, formatFooterRuntimeSegments } = await import(
  `${moduleUnderTest}?case=${Date.now()}-${Math.random()}`
);

test('compactNumber formats values across ranges', () => {
  assert.equal(compactNumber(0), '0');
  assert.equal(compactNumber(999), '999');
  assert.equal(compactNumber(1000), '1.0k');
  assert.equal(compactNumber(1250), '1.3k');
  assert.equal(compactNumber(100_000), '100k');
  assert.equal(compactNumber(1_000_000), '1.0m');
  assert.equal(compactNumber(123_456_789), '123m');
});

test('formatFooterRuntimeSegments renders configured runtime metrics', () => {
  const result = formatFooterRuntimeSegments({
    footer: {
      status: true,
      elapsed: true,
      tokens: true,
      cache: true,
      context: true,
      model: true,
    },
    elapsedMs: 12_300,
    metrics: {
      inputTokens: 1200,
      outputTokens: 3500,
      cacheRead: 800,
      cacheWrite: 200,
      totalTokens: 4500,
      totalTokensFresh: true,
      contextTokens: 128000,
      model: 'claude-opus-4-6',
    },
  });

  assert.deepEqual(result.zh, [
    '已完成',
    '耗时 12.3s',
    '↑ 1.2k ↓ 3.5k',
    '缓存 800/200 (36%)',
    '上下文 4.5k/128k (4%)',
    'claude-opus-4-6',
  ]);

  assert.deepEqual(result.en, [
    'Completed',
    'Elapsed 12.3s',
    '↑ 1.2k ↓ 3.5k',
    'Cache 800/200 (36%)',
    'Context 4.5k/128k (4%)',
    'claude-opus-4-6',
  ]);
});

test('formatFooterRuntimeSegments respects missing metrics and status variants', () => {
  const stopped = formatFooterRuntimeSegments({
    footer: { status: true, tokens: true, cache: true, context: true, model: true },
    isAborted: true,
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      totalTokensFresh: false,
      contextTokens: 4096,
      model: ' ',
    },
  });

  assert.deepEqual(stopped.zh, ['已停止', '↑ 100 ↓ 50']);
  assert.deepEqual(stopped.en, ['Stopped', '↑ 100 ↓ 50']);

  const errored = formatFooterRuntimeSegments({
    footer: { status: true, elapsed: true },
    elapsedMs: 1000,
    isError: true,
  });

  assert.deepEqual(errored.zh, ['出错', '耗时 1.0s']);
  assert.deepEqual(errored.en, ['Error', 'Elapsed 1.0s']);
});
