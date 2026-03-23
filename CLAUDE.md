# CLAUDE.md - OpenClaw Lark/飞书 插件

## 项目简介

OpenClaw 官方飞书/Lark 插件 (`@larksuite/openclaw-lark`)，将 AI Agent 对接飞书工作区，提供消息、文档、多维表格、日历、任务等 40+ 工具。

## 常用命令

```bash
npm run build          # 构建项目 (node scripts/build.mjs)
npm run lint           # ESLint 检查
npm run lint:fix       # ESLint 自动修复
npm run format         # Prettier 格式化
npm run format:check   # Prettier 检查
```

## 架构概览

```
index.ts                    ← 插件入口：注册 Channel + Tools + Commands + Hooks
├── src/core/               ← 基础设施：Lark SDK 客户端、认证、配置、多账号
├── src/channel/             ← Channel 集成：WebSocket 监听、事件分发、配对
├── src/messaging/           ← 消息处理：入站 7 阶段管道、出站适配
│   ├── inbound/            ← 入站：解析 → 策略网关 → 内容解析 → Agent 分发
│   └── outbound/           ← 出站：文本/卡片/媒体发送
├── src/card/               ← 卡片渲染：流式卡片状态机 (CardKit 2.0)
├── src/tools/              ← 工具层：40+ OAPI/MCP/OAuth 工具
│   ├── oapi/              ← 飞书 OpenAPI 工具 (im/bitable/calendar/task/...)
│   ├── mcp/               ← MCP 文档工具 (create/fetch/update doc)
│   ├── tat/               ← TAT IM 工具 (用户身份消息读取)
│   └── oauth*.ts          ← OAuth 认证工具
├── src/commands/           ← CLI 命令 (/feishu auth, /feishu doctor)
└── skills/                 ← 9 个技能定义 (SKILL.md)
```

## 代码规范

### 文件头
每个 `.ts` 文件必须包含 Copyright + SPDX 头部：
```typescript
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 模块简要说明
 */
```

### TypeScript
- ESM 模块 (`"type": "module"`)
- 优先使用 `interface` 而非 `type`（ESLint 强制）
- 未使用变量必须以 `_` 前缀命名
- 导出函数需要显式返回类型（`explicit-module-boundary-types: warn`）
- `any` 是 warn 级别，非 error
- 使用 `prefer-const`，禁止 `var`

### 格式化 (Prettier)
- 120 字符行宽, 2 空格缩进, 单引号, 尾逗号, LF 换行

### 注释语言
- 面向内部开发的注释和描述使用**中文**
- 面向 API/导出的标识符使用**英文**命名

## 工具开发模式

### 新建工具的标准模板
```typescript
import { createToolContext, registerTool, formatToolResult, formatToolError } from '../helpers';
import { handleInvokeErrorWithAutoAuth } from '../auto-auth';

export function registerMyTool(api: OpenClawPluginApi): boolean {
  const { toolClient, log } = createToolContext(api, 'feishu_my_tool');

  return registerTool(api, {
    name: 'feishu_my_tool',
    parameters: MyToolSchema,  // TypeBox schema
    async execute(_toolCallId: string, params: unknown) {
      const client = toolClient();
      try {
        const res = await client.invoke(
          'feishu_my_tool.action',
          (sdk, opts) => sdk.some.api.call({ ... }),
          { as: 'user' }
        );
        assertLarkOk(res);
        return formatToolResult(res.data);
      } catch (err) {
        return await handleInvokeErrorWithAutoAuth(err, cfg);
      }
    }
  }, { name: 'feishu_my_tool' });
}
```

### 关键辅助函数 (`src/tools/helpers.ts`)
- `createToolContext(api, toolName)` → 返回 `{ toolClient, log }`
- `registerTool(api, tool, opts)` → 自动检查 deny list
- `formatToolResult(data)` / `formatToolError(err, context)` → 格式化返回值
- `validateRequiredParams(params, fields)` / `validateEnum(value, allowed, field)`

### Schema 定义
- 工具参数使用 `@sinclair/typebox`（TypeBox）
- 配置验证使用 `zod`
- 两者不混用

## 关键约束

### 多账号
- 优先使用 `LarkTicket` 中的 `accountId` 动态解析账号
- 回退到第一个启用的账号
- 每个账号独立 SDK 实例、独立权限

### 安全
- Owner 操作使用 **fail-close** 策略（检查失败 → 拒绝）
- Token 存储：macOS Keychain / Linux+Win AES-256-GCM
- 用户身份 (UAT) vs 应用身份 (Bot/App) 严格分离
- 敏感信息（owner_id）不序列化到错误消息

### API 调用
- 使用 `client.invoke(actionKey, apiCall, {as: 'user'|'bot'})` 统一调用
- 使用 `assertLarkOk(res)` 验证响应
- 权限不足时通过 `handleInvokeErrorWithAutoAuth()` 自动触发 OAuth

## Commit 风格

遵循 Conventional Commits（但不严格）：
```
fix: 修复描述
feat: 新功能描述
feat(scope): 带作用域的描述
```

分支命名：`hotfix/xxx`、`feature/xxx`、`fix/xxx`
