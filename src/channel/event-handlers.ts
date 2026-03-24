/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Event handlers for the Feishu WebSocket monitor.
 *
 * Extracted from monitor.ts to improve testability and reduce
 * function size. Each handler receives a MonitorContext with all
 * dependencies needed to process the event.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  FeishuBotAddedEvent,
  FeishuMessageEvent,
  FeishuP2pChatEnteredEvent,
  FeishuReactionCreatedEvent,
} from '../messaging/types';
import { handleFeishuMessage } from '../messaging/inbound/handler';
import { handleFeishuReaction, resolveReactionContext } from '../messaging/inbound/reaction-handler';
import { isMessageExpired } from '../messaging/inbound/dedup';
import { withTicket } from '../core/lark-ticket';
import { larkLogger } from '../core/lark-logger';
import { handleCardAction } from '../tools/auto-auth';
import { handleAskUserAction } from '../tools/ask-user-question';
import { buildQueueKey, enqueueFeishuChatTask, getActiveDispatcher, hasActiveTask } from './chat-queue';
import { extractRawTextFromEvent, isLikelyAbortText } from './abort-detect';
import { sendMessageFeishu } from '../messaging/outbound/send';
import { getLarkAccount } from '../core/accounts';
import type { MonitorContext } from './types';

const elog = larkLogger('channel/event-handlers');

// ---------------------------------------------------------------------------
// Welcome message dedup — persistent across gateway restarts.
// Follows the same pattern as upstream feishu dedup (JSON file in state dir).
// ---------------------------------------------------------------------------

const WELCOMED_FILE = path.join(
  process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw'),
  'feishu',
  'welcomed-users.json',
);

/** Max entries to keep in the welcomed-users file. */
const WELCOMED_MAX_ENTRIES = 10_000;

/** In-memory cache, warm from disk on first check. */
let welcomedUsers: Set<string> | null = null;

async function loadWelcomedUsers(): Promise<Set<string>> {
  if (welcomedUsers) return welcomedUsers;
  try {
    const raw = await fs.readFile(WELCOMED_FILE, 'utf8');
    const arr = JSON.parse(raw);
    welcomedUsers = new Set(Array.isArray(arr) ? arr : []);
  } catch {
    welcomedUsers = new Set();
  }
  return welcomedUsers;
}

/**
 * Mark a user as welcomed. Uses optimistic in-memory add before
 * persisting to disk, preventing concurrent sends for the same user.
 */
