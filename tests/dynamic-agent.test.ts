/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * dynamic-agent 测试。
 *
 * 覆盖范围:
 *   1. 基本路径(全新创建 / 已绑 / agent存在补 binding / maxAgents)
 *   2. 失败路径(mkdir 失败 / writeConfigFile 失败 / 重试成功 / context 文件写失败)
 *   3. 并发(不同用户、同一用户)— 验证锁防止 lost-update
 *   4. read-modify-write — 锁内读到最新 cfg
 *   5. ensureAgentContextFile 补写
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeCreateDynamicAgent, writeConfigWithRetry } from '../src/core/dynamic-agent';
import type { DynamicAgentCreationConfig } from '../src/messaging/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockRuntime {
  runtime: PluginRuntime;
  writes: ClawdbotConfig[];
  getCurrent: () => ClawdbotConfig;
  setCurrent: (cfg: ClawdbotConfig) => void;
  /** 注入一次性的 write 失败,counter 为 0 时永远不失败 */
  failNextWrites: (count: number) => void;
  /** 注入永久性 write 失败 */
  failAllWrites: (err?: Error) => void;
  /** 在每次 write 之前回调,用于编排并发场景 */
  onBeforeWrite: ((cfg: ClawdbotConfig) => Promise<void> | void) | null;
}

function makeRuntime(initial: ClawdbotConfig): MockRuntime {
  let current = initial;
  const writes: ClawdbotConfig[] = [];
  let failCounter = 0;
  let failForever = false;
  let failError: Error | null = null;
  const ctx: MockRuntime = {
    runtime: {
      config: {
        loadConfig: () => current,
        writeConfigFile: async (cfg: ClawdbotConfig) => {
          if (ctx.onBeforeWrite) await ctx.onBeforeWrite(cfg);
          if (failForever || failCounter > 0) {
            if (failCounter > 0) failCounter--;
            throw failError ?? new Error('mock writeConfigFile failure');
          }
          writes.push(cfg);
          current = cfg;
        },
      },
    } as unknown as PluginRuntime,
    writes,
    getCurrent: () => current,
    setCurrent: (cfg: ClawdbotConfig) => {
      current = cfg;
    },
    failNextWrites: (count: number) => {
      failCounter = count;
      failForever = false;
    },
    failAllWrites: (err?: Error) => {
      failForever = true;
      failError = err ?? null;
    },
    onBeforeWrite: null,
  };
  return ctx;
}

function makeBaseCfg(): ClawdbotConfig {
  return {
    agents: { list: [{ id: 'default', workspace: '/tmp/default-ws', agentDir: '/tmp/default-ad' }] },
    bindings: [],
  } as unknown as ClawdbotConfig;
}

let tmpRoot: string;

function makeDynamicCfg(): DynamicAgentCreationConfig {
  return {
    enabled: true,
    workspaceTemplate: path.join(tmpRoot, 'workspace-{agentId}'),
    agentDirTemplate: path.join(tmpRoot, 'agents/{agentId}/agent'),
  };
}

