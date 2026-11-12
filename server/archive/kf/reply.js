// ── 微信客服：回复 ──────────────────────────────────────────────────────────
//
// 这个模块只做一件事：把「回一条消息」这条路径上的三个坑一次堵掉。
//
// 1. **48 小时会话窗口**。客户最后一条消息之后 48 小时内才能回复，过了就发不出去。
//    这跟拉取的 3 天窗口是两个不同的窗口，混用会算错。判定放在本地，
//    是为了给出「还差几小时」这种能行动的信息，而不是让接口返回一个 errcode。
//
// 2. **自己的回复会从拉取里再回来一次**。发送接口返回 `msgid`，用同一个 id 先落库，
//    下一轮 `sync_msg` 拉到同一条时被 `INSERT OR IGNORE` 吃掉。不这么做，
//    每回复一次就在会话里出现两条（一条本地、一条拉取），而且两条时间戳不同。
//
// 3. **对外动作必须显式**。没有任何自动回复路径：函数要求显式给出客户与会话，
//    摄取循环不导入本模块。想让它自己发，得改代码，不是改配置。

import { KF_SELF } from "./origin.js";
import {
  insertKfMessage,
  refreshKfConversationStats,
  upsertKfConversation,
  getKfConversation,
} from "./store.js";

export const REPLY_WINDOW_HOURS = 48;
const REPLY_WINDOW_MS = REPLY_WINDOW_HOURS * 3_600_000;

/**
 * 回复窗口判定。`lastCustomerAt` 必须取**客户**最后一条消息，
 * 取最后一条消息（含我方）会让窗口永远不关——自己回一句就能续命，这是假绿。
 */
export function replyWindow({ lastCustomerAt, now = Date.now() }) {
  const last = Number(lastCustomerAt || 0);
  if (!last) {
    return { open: false, hoursLeft: 0, reason: "客户从未发言，没有可回复的会话" };
  }
  const elapsed = Number(now) - last;
  if (elapsed > REPLY_WINDOW_MS) {
    return {
      open: false,
      hoursLeft: 0,
      reason: `客户最后一条消息在 ${(elapsed / 3_600_000).toFixed(1)} 小时前，超过 ${REPLY_WINDOW_HOURS} 小时回复窗口`,
    };
  }
  return { open: true, hoursLeft: (REPLY_WINDOW_MS - elapsed) / 3_600_000, reason: "窗口内" };
}

/**
 * 发一条文本回复。
 *
 * 返回 `{ ok, reason?, msgId?, window }`。失败不抛异常——调用方通常是 agent 或运维脚本，
 * 需要的是"能不能回、为什么不能"，不是 stack trace。
 */
export async function sendReply({
  db,
  client,
  conversationId,
  openKfId = "",
  externalUserId = "",
  content,
  now = Date.now(),
} = {}) {
  if (!db) throw new Error("sendReply 需要 db");
  if (!client || typeof client.sendText !== "function") throw new Error("sendReply 需要 client.sendText");

  let convId = conversationId;
  let kfid = openKfId;
  let external = externalUserId;
  if (convId && (!kfid || !external)) {
    const conv = getKfConversation(db, convId);
    kfid = kfid || conv?.openKfId || "";
    external = external || conv?.externalUserId || "";
  }
  if (!convId) convId = `${kfid}|${external}`;

  const window = replyWindow({ lastCustomerAt: lastCustomerMessageAt(db, convId), now });
  if (!window.open) return { ok: false, reason: window.reason, window };

  let sent;
  try {
    sent = await client.sendText({ externalUserId: external, openKfId: kfid, content });
  } catch (err) {
    return { ok: false, reason: err?.message || String(err), errcode: err?.errcode ?? null, window };
  }

  // 用服务端 msgid 先落库：下一轮拉取到同一条会被幂等吃掉，不会重复。
  const msgId = sent?.msgId || `local-${now}`;
  upsertKfConversation(db, { conversationId: convId, openKfId: kfid, externalUserId: external });
  insertKfMessage(db, {
    id: `${convId}:${msgId}`,
    conversationId: convId,
    msgId,
    openKfId: kfid,
    externalUserId: external,
    sentAt: Number(now),
    origin: KF_SELF,
    msgType: "text",
    text: String(content ?? ""),
    ingestedAt: Number(now),
  });
  refreshKfConversationStats(db, convId);

  return { ok: true, msgId, window };
}

/** 客户最后一条消息时间。只看 `peer`，理由见 `replyWindow`。 */
export function lastCustomerMessageAt(db, conversationId) {
  const row = db
    .prepare(
      "SELECT MAX(sent_at) t FROM kf_message WHERE conversation_id=? AND origin='peer'",
    )
    .get(conversationId);
  const t = Number(row?.t || 0);
  return t > 0 ? t : 0;
}