async function markWelcomed(key: string): Promise<void> {
  const set = await loadWelcomedUsers();
  set.add(key);

  // Trim oldest entries if over limit
  if (set.size > WELCOMED_MAX_ENTRIES) {
    const arr = [...set];
    const trimmed = arr.slice(arr.length - WELCOMED_MAX_ENTRIES);
    set.clear();
    for (const k of trimmed) set.add(k);
  }

  try {
    await fs.mkdir(path.dirname(WELCOMED_FILE), { recursive: true });
    await fs.writeFile(WELCOMED_FILE, JSON.stringify([...set]), 'utf8');
  } catch (err) {
    elog.warn(`failed to persist welcomed-users: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Event ownership validation
// ---------------------------------------------------------------------------

/**
 * Verify that the event's app_id matches the current account.
 *
 * Lark SDK EventDispatcher flattens the v2 envelope header (which
 * contains `app_id`) into the handler `data` object, so `app_id` is
 * available directly on `data`.
 *
 * Returns `false` (discard event) when the app_id does not match.
 */
function isEventOwnershipValid(ctx: MonitorContext, data: unknown): boolean {
  const expectedAppId = ctx.lark.account.appId;
  if (!expectedAppId) return true; // appId not configured — skip check

  const eventAppId = (data as Record<string, unknown>).app_id;
  if (eventAppId == null) return true; // SDK did not provide app_id — defensive skip

  if (eventAppId !== expectedAppId) {
    elog.warn('event app_id mismatch, discarding', {
      accountId: ctx.accountId,
      expected: expectedAppId,
      received: String(eventAppId),
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

export async function handleMessageEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuMessageEvent;
    const msgId = event.message?.message_id ?? 'unknown';
    const chatId = event.message?.chat_id ?? '';
    // In topic groups, reply events carry root_id but not thread_id.
    // Use root_id as fallback so different topics get separate queue keys
    // and can be processed in parallel.
    const threadId = event.message?.thread_id || event.message?.root_id || undefined;

    // Dedup — skip duplicate messages (e.g. from WebSocket reconnects).
    if (!ctx.messageDedup.tryRecord(msgId, accountId)) {
      log(`feishu[${accountId}]: duplicate message ${msgId}, skipping`);
      return;
    }

    // Expiry — discard stale messages from reconnect replay.
    if (isMessageExpired(event.message?.create_time)) {
      log(`feishu[${accountId}]: message ${msgId} expired, discarding`);
      return;
    }

    // ---- Abort fast-path ----
    // If the message looks like an abort trigger and there is an active
    // reply dispatcher for this chat, fire abortCard() immediately
    // (before the message enters the serial queue) so the streaming
    // card is terminated without waiting for the current task.
    const abortText = extractRawTextFromEvent(event);
    if (abortText && isLikelyAbortText(abortText)) {
      const queueKey = buildQueueKey(accountId, chatId, threadId);
      if (hasActiveTask(queueKey)) {
        const active = getActiveDispatcher(queueKey);
        if (active) {
          log(`feishu[${accountId}]: abort fast-path triggered for chat ${chatId} (text="${abortText}")`);
          active.abortController?.abort();
          active.abortCard().catch((err) => {
            error(`feishu[${accountId}]: abort fast-path abortCard failed: ${String(err)}`);
          });
        }
      }
    }

    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId,
      threadId,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: msgId,
              chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: event.sender?.sender_id?.open_id || '',
              chatType: (event.message?.chat_type as 'p2p' | 'group') || undefined,
              threadId,
            },
            () =>
              handleFeishuMessage({
                cfg: ctx.cfg,
                event,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
              }),
          );
        } catch (err) {
          error(`feishu[${accountId}]: error handling message: ${String(err)}`);
        }
      },
    });
    log(`feishu[${accountId}]: message ${msgId} in chat ${chatId}${threadId ? ` thread ${threadId}` : ''} — ${status}`);
  } catch (err) {
    error(`feishu[${accountId}]: error handling message: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Reaction handler
// ---------------------------------------------------------------------------

export async function handleReactionEvent(ctx: MonitorContext, data: unknown): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuReactionCreatedEvent;
    const msgId = event.message_id ?? 'unknown';

    log(`feishu[${accountId}]: reaction event on message ${msgId}`);

    // ---- Dedup: deterministic key based on message + emoji + operator ----
    const emojiType = event.reaction_type?.emoji_type ?? '';
    const operatorOpenId = event.user_id?.open_id ?? '';
    const dedupKey = `${msgId}:reaction:${emojiType}:${operatorOpenId}`;
    if (!ctx.messageDedup.tryRecord(dedupKey, accountId)) {
      log(`feishu[${accountId}]: duplicate reaction ${dedupKey}, skipping`);
      return;
    }

    // ---- Expiry: discard stale reaction events ----
    if (isMessageExpired(event.action_time)) {
      log(`feishu[${accountId}]: reaction on ${msgId} expired, discarding`);
      return;
    }

    // ---- Pre-resolve real chatId before enqueuing ----
    // The API call (3s timeout) runs outside the queue so it doesn't
    // block the serial chain, and is read-only so ordering is irrelevant.
    const preResolved = await resolveReactionContext({
      cfg: ctx.cfg,
      event,
      botOpenId: ctx.lark.botOpenId,
      runtime: ctx.runtime,
      accountId,
    });
    if (!preResolved) return;

    // ---- Enqueue with the real chatId (matches normal message queue key) ----
    const { status } = enqueueFeishuChatTask({
      accountId,
      chatId: preResolved.chatId,
      threadId: preResolved.threadId,
      task: async () => {
        try {
          await withTicket(
            {
              messageId: msgId,
              chatId: preResolved.chatId,
              accountId,
              startTime: Date.now(),
              senderOpenId: operatorOpenId,
              chatType: preResolved.chatType,
              threadId: preResolved.threadId,
            },
            () =>
              handleFeishuReaction({
                cfg: ctx.cfg,
                event,
                botOpenId: ctx.lark.botOpenId,
                runtime: ctx.runtime,
                chatHistories: ctx.chatHistories,
                accountId,
                preResolved,
              }),
          );
        } catch (err) {
          error(`feishu[${accountId}]: error handling reaction: ${String(err)}`);
        }
      },
    });
    log(`feishu[${accountId}]: reaction on ${msgId} (chatId=${preResolved.chatId}) — ${status}`);
  } catch (err) {
    error(`feishu[${accountId}]: error handling reaction event: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Bot membership handler
// ---------------------------------------------------------------------------

export async function handleBotMembershipEvent(
  ctx: MonitorContext,
  data: unknown,
  action: 'added' | 'removed',
): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuBotAddedEvent;
    log(`feishu[${accountId}]: bot ${action} ${action === 'removed' ? 'from' : 'to'} chat ${event.chat_id}`);

    // Send group welcome message when bot is added to a group
    if (action === 'added' && event.chat_id) {
      const account = getLarkAccount(ctx.cfg, accountId);
      const welcomeText = account.config?.groupWelcomeMessage;
      if (welcomeText) {
        try {
          await sendMessageFeishu({
            cfg: ctx.cfg,
            to: `chat:${event.chat_id}`,
            text: welcomeText,
            accountId,
          });
          log(`feishu[${accountId}]: sent group welcome message to ${event.chat_id}`);
        } catch (sendErr) {
          error(`feishu[${accountId}]: failed to send group welcome message: ${String(sendErr)}`);
        }
      }
    }
  } catch (err) {
    error(`feishu[${accountId}]: error handling bot ${action} event: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Bot p2p chat entered handler (user first opens DM with bot)
// ---------------------------------------------------------------------------

export async function handleBotP2pChatEntered(
  ctx: MonitorContext,
  data: unknown,
): Promise<void> {
  if (!isEventOwnershipValid(ctx, data)) return;
  const { accountId, log, error } = ctx;
  try {
    const event = data as FeishuP2pChatEnteredEvent;
    const userOpenId = event.operator_id?.open_id ?? event.user_id?.open_id;
    if (!userOpenId) return;

    log(`feishu[${accountId}]: user ${userOpenId} entered p2p chat`);

    // Only send welcome message once per user (persisted across restarts).
    // Optimistic mark: add to memory before sending to prevent concurrent duplicates.
    const welcomeKey = `${accountId}:${userOpenId}`;
    const welcomed = await loadWelcomedUsers();
    if (welcomed.has(welcomeKey)) {
      log(`feishu[${accountId}]: welcome already sent to ${userOpenId}, skipping`);
      return;
    }

    const account = getLarkAccount(ctx.cfg, accountId);
    const welcomeText = account.config?.welcomeMessage;
    if (!welcomeText) return;

    // Mark in memory first (prevents concurrent sends), persist after success.
    welcomed.add(welcomeKey);
    try {
      await sendMessageFeishu({
        cfg: ctx.cfg,
        to: `user:${userOpenId}`,
        text: welcomeText,
        accountId,
      });
      await markWelcomed(welcomeKey);
      log(`feishu[${accountId}]: sent welcome message to ${userOpenId}`);
    } catch (sendErr) {
      welcomed.delete(welcomeKey); // rollback optimistic mark on failure
      error(`feishu[${accountId}]: failed to send welcome message: ${String(sendErr)}`);
    }
  } catch (err) {
    error(`feishu[${accountId}]: error handling p2p chat entered: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Card action handler
// ---------------------------------------------------------------------------

export async function handleCardActionEvent(ctx: MonitorContext, data: unknown): Promise<unknown> {
  try {
    // AskUserQuestion card interactions — injects synthetic message
    // carrying user answers for the AI to receive in a new turn.
    const askResult = handleAskUserAction(data, ctx.cfg, ctx.accountId);
    if (askResult !== undefined) return askResult;

    // Auto-auth card actions (OAuth device flow, app scope confirmation)
    return await handleCardAction(data, ctx.cfg, ctx.accountId);
  } catch (err) {
    elog.warn(`card.action.trigger handler error: ${err}`);
  }
}
