# OpenClaw Lark/Feishu Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/@larksuite/openclaw-lark.svg)](https://www.npmjs.com/package/@larksuite/openclaw-lark)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22-blue.svg)](https://nodejs.org/)

[中文版](./README.zh.md) | English

This is the official Lark/Feishu plugin for OpenClaw, developed and maintained by the Lark/Feishu Open Platform team. It seamlessly connects your OpenClaw Agent to your Lark/Feishu workspace, enabling it to directly read from and write to messages, docs, bases, calendars, tasks, and more.

## Features

This plugin provides comprehensive Lark/Feishu integration for OpenClaw, including:

| Category | Capabilities |
|------|------|
| 💬 Messenger | Read messages (group/DM history, thread replies), send messages, reply to messages, search messages, download images/files |
| 📄 Docs | Create, update, and read documents |
| 📊 Base | Create/manage bases, tables, fields, records (CRUD, batch operations, advanced filtering), views |
| 📈 Sheets | Create, edit, and view spreadsheets |
| 📅 Calendar | Manage calendars and events (create/query/update/delete/search), manage attendees, check free/busy status |
| ✅ Tasks | Manage tasks (create/query/update/complete), manage task lists, subtasks, and comments |

Additionally, the plugin supports:
- **📱 Interactive Cards**: Real-time status updates (Thinking/Generating/Complete), plus confirmation buttons for sensitive operations
- **🌊 Streaming Responses**: Live streaming text directly within message cards
- **🔒 Permission Policies**: Flexible access control policies for DMs and group chats
- **⚙️ Advanced Group Configuration**: Per-group settings including allowlists, skill bindings, and custom system prompts
- **👋 Welcome Messages**: Configurable welcome messages for new DM users and when the bot is added to a group
- **🤖 Dynamic Agent Creation**: Automatically creates an isolated agent instance with its own workspace for each DM user, providing per-user session isolation

## Configuration

### Multi-User OAuth (uat.ownerOnly)

By default, only the app owner can use user-scope tools (Bitable, Calendar, etc.) and initiate OAuth authorization. To allow all users to OAuth with their own Feishu identity:

```json
{
  "channels": {
    "feishu": {
      "uat": {
        "ownerOnly": false
      }
    }
  }
}
```

When `ownerOnly` is `false`:
- Any user can initiate OAuth authorization via the Device Flow
- Each user's token is stored separately (keyed by `appId:userOpenId`)
- Users can only access resources they have permission for in Feishu
- Set back to `true` (or remove the field) to restore owner-only mode

### Dynamic Agent Creation

When enabled, the plugin creates an isolated agent instance with its own workspace for each new DM user:

```json
{
  "channels": {
    "feishu": {
      "dynamicAgentCreation": {
        "enabled": true,
        "maxAgents": 20
      }
    }
  }
}
```

Each workspace includes an `.openclaw/agent-context.json` metadata file that bootstrap hooks can read to identify the agent type and inject custom templates.

### Welcome Messages

Configure welcome messages for new DM users and group additions:

```json
{
  "channels": {
    "feishu": {
      "welcomeMessage": "Hello! How can I help you?",
      "groupWelcomeMessage": "Hi everyone! Mention me to start a conversation."
    }
  }
}
```

Welcome messages are sent once per user and persisted across gateway restarts.

## Security & Risk Warnings (Read Before Use)

This plugin integrates with OpenClaw AI automation capabilities and carries inherent risks such as model hallucinations, unpredictable execution, and prompt injection. After you authorize Lark/Feishu permissions, OpenClaw will act under your user identity within the authorized scope, which may lead to high-risk consequences such as leakage of sensitive data or unauthorized operations. Please use with caution.

To reduce these risks, the plugin enables default security protections at multiple layers. However, these risks still exist. We strongly recommend that you do not proactively modify any default security settings; once relevant restrictions are relaxed, the risks will increase significantly, and you will bear the consequences.

We recommend using the Lark/Feishu bot connected to OpenClaw as a private conversational assistant. Do not add it to group chats or allow other users to interact with it, to avoid abuse of permissions or data leakage.

Please fully understand all usage risks. By using this plugin, you are deemed to voluntarily assume all related responsibilities.


**Disclaimer:**

This software is licensed under the MIT License. When running, it calls Lark/Feishu Open Platform APIs. To use these APIs, you must comply with the following agreements and privacy policies:

- [Feishu Privacy Policy](https://www.feishu.cn/en/privacy?from=openclaw_plugin_readme)
- [Feishu User Terms of Service](https://www.feishu.cn/en/terms?from=openclaw_plugin_readme)
- [Feishu Store App Service Provider Security Management Specifications](https://open.larkoffice.com/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/management-practice/app-service-provider-security-management-specifications)

- [Lark Privacy Policy](https://www.larksuite.com/user-terms-of-service)
- [Lark User Terms of Service](https://www.larksuite.com/privacy-policy)

## Requirements & Installation

Before you start, make sure you have the following:

- **Node.js**: `v22` or higher.
- **OpenClaw**: version **2026.3.22** or higher. Check with `openclaw -v`.

### Install from GitHub

```bash
openclaw plugins install https://github.com/aocuan/openclaw-lark
```

No build step required — OpenClaw loads `index.ts` directly via jiti.

### Install from local path (for development)

```bash
# Clone the repo
git clone https://github.com/aocuan/openclaw-lark.git
cd openclaw-lark
npm install

# Link install (changes take effect after npm run build)
openclaw plugins install --link .
npm run build
```

### Restart gateway after installation

```bash
openclaw gateway restart
```

## Usage Guide

[How to Use the Official Lark/Feishu Plugin for OpenClaw](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh)

## Contributing

Community contributions are welcome! If you find a bug or have feature suggestions, please submit an [Issue](https://github.com/larksuite/openclaw-larksuite/issues) or a [Pull Request](https://github.com/larksuite/openclaw-larksuite/pulls).

For major changes, we recommend discussing with us first via an Issue.

## License

This project is licensed under the **MIT License**. See [LICENSE](./LICENSE.md) for details.
