#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises';

const RESTORE_MARKER_PREFIX = '<!-- restored-pr-comment ';
const VISIBLE_METADATA_START = '<!-- restored-pr-comment-visible-start -->';
const VISIBLE_METADATA_END = '<!-- restored-pr-comment-visible-end -->';
const PAGE_SIZE = 100;

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getOptionalInput(name, fallback = '') {
  return process.env[name] ?? fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'restore-outdated-pr-comments-action'
  };
}

async function githubRequest({ apiUrl, token, method = 'GET', pathname, body }) {
  const response = await fetch(`${apiUrl}${pathname}`, {
    method,
    headers: githubHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${method} ${pathname} failed with ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function githubGraphql({ graphqlUrl, token, query, variables }) {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST /graphql failed with ${response.status}: ${text}`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }

  return payload.data;
}

export async function resolveRuntimeContext() {
  const token = getRequiredEnv('GITHUB_TOKEN');
  const apiUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL
    ?? (apiUrl.endsWith('/api/v3') ? `${apiUrl.slice(0, -7)}/api/graphql` : `${apiUrl}/graphql`);
  const repositoryOverride = getOptionalInput('INPUT_REPOSITORY');
  const repositoryValue = repositoryOverride || getRequiredEnv('GITHUB_REPOSITORY');
  const [owner, repo] = repositoryValue.split('/');

  if (!owner || !repo) {
    throw new Error(`Unable to resolve repository from "${repositoryValue}"`);
  }

  const eventPath = getRequiredEnv('GITHUB_EVENT_PATH');
  const eventPayload = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequestNumberOverride = getOptionalInput('INPUT_PULL_REQUEST_NUMBER');
  const pullNumber = pullRequestNumberOverride
    ? Number.parseInt(pullRequestNumberOverride, 10)
    : eventPayload.pull_request?.number;

  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new Error(
      'Unable to resolve the pull request number. Use this action from a pull_request event or pass pull-request-number.'
    );
  }

  return {
    token,
    apiUrl,
    graphqlUrl,
    owner,
    repo,
    pullNumber,
    locale: getOptionalInput('INPUT_LOCALE', 'en-US'),
    timeZone: getOptionalInput('INPUT_TIME_ZONE', 'UTC'),
    includeDiffContext: parseBoolean(getOptionalInput('INPUT_INCLUDE_DIFF_CONTEXT', 'true'), true)
  };
}

export function extractVisibleDiffLines(patch) {
  const visibleLines = {
    LEFT: new Set(),
    RIGHT: new Set()
  };

  if (!patch) {
    return visibleLines;
  }

  let leftLine = null;
  let rightLine = null;

  for (const patchLine of String(patch).split('\n')) {
    if (patchLine.startsWith('@@')) {
      const match = patchLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      leftLine = match ? Number.parseInt(match[1], 10) : null;
      rightLine = match ? Number.parseInt(match[2], 10) : null;
      continue;
    }

    if (leftLine === null || rightLine === null || patchLine.startsWith('\\')) {
      continue;
    }

    const prefix = patchLine[0];

    if (prefix === ' ') {
      visibleLines.LEFT.add(leftLine);
      visibleLines.RIGHT.add(rightLine);
      leftLine += 1;
      rightLine += 1;
      continue;
    }

    if (prefix === '-') {
      visibleLines.LEFT.add(leftLine);
      leftLine += 1;
      continue;
    }

    if (prefix === '+') {
      visibleLines.RIGHT.add(rightLine);
      rightLine += 1;
    }
  }

  return visibleLines;
}

export function extractDiffPositions(patch) {
  const positions = {
    LEFT: new Map(),
    RIGHT: new Map()
  };

  if (!patch) {
    return positions;
  }

  let leftLine = null;
  let rightLine = null;
  let position = 0;

  for (const patchLine of String(patch).split('\n')) {
    if (patchLine.startsWith('@@')) {
      const match = patchLine.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      leftLine = match ? Number.parseInt(match[1], 10) : null;
      rightLine = match ? Number.parseInt(match[2], 10) : null;
      continue;
    }

    if (leftLine === null || rightLine === null || patchLine.startsWith('\\')) {
      continue;
    }

    position += 1;
    const prefix = patchLine[0];

    if (prefix === ' ') {
      positions.LEFT.set(leftLine, position);
      positions.RIGHT.set(rightLine, position);
      leftLine += 1;
      rightLine += 1;
      continue;
    }

    if (prefix === '-') {
      positions.LEFT.set(leftLine, position);
      leftLine += 1;
      continue;
    }

    if (prefix === '+') {
      positions.RIGHT.set(rightLine, position);
      rightLine += 1;
    }
  }

  return positions;
}

function normalizeSide(side) {
  return side === 'LEFT' ? 'LEFT' : 'RIGHT';
}

function stripVisibleMetadata(body) {
  return String(body ?? '')
    .replace(
      new RegExp(`${VISIBLE_METADATA_START}[\\s\\S]*?${VISIBLE_METADATA_END}\\n*`, 'g'),
      ''
    )
    .trimStart();
}

function formatOriginalTimestamp(value, locale, timeZone) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone
  }).format(date);
}

function buildVisibleMetadataBlock(metadata = {}, options = {}) {
  const author = metadata.author ? `@${metadata.author}` : 'unknown';
  const timestamp = formatOriginalTimestamp(metadata.createdAt, options.locale, options.timeZone);
  const header = timestamp
    ? `_Originally by ${author} on ${timestamp}_`
    : `_Originally by ${author}_`;

  const lines = [VISIBLE_METADATA_START, header];

  if (metadata.url) {
    lines.push('', `[Open original comment](${metadata.url})`);
  }

  if (options.includeDiffContext && metadata.diffHunk) {
    lines.push(
      '',
      '<details>',
      '<summary>Original diff context</summary>',
      '',
      '```diff',
      metadata.diffHunk.trimEnd(),
      '```',
      '</details>'
    );
  }

  lines.push(VISIBLE_METADATA_END, '');
  return lines.join('\n');
}

function buildDisplayedBody(body, metadata = {}, options = {}) {
  const rawBody = stripVisibleMetadata(body);
  const visibleMetadata = buildVisibleMetadataBlock(metadata, options);
  return `${visibleMetadata}\n${rawBody}`;
}

export function unwrapRestoredBody(body, fallbackMetadata = {}) {
  const rawBody = String(body ?? '');
  const match = rawBody.match(/^<!-- restored-pr-comment ([A-Za-z0-9_-]+) -->\n?/);

  if (!match) {
    return {
      body: stripVisibleMetadata(rawBody),
      metadata: {
        author: fallbackMetadata.author ?? null,
        createdAt: fallbackMetadata.createdAt ?? null,
        url: fallbackMetadata.url ?? null,
        diffHunk: fallbackMetadata.diffHunk ?? null
      }
    };
  }

  let parsedMetadata = {};
  try {
    parsedMetadata = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    parsedMetadata = {};
  }

  return {
    body: stripVisibleMetadata(rawBody.slice(match[0].length)),
    metadata: {
      author: parsedMetadata.author ?? fallbackMetadata.author ?? null,
      createdAt: parsedMetadata.createdAt ?? fallbackMetadata.createdAt ?? null,
      url: parsedMetadata.url ?? fallbackMetadata.url ?? null,
      diffHunk: parsedMetadata.diffHunk ?? fallbackMetadata.diffHunk ?? null
    }
  };
}

export function wrapRestoredBody(body, metadata = {}) {
  const encodedMetadata = Buffer.from(
    JSON.stringify({
      author: metadata.author ?? null,
      createdAt: metadata.createdAt ?? null,
      url: metadata.url ?? null,
      diffHunk: metadata.diffHunk ?? null
    }),
    'utf8'
  ).toString('base64url');

  return `${RESTORE_MARKER_PREFIX}${encodedMetadata} -->\n${String(body ?? '')}`;
}

function normalizeComment(comment) {
  const unwrapped = unwrapRestoredBody(comment.body, {
    author: comment.author?.login ?? null,
    createdAt: comment.createdAt ?? null,
    url: comment.url ?? null,
    diffHunk: comment.diffHunk ?? null
  });

  return {
    ...comment,
    body: unwrapped.body,
    originalAuthor: unwrapped.metadata.author,
    originalCreatedAt: unwrapped.metadata.createdAt,
    originalUrl: unwrapped.metadata.url,
    originalDiffHunk: unwrapped.metadata.diffHunk
  };
}

function compareComments(left, right) {
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

export function resolveThreadAnchor(thread, file) {
  if (!thread?.path || !file) {
    return null;
  }

  const side = normalizeSide(thread.diffSide);
  const line = Number.isInteger(thread.line)
    ? thread.line
    : Number.isInteger(thread.originalLine)
      ? thread.originalLine
      : null;

  if (!Number.isInteger(line)) {
    return null;
  }

  if (!file.visibleLines[side]?.has(line)) {
    return null;
  }

  const position = file.diffPositions?.[side]?.get(line) ?? null;
  if (!Number.isInteger(position)) {
    return null;
  }

  return {
    path: file.filename ?? thread.path,
    position
  };
}

async function fetchPullRequest({ apiUrl, token, owner, repo, pullNumber }) {
  return githubRequest({
    apiUrl,
    token,
    pathname: `/repos/${owner}/${repo}/pulls/${pullNumber}`
  });
}

async function fetchPullFiles({ apiUrl, token, owner, repo, pullNumber }) {
  const files = [];

  for (let page = 1; ; page += 1) {
    const currentPage = await githubRequest({
      apiUrl,
      token,
      pathname: `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=${PAGE_SIZE}&page=${page}`
    });

    files.push(...currentPage);
    if (currentPage.length < PAGE_SIZE) {
      return files;
    }
  }
}

const REVIEW_THREADS_QUERY = `
  query ReviewThreads($owner: String!, $repo: String!, $pullNumber: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullNumber) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isOutdated
            path
            line
            originalLine
            diffSide
            comments(first: 100) {
              nodes {
                databaseId
                body
                createdAt
                url
                diffHunk
                isMinimized
                author {
                  login
                }
                replyTo {
                  databaseId
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

const THREAD_COMMENTS_QUERY = `
  query ThreadComments($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          nodes {
            databaseId
            body
            createdAt
            url
            diffHunk
            isMinimized
            author {
              login
            }
            replyTo {
              databaseId
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

async function fetchAllReviewThreads({ graphqlUrl, token, owner, repo, pullNumber }) {
  const threads = [];

  for (let after = null; ; ) {
    const data = await githubGraphql({
      graphqlUrl,
      token,
      query: REVIEW_THREADS_QUERY,
      variables: {
        owner,
        repo,
        pullNumber,
        after
      }
    });

    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection) {
      return threads;
    }

    threads.push(...(connection.nodes ?? []));

    if (!connection.pageInfo?.hasNextPage) {
      return threads;
    }

    after = connection.pageInfo.endCursor;
  }
}

async function fetchAllThreadComments({ graphqlUrl, token, thread }) {
  const initialConnection = thread.comments ?? { nodes: [], pageInfo: { hasNextPage: false } };
  const comments = [...(initialConnection.nodes ?? [])];

  if (!initialConnection.pageInfo?.hasNextPage) {
    return comments;
  }

  let after = initialConnection.pageInfo.endCursor;
  while (after) {
    const data = await githubGraphql({
      graphqlUrl,
      token,
      query: THREAD_COMMENTS_QUERY,
      variables: {
        threadId: thread.id,
        after
      }
    });

    const connection = data.node?.comments;
    if (!connection) {
      return comments;
    }

    comments.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  }

  return comments;
}

async function createReviewComment({ apiUrl, token, owner, repo, pullNumber, body, anchor, commitId }) {
  return githubRequest({
    apiUrl,
    token,
    method: 'POST',
    pathname: `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
    body: {
      commit_id: commitId,
      body,
      ...anchor
    }
  });
}

async function createReviewReply({ apiUrl, token, owner, repo, pullNumber, commentId, body }) {
  return githubRequest({
    apiUrl,
    token,
    method: 'POST',
    pathname: `/repos/${owner}/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`,
    body: { body }
  });
}

async function deleteReviewComment({ apiUrl, token, owner, repo, commentId }) {
  await githubRequest({
    apiUrl,
    token,
    method: 'DELETE',
    pathname: `/repos/${owner}/${repo}/pulls/comments/${commentId}`
  });
}

function buildThreadComments(comments) {
  const orderedComments = comments
    .filter((comment) => Number.isInteger(comment.databaseId) && !comment.isMinimized)
    .map(normalizeComment)
    .sort(compareComments);

  const rootComment = orderedComments.find((comment) => comment.replyTo?.databaseId == null) ?? orderedComments[0] ?? null;
  if (!rootComment) {
    return null;
  }

  const replies = orderedComments.filter((comment) => comment.databaseId !== rootComment.databaseId);
  return {
    rootComment,
    replies,
    allComments: orderedComments
  };
}

async function migrateThread({
  apiUrl,
  token,
  owner,
  repo,
  pullNumber,
  commitId,
  anchor,
  threadComments,
  displayOptions
}) {
  const createdCommentIds = [];
  let newRootCommentId = null;

  try {
    const rootMetadata = {
      author: threadComments.rootComment.originalAuthor,
      createdAt: threadComments.rootComment.originalCreatedAt,
      url: threadComments.rootComment.originalUrl,
      diffHunk: threadComments.rootComment.originalDiffHunk
    };

    const createdRoot = await createReviewComment({
      apiUrl,
      token,
      owner,
      repo,
      pullNumber,
      commitId,
      anchor,
      body: wrapRestoredBody(
        buildDisplayedBody(threadComments.rootComment.body, rootMetadata, {
          ...displayOptions,
          includeDiffContext: displayOptions.includeDiffContext
        }),
        rootMetadata
      )
    });

    newRootCommentId = createdRoot.id;
    createdCommentIds.push(createdRoot.id);

    for (const reply of threadComments.replies) {
      const replyMetadata = {
        author: reply.originalAuthor,
        createdAt: reply.originalCreatedAt,
        url: reply.originalUrl,
        diffHunk: reply.originalDiffHunk
      };

      const createdReply = await createReviewReply({
        apiUrl,
        token,
        owner,
        repo,
        pullNumber,
        commentId: newRootCommentId,
        body: wrapRestoredBody(
          buildDisplayedBody(reply.body, replyMetadata, {
            ...displayOptions,
            includeDiffContext: false
          }),
          replyMetadata
        )
      });

      createdCommentIds.push(createdReply.id);
    }
  } catch (error) {
    for (const commentId of createdCommentIds.slice().reverse()) {
      try {
        await deleteReviewComment({ apiUrl, token, owner, repo, commentId });
      } catch (cleanupError) {
        console.warn(`Failed to clean up partially created comment ${commentId}: ${cleanupError.message}`);
      }
    }

    throw error;
  }

  for (const comment of threadComments.allComments.slice().reverse()) {
    await deleteReviewComment({
      apiUrl,
      token,
      owner,
      repo,
      commentId: comment.databaseId
    });
  }
}

function buildSummaryLines(summary) {
  return [
    '### Outdated PR Review Comment Restore',
    '',
    `Scanned outdated threads: ${summary.scannedThreads}`,
    `Migrated threads: ${summary.migratedThreads}`,
    `Skipped threads (not anchorable on current diff): ${summary.skippedThreads}`,
    `Failed migrations: ${summary.failedThreads}`,
    `Recreated comments: ${summary.recreatedComments}`,
    `Deleted outdated comments: ${summary.deletedComments}`
  ];
}

async function writeStepSummary(summary) {
  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!stepSummaryPath) {
    return;
  }

  await appendFile(stepSummaryPath, `${buildSummaryLines(summary).join('\n')}\n`);
}

export async function main() {
  const runtime = await resolveRuntimeContext();
  const pullRequest = await fetchPullRequest(runtime);
  const pullFiles = await fetchPullFiles(runtime);
  const filesByPath = new Map();

  for (const file of pullFiles) {
    const mappedFile = {
      filename: file.filename,
      visibleLines: extractVisibleDiffLines(file.patch ?? ''),
      diffPositions: extractDiffPositions(file.patch ?? '')
    };

    filesByPath.set(file.filename, mappedFile);
    if (file.previous_filename) {
      filesByPath.set(file.previous_filename, mappedFile);
    }
  }

  const reviewThreads = await fetchAllReviewThreads(runtime);
  const outdatedThreads = reviewThreads.filter((thread) => thread.isOutdated);

  const summary = {
    scannedThreads: outdatedThreads.length,
    migratedThreads: 0,
    skippedThreads: 0,
    failedThreads: 0,
    recreatedComments: 0,
    deletedComments: 0
  };

  for (const thread of outdatedThreads) {
    const file = filesByPath.get(thread.path);
    const anchor = resolveThreadAnchor(thread, file);

    if (!anchor) {
      summary.skippedThreads += 1;
      continue;
    }

    const comments = await fetchAllThreadComments({ graphqlUrl: runtime.graphqlUrl, token: runtime.token, thread });
    const threadComments = buildThreadComments(comments);

    if (!threadComments) {
      summary.skippedThreads += 1;
      continue;
    }

    try {
      await migrateThread({
        apiUrl: runtime.apiUrl,
        token: runtime.token,
        owner: runtime.owner,
        repo: runtime.repo,
        pullNumber: runtime.pullNumber,
        commitId: pullRequest.head.sha,
        anchor,
        threadComments,
        displayOptions: {
          locale: runtime.locale,
          timeZone: runtime.timeZone,
          includeDiffContext: runtime.includeDiffContext
        }
      });

      summary.migratedThreads += 1;
      summary.recreatedComments += threadComments.allComments.length;
      summary.deletedComments += threadComments.allComments.length;
    } catch (error) {
      summary.failedThreads += 1;
      console.warn(`Failed to migrate outdated thread on ${thread.path}:${anchor.position} (${thread.id}): ${error.message}`);
    }
  }

  console.log(buildSummaryLines(summary).join('\n'));
  await writeStepSummary(summary);
}

const invokedPath = process.argv[1];

if (invokedPath && invokedPath.endsWith('/src/index.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
