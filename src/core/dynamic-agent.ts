/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Dynamic agent creation for inbound Feishu users.
 *
 * When enabled, creates a unique agent instance with its own workspace
 * for each new DM user, providing per-user session and workspace isolation.
 *
 * Adapted from the built-in feishu channel implementation
 * (extensions/feishu/src/dynamic-agent.ts).
 *
 * Hardened over upstream:
 *   - Process-level mutex serializes concurrent creations across chats.
 *   - Read-modify-write: re-read latest cfg inside the lock to avoid lost updates.
 *   - writeConfigFile retries with exponential backoff.
 *   - Structured result (status) instead of throwing — caller decides fail-closed.
 *
 * Per-user agent behavior is defined via `agents.defaults.systemPromptOverride`
 * (and friends) — this module only manages cfg.agents.list / cfg.bindings /
 * workspace + agentDir directory creation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import type { DynamicAgentCreationConfig } from '../messaging/types';
export type { DynamicAgentCreationConfig } from '../messaging/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DynamicAgentStatus =
  | 'created' // 全新创建 agent + workspace + binding
  | 'binding_added' // agent 已存在,只补了 binding
  | 'already_bound' // 已经有 binding,无需操作(理论上不会进入,保留兼容)
  | 'max_agents_reached' // 已到上限
  | 'failed'; // 任意一步失败

export interface MaybeCreateDynamicAgentResult {
  status: DynamicAgentStatus;
  /** 仅 created/binding_added/already_bound 时为最新 cfg；其它情况返回入参 cfg。 */
  updatedCfg: ClawdbotConfig;
  agentId?: string;
  error?: Error;
  /** @deprecated 请使用 status 判断；保留以兼容旧调用方。 */
  created: boolean;
}

// ---------------------------------------------------------------------------
// Process-level mutex
// ---------------------------------------------------------------------------

const mutexChain = new Map<string, Promise<unknown>>();

/**
 * Serialize executions sharing the same key. Returns the result of `fn`.
 * Subsequent waiters always observe the side-effects of earlier ones,
 * including the latest config snapshot from disk.
 */