const noop = (_msg: string): void => {
  /* swallow logs */
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-dyn-agent-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Basic paths
// ---------------------------------------------------------------------------

describe('maybeCreateDynamicAgent — basic paths', () => {
  it('creates a fresh agent + binding + workspace dirs', async () => {
    const env = makeRuntime(makeBaseCfg());
    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('created');
    expect(result.created).toBe(true);
    expect(result.agentId).toBe('feishu-ou_alice');

    const agents = result.updatedCfg.agents?.list ?? [];
    expect(agents.find((a) => a.id === 'feishu-ou_alice')).toBeDefined();

    const bindings = result.updatedCfg.bindings ?? [];
    expect(
      bindings.some(
        (b) =>
          b.match?.channel === 'feishu' &&
          b.match.peer?.kind === 'direct' &&
          b.match.peer.id === 'ou_alice',
      ),
    ).toBe(true);

    const agent = agents.find((a) => a.id === 'feishu-ou_alice')!;
    expect(agent.workspace).toBeDefined();
    expect(agent.agentDir).toBeDefined();
    const workspaceDir = agent.workspace!;
    const agentDir = agent.agentDir!;
    expect(fs.existsSync(workspaceDir)).toBe(true);
    expect(fs.existsSync(agentDir)).toBe(true);

    // agent-context.json marker is no longer written — identity is resolved
    // via cfg.bindings by the workspace-seed hook.
    const ctxPath = path.join(workspaceDir, '.openclaw', 'agent-context.json');
    expect(fs.existsSync(ctxPath)).toBe(false);

    expect(env.writes).toHaveLength(1);
  });

  it('returns already_bound when the user already has a binding (race recovery)', async () => {
    const cfg = makeBaseCfg();
    cfg.bindings = [
      { agentId: 'feishu-ou_alice', match: { channel: 'feishu', peer: { kind: 'direct', id: 'ou_alice' } } },
    ];
    const env = makeRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('already_bound');
    expect(result.created).toBe(false);
    expect(env.writes).toHaveLength(0);
  });

  it('returns binding_added when agent exists but binding was missing', async () => {
    const cfg = makeBaseCfg();
    cfg.agents = {
      list: [
        ...(cfg.agents?.list ?? []),
        { id: 'feishu-ou_alice', workspace: '/tmp/preexisting', agentDir: '/tmp/preexisting-ad' },
      ],
    };
    const env = makeRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('binding_added');
    expect(result.created).toBe(true);
    expect(result.agentId).toBe('feishu-ou_alice');
    expect(env.writes).toHaveLength(1);
    // 不应重复创建 workspace 目录
    expect(fs.existsSync('/tmp/preexisting')).toBe(false);
  });

  it('returns max_agents_reached when limit is hit', async () => {
    const cfg = makeBaseCfg();
    cfg.agents = {
      list: [
        ...(cfg.agents?.list ?? []),
        { id: 'feishu-ou_a', workspace: '/tmp/a', agentDir: '/tmp/a-ad' },
        { id: 'feishu-ou_b', workspace: '/tmp/b', agentDir: '/tmp/b-ad' },
      ],
    };
    const env = makeRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_carol',
      dynamicCfg: { ...makeDynamicCfg(), maxAgents: 2 },
      log: noop,
    });

    expect(result.status).toBe('max_agents_reached');
    expect(result.created).toBe(false);
    expect(env.writes).toHaveLength(0);
  });

  it('counts only feishu- prefixed agents toward maxAgents', async () => {
    const cfg = makeBaseCfg();
    cfg.agents = {
      list: [
        { id: 'default', workspace: '/tmp/x', agentDir: '/tmp/x-ad' },
        { id: 'other-channel-bot', workspace: '/tmp/y', agentDir: '/tmp/y-ad' },
      ],
    };
    const env = makeRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_first_feishu',
      dynamicCfg: { ...makeDynamicCfg(), maxAgents: 1 },
      log: noop,
    });

    expect(result.status).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// 2. Failure paths
// ---------------------------------------------------------------------------

describe('maybeCreateDynamicAgent — failures', () => {
  it('returns failed when mkdir throws', async () => {
    const env = makeRuntime(makeBaseCfg());
    const mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockRejectedValueOnce(new Error('EACCES: simulated'));

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeInstanceOf(Error);
    expect(env.writes).toHaveLength(0);

    mkdirSpy.mockRestore();
  });

  it('retries writeConfigFile up to 3 times', async () => {
    const env = makeRuntime(makeBaseCfg());
    env.failNextWrites(2); // first 2 attempts fail, 3rd succeeds

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('created');
    expect(env.writes).toHaveLength(1); // only the successful write counted
  });

  it('returns failed when all writeConfigFile attempts fail', async () => {
    const env = makeRuntime(makeBaseCfg());
    env.failAllWrites(new Error('disk full'));

    const result = await maybeCreateDynamicAgent({
      cfg: env.getCurrent(),
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('disk full');
  });

});

// ---------------------------------------------------------------------------
// 3. Concurrency — the bug we're fixing
// ---------------------------------------------------------------------------

describe('maybeCreateDynamicAgent — concurrency', () => {
  it('two distinct users started in parallel both end up persisted (no lost-update)', async () => {
    const env = makeRuntime(makeBaseCfg());

    const [r1, r2] = await Promise.all([
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_alice',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_bob',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
    ]);

    expect(r1.status).toBe('created');
    expect(r2.status).toBe('created');

    const finalCfg = env.getCurrent();
    const agentIds = (finalCfg.agents?.list ?? []).map((a) => a.id);
    expect(agentIds).toContain('feishu-ou_alice');
    expect(agentIds).toContain('feishu-ou_bob');

    const bindings = finalCfg.bindings ?? [];
    expect(bindings.filter((b) => b.match?.channel === 'feishu')).toHaveLength(2);
  });

  it('serializes writes — second writer reads first writer\'s result', async () => {
    const env = makeRuntime(makeBaseCfg());
    const writeOrder: string[] = [];

    env.onBeforeWrite = async (cfg) => {
      // 记录每次写入时 cfg 里的 feishu agent 数量
      const count = (cfg.agents?.list ?? []).filter((a) => a.id.startsWith('feishu-')).length;
      writeOrder.push(`write:${count}`);
    };

    await Promise.all([
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_alice',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_bob',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_carol',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
    ]);

    // 三次写,每次写时 cfg 里的 feishu 数量应该单调递增 1, 2, 3
    expect(writeOrder).toEqual(['write:1', 'write:2', 'write:3']);

    const finalAgents = (env.getCurrent().agents?.list ?? []).filter((a) =>
      a.id.startsWith('feishu-'),
    );
    expect(finalAgents).toHaveLength(3);
  });

  it('two parallel calls for same user — first creates, second sees already_bound', async () => {
    const env = makeRuntime(makeBaseCfg());

    const [r1, r2] = await Promise.all([
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_alice',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
      maybeCreateDynamicAgent({
        cfg: env.getCurrent(),
        runtime: env.runtime,
        senderOpenId: 'ou_alice',
        dynamicCfg: makeDynamicCfg(),
        log: noop,
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(['already_bound', 'created']);
    expect(env.writes).toHaveLength(1);
  });

  it('respects maxAgents under concurrent contention', async () => {
    const env = makeRuntime(makeBaseCfg());
    const dyn: DynamicAgentCreationConfig = { ...makeDynamicCfg(), maxAgents: 2 };

    const results = await Promise.all(
      ['ou_a', 'ou_b', 'ou_c', 'ou_d'].map((id) =>
        maybeCreateDynamicAgent({
          cfg: env.getCurrent(),
          runtime: env.runtime,
          senderOpenId: id,
          dynamicCfg: dyn,
          log: noop,
        }),
      ),
    );

    const created = results.filter((r) => r.status === 'created').length;
    const limited = results.filter((r) => r.status === 'max_agents_reached').length;
    expect(created).toBe(2);
    expect(limited).toBe(2);

    const finalAgents = (env.getCurrent().agents?.list ?? []).filter((a) =>
      a.id.startsWith('feishu-'),
    );
    expect(finalAgents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Read-modify-write
// ---------------------------------------------------------------------------

describe('maybeCreateDynamicAgent — read-modify-write', () => {
  it('uses latest cfg from runtime.config.loadConfig, not the snapshot in params', async () => {
    const initial = makeBaseCfg();
    const env = makeRuntime(initial);

    // 模拟"外部已经把 alice 绑过了"——更新 runtime 当前 cfg,但传给 maybeCreate 的是旧快照
    const externallyUpdated: ClawdbotConfig = {
      ...initial,
      bindings: [
        { agentId: 'feishu-ou_alice', match: { channel: 'feishu', peer: { kind: 'direct', id: 'ou_alice' } } },
      ],
    };
    env.setCurrent(externallyUpdated);

    const result = await maybeCreateDynamicAgent({
      cfg: initial, // 旧快照
      runtime: env.runtime,
      senderOpenId: 'ou_alice',
      dynamicCfg: makeDynamicCfg(),
      log: noop,
    });

    expect(result.status).toBe('already_bound');
    expect(env.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. writeConfigWithRetry
// ---------------------------------------------------------------------------

describe('writeConfigWithRetry', () => {
  it('succeeds on first try', async () => {
    const env = makeRuntime(makeBaseCfg());
    await writeConfigWithRetry(env.runtime, env.getCurrent(), noop);
    expect(env.writes).toHaveLength(1);
  });

  it('succeeds after transient failures', async () => {
    const env = makeRuntime(makeBaseCfg());
    env.failNextWrites(2);
    await writeConfigWithRetry(env.runtime, env.getCurrent(), noop);
    expect(env.writes).toHaveLength(1);
  });

  it('throws after 3 consecutive failures', async () => {
    const env = makeRuntime(makeBaseCfg());
    env.failAllWrites(new Error('persistent'));
    await expect(writeConfigWithRetry(env.runtime, env.getCurrent(), noop)).rejects.toThrow(
      'persistent',
    );
  });
});
