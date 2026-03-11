import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractDiffPositions,
  extractVisibleDiffLines,
  resolveRuntimeContext,
  resolveThreadAnchor,
  unwrapRestoredBody,
  wrapRestoredBody
} from '../src/index.mjs';

test('extractVisibleDiffLines tracks both left and right diff coordinates', () => {
  const patch = [
    '@@ -10,4 +10,5 @@',
    ' context line',
    '-removed line',
    '+added line',
    ' another context line'
  ].join('\n');

  const visibleLines = extractVisibleDiffLines(patch);

  assert.deepEqual([...visibleLines.LEFT], [10, 11, 12]);
  assert.deepEqual([...visibleLines.RIGHT], [10, 11, 12]);
});

test('extractDiffPositions maps visible diff lines to diff positions', () => {
  const patch = [
    '@@ -10,4 +10,5 @@',
    ' context line',
    '-removed line',
    '+added line',
    ' another context line'
  ].join('\n');

  const positions = extractDiffPositions(patch);

  assert.equal(positions.LEFT.get(10), 1);
  assert.equal(positions.LEFT.get(11), 2);
  assert.equal(positions.LEFT.get(12), 4);
  assert.equal(positions.RIGHT.get(10), 1);
  assert.equal(positions.RIGHT.get(11), 3);
  assert.equal(positions.RIGHT.get(12), 4);
});

test('resolveThreadAnchor returns a position anchor when visible', () => {
  const anchor = resolveThreadAnchor(
    {
      path: 'src/example.ts',
      line: 42,
      originalLine: 41,
      diffSide: 'RIGHT'
    },
    {
      filename: 'src/example.ts',
      visibleLines: {
        LEFT: new Set([41]),
        RIGHT: new Set([42])
      },
      diffPositions: {
        LEFT: new Map([[41, 4]]),
        RIGHT: new Map([[42, 5]])
      }
    }
  );

  assert.deepEqual(anchor, {
    path: 'src/example.ts',
    position: 5
  });
});

test('resolveThreadAnchor falls back to original line when needed', () => {
  const anchor = resolveThreadAnchor(
    {
      path: 'src/example.ts',
      line: null,
      originalLine: 18,
      diffSide: 'LEFT'
    },
    {
      filename: 'src/example.ts',
      visibleLines: {
        LEFT: new Set([18]),
        RIGHT: new Set()
      },
      diffPositions: {
        LEFT: new Map([[18, 4]]),
        RIGHT: new Map()
      }
    }
  );

  assert.deepEqual(anchor, {
    path: 'src/example.ts',
    position: 4
  });
});

test('resolveThreadAnchor uses the current filename when the file was renamed', () => {
  const anchor = resolveThreadAnchor(
    {
      path: 'src/old-name.ts',
      line: 25,
      originalLine: 25,
      diffSide: 'RIGHT'
    },
    {
      filename: 'src/new-name.ts',
      visibleLines: {
        LEFT: new Set(),
        RIGHT: new Set([25])
      },
      diffPositions: {
        LEFT: new Map(),
        RIGHT: new Map([[25, 7]])
      }
    }
  );

  assert.deepEqual(anchor, {
    path: 'src/new-name.ts',
    position: 7
  });
});

test('wrapRestoredBody preserves raw content and unwrapRestoredBody removes the visible metadata block', () => {
  const wrappedBody = wrapRestoredBody(
    [
      '<!-- restored-pr-comment-visible-start -->',
      '_Originally by @octocat on Mar 11, 2026, 10:15 AM_',
      '',
      '[Open original comment](https://github.com/example)',
      '',
      '<details>',
      '<summary>Original diff context</summary>',
      '',
      '```diff',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '```',
      '</details>',
      '<!-- restored-pr-comment-visible-end -->',
      '',
      'Original review body'
    ].join('\n'),
    {
      author: 'octocat',
      createdAt: '2026-03-11T10:15:00Z',
      url: 'https://github.com/example',
      diffHunk: '@@ -1 +1 @@\n-old\n+new'
    }
  );

  const unwrappedBody = unwrapRestoredBody(wrappedBody, {
    author: 'github-actions[bot]',
    createdAt: '2026-03-11T11:00:00Z',
    url: 'https://github.com/fallback',
    diffHunk: '@@ fallback @@'
  });

  assert.equal(unwrappedBody.body, 'Original review body');
  assert.deepEqual(unwrappedBody.metadata, {
    author: 'octocat',
    createdAt: '2026-03-11T10:15:00Z',
    url: 'https://github.com/example',
    diffHunk: '@@ -1 +1 @@\n-old\n+new'
  });
});

test('resolveRuntimeContext uses repository and pull request overrides', async () => {
  const previousEnv = { ...process.env };

  try {
    process.env.GITHUB_TOKEN = 'token';
    process.env.GITHUB_REPOSITORY = 'fallback/repo';
    process.env.GITHUB_EVENT_PATH = new URL('./fixtures/pull_request_event.json', import.meta.url).pathname;
    process.env.INPUT_REPOSITORY = 'custom/repo';
    process.env.INPUT_PULL_REQUEST_NUMBER = '42';
    process.env.INPUT_LOCALE = 'en-GB';
    process.env.INPUT_TIME_ZONE = 'Europe/London';
    process.env.INPUT_INCLUDE_DIFF_CONTEXT = 'false';

    const runtime = await resolveRuntimeContext();

    assert.deepEqual(runtime, {
      token: 'token',
      apiUrl: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      owner: 'custom',
      repo: 'repo',
      pullNumber: 42,
      locale: 'en-GB',
      timeZone: 'Europe/London',
      includeDiffContext: false
    });
  } finally {
    process.env = previousEnv;
  }
});