async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexChain.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of prior outcome
  mutexChain.set(
    key,
    next.catch(() => undefined),
  );
  try {
    return await next;
  } finally {
    if (mutexChain.get(key) === next.catch(() => undefined)) {
      // best-effort cleanup; the above identity check is intentionally loose
      // because .catch wraps next — leaving the entry is harmless.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a dynamic agent should be created for a DM user and create it
 * if needed.  Concurrent calls are serialized internally.
 */
export async function maybeCreateDynamicAgent(params: {
  cfg: ClawdbotConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  dynamicCfg: DynamicAgentCreationConfig;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  // 串行 key 用 'feishu-dynamic-agent' 全局单锁:
  //   - cfg.agents.list 是单一全局集合,任何 account 的并发创建都会写到同一个文件
  //   - maxAgents 是全局计数,必须在锁内统一判定
  return withMutex('feishu-dynamic-agent', () => createUnderLock(params));
}

async function createUnderLock(params: {
  cfg: ClawdbotConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  dynamicCfg: DynamicAgentCreationConfig;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { runtime, senderOpenId, dynamicCfg, log } = params;

  // 锁内重新读取最新 cfg,避免 lost-update。
  // loadConfig() 是同步快照,反映上一个写入者的最新状态。
  let latestCfg: ClawdbotConfig;
  try {
    latestCfg = runtime.config.loadConfig() as ClawdbotConfig;
  } catch (err) {
    log(`feishu: dynamic-agent failed to load latest config: ${String(err)}`);
    return failed(params.cfg, err);
  }

  const existingBindings = latestCfg.bindings ?? [];
  const hasBinding = existingBindings.some(
    (b) => b.match?.channel === 'feishu' && b.match?.peer?.kind === 'direct' && b.match?.peer?.id === senderOpenId,
  );

  if (hasBinding) {
    return { status: 'already_bound', updatedCfg: latestCfg, created: false };
  }

  if (dynamicCfg.maxAgents !== undefined) {
    const feishuAgentCount = (latestCfg.agents?.list ?? []).filter((a) => a.id.startsWith('feishu-')).length;
    if (feishuAgentCount >= dynamicCfg.maxAgents) {
      log(`feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`);
      return { status: 'max_agents_reached', updatedCfg: latestCfg, created: false };
    }
  }

  const agentId = `feishu-${senderOpenId}`;
  const existingAgent = (latestCfg.agents?.list ?? []).find((a) => a.id === agentId);

  // ---- Path 1: agent 已存在,只补 binding ----
  if (existingAgent) {
    log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);
    const updatedCfg: ClawdbotConfig = {
      ...latestCfg,
      bindings: [
        ...existingBindings,
        {
          agentId,
          match: { channel: 'feishu', peer: { kind: 'direct', id: senderOpenId } },
        },
      ],
    };
    try {
      await writeConfigWithRetry(runtime, updatedCfg, log);
    } catch (err) {
      log(`feishu: failed to persist binding for "${agentId}": ${String(err)}`);
      return failed(latestCfg, err);
    }
    return { status: 'binding_added', updatedCfg, agentId, created: true };
  }

  // ---- Path 2: 全新创建 ----
  const workspaceTemplate = dynamicCfg.workspaceTemplate ?? '~/.openclaw/workspace-{agentId}';
  const agentDirTemplate = dynamicCfg.agentDirTemplate ?? '~/.openclaw/agents/{agentId}/agent';
  const workspace = resolveUserPath(workspaceTemplate.replace('{userId}', senderOpenId).replace('{agentId}', agentId));
  const agentDir = resolveUserPath(agentDirTemplate.replace('{userId}', senderOpenId).replace('{agentId}', agentId));

  log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
  log(`  workspace: ${workspace}`);
  log(`  agentDir: ${agentDir}`);

  // (1) 创建目录 — 失败则中止
  try {
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.mkdir(agentDir, { recursive: true });
  } catch (err) {
    log(`feishu: mkdir failed for "${agentId}": ${String(err)}`);
    return failed(latestCfg, err);
  }

  // (2) 写 cfg — 这是"创建成功"的判定标准。
  const updatedCfg: ClawdbotConfig = {
    ...latestCfg,
    agents: {
      ...latestCfg.agents,
      list: [...(latestCfg.agents?.list ?? []), { id: agentId, workspace, agentDir }],
    },
    bindings: [
      ...existingBindings,
      {
        agentId,
        match: { channel: 'feishu', peer: { kind: 'direct', id: senderOpenId } },
      },
    ],
  };

  try {
    await writeConfigWithRetry(runtime, updatedCfg, log);
  } catch (err) {
    log(`feishu: writeConfigFile failed for "${agentId}": ${String(err)}`);
    return failed(latestCfg, err);
  }

  return { status: 'created', updatedCfg, agentId, created: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function writeConfigWithRetry(
  runtime: PluginRuntime,
  cfg: ClawdbotConfig,
  log: (msg: string) => void,
): Promise<void> {
  const delays = [0, 50, 200]; // 3 attempts: immediate, +50ms, +200ms
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      await runtime.config.writeConfigFile(cfg);
      if (i > 0) log(`feishu: writeConfigFile succeeded on attempt ${i + 1}`);
      return;
    } catch (err) {
      lastErr = err;
      log(`feishu: writeConfigFile attempt ${i + 1} failed: ${String(err)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failed(cfg: ClawdbotConfig, err: unknown): MaybeCreateDynamicAgentResult {
  return {
    status: 'failed',
    updatedCfg: cfg,
    error: err instanceof Error ? err : new Error(String(err)),
    created: false,
  };
}

/** Resolve a path that may start with ~ to the user's home directory. */
function resolveUserPath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
