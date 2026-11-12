// ── 微信客服 API 客户端 ─────────────────────────────────────────────────────
//
// 三个"看起来该重试、其实重试更糟"的地方，先在这里一次处理掉：
//
// 1. **令牌只缓存、不落盘**。`access_token` 是 7200s 的短期凭据，写进 DB 就会进备份、
//    进日志、进导出，等于把企业级权限换个地方明文存着。
// 2. **刷新只做一次**。访问令牌失效（42001/40014/41001）刷新一次再试一次就够；
//    外层再套一层重试会把 1 次调用放大成 N 次，而每次都要先取一次令牌。
// 3. **凭据错误不重试**。`40001`/`40013`/`40056` 是 secret/corpid 不对，
//    重试一百次还是同一个结果，只会把错误信息里的时间戳搅乱。
//
// 另一个必须钉住的：**错误信息里不得出现 `access_token` 或 `secret`**。
// 官方 `errmsg` 有时会回显请求串，所以这里是主动擦除，不是"应该不会"。

export const DEFAULT_BASE_URL = "https://qyapi.weixin.qq.com";
export const MAX_SYNC_LIMIT = 1000;
export const MAX_CUSTOMER_BATCH = 100; // 官方 batchget 单次上限
export const MAX_TEXT_BYTES = 2048; // 官方 text.content 上限（按 UTF-8 字节）
// 运维护栏，不是官方上限：单个媒体超过它就有理由怀疑不是一份"客户发来的附件"。
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

const TOKEN_ERRCODES = new Set([42001, 40014, 41001]);
const CONFIG_ERRCODES = new Set([40001, 40013, 40056]);
// 60020 = 调用方出口 IP 不在「企业可信IP」里。真机实测（2026-11-12）：gettoken 不受此限，
// 所以"取到票"之后才撞上它。不单独命名就会被当成 secret 填错，改一晚上凭据。
export const IP_ERRCODE = 60020;

export class KfApiError extends Error {
  constructor({ errcode, errmsg, op }) {
    super(`${op} 失败：errcode=${errcode} ${errmsg || ""}`.trim());
    this.name = "KfApiError";
    this.errcode = Number(errcode);
    this.errmsg = errmsg || "";
    this.op = op;
  }
}

export class KfConfigError extends KfApiError {
  constructor(args) {
    super(args);
    this.name = "KfConfigError";
  }
}

export class KfTokenError extends KfApiError {
  constructor(args) {
    super(args);
    this.name = "KfTokenError";
  }
}

/**
 * 出口 IP 未被信任。官方 errmsg 里带着调用方 IP（`from ip: 1.2.3.4`），
 * 把它挖出来当字段：运维要拿这个值去后台加白名单，而不是去猜。
 */
export class KfIpNotTrustedError extends KfApiError {
  constructor(args) {
    super(args);
    this.name = "KfIpNotTrustedError";
    const m = /from ip:\s*([0-9a-fA-F.:]+)/.exec(String(args?.errmsg || ""));
    this.ip = m ? m[1] : "";
  }
}

/** 失败分类只命名确定的四种；其余原样保留 errcode，不猜含义。 */
export function classifyKfError({ errcode, errmsg, op }) {
  const code = Number(errcode);
  if (code === IP_ERRCODE) return new KfIpNotTrustedError({ errcode: code, errmsg, op });
  if (CONFIG_ERRCODES.has(code)) return new KfConfigError({ errcode: code, errmsg, op });
  if (TOKEN_ERRCODES.has(code)) return new KfTokenError({ errcode: code, errmsg, op });
  return new KfApiError({ errcode: code, errmsg, op });
}

/** 从任意字符串里擦掉本次凭据。导出是为了让测试能直接断言。 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (!s) continue;
    const v = String(s);
    if (v.length < 6) continue;
    out = out.split(v).join("***");
  }
  return out;
}

/**
 * 创建客户端。`fetchImpl` 必须可注入——没有真凭据时测试也要能覆盖全部分支。
 */
export function createKfClient({
  fetchImpl = globalThis.fetch,
  corpId = "",
  secret = "",
  baseUrl = DEFAULT_BASE_URL,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("createKfClient 需要可用的 fetch");

  let cache = { token: "", expiresAt: 0 };
  // 擦除用：任何时候错误信息里出现这两个值都要抹掉
  const secrets = () => [secret, cache.token];

  async function callJson({ op, path, method = "POST", query = {}, body }) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const init = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    let resp;
    try {
      resp = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new KfApiError({
        errcode: -1,
        errmsg: redact(`网络失败：${err?.message || err}`, secrets()),
        op,
      });
    }
    if (!resp || typeof resp.json !== "function") {
      throw new KfApiError({ errcode: -2, errmsg: "响应不可解析", op });
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new KfApiError({
        errcode: -3,
        errmsg: `响应不是 JSON（HTTP ${resp.status ?? "?"}）`,
        op,
      });
    }
    const errcode = Number(data?.errcode ?? 0);
    if (errcode !== 0) {
      throw classifyKfError({ errcode, errmsg: redact(data?.errmsg, secrets()), op });
    }
    return data;
  }

  async function fetchToken() {
    if (!corpId) throw new KfConfigError({ errcode: 40013, errmsg: "未配置 corpid", op: "gettoken" });
    if (!secret) throw new KfConfigError({ errcode: 40001, errmsg: "未配置 secret", op: "gettoken" });
    const data = await callJson({
      op: "gettoken",
      path: "/cgi-bin/gettoken",
      method: "GET",
      query: { corpid: corpId, corpsecret: secret },
    });
    const expiresIn = Number(data.expires_in || 7200);
    cache = {
      token: String(data.access_token || ""),
      // 提前 5 分钟失效：卡在最后一秒取票，失败一次就是一个批次的空洞。
      expiresAt: now() + Math.max(0, expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS),
    };
    if (!cache.token) {
      throw new KfApiError({ errcode: -4, errmsg: "gettoken 未返回 access_token", op: "gettoken" });
    }
    return cache.token;
  }

  async function token({ force = false } = {}) {
    if (!force && cache.token && now() < cache.expiresAt) return cache.token;
    return fetchToken();
  }

  /** 带令牌的调用：令牌失效时刷新一次并重试一次，仅此而已。 */
  async function callWithToken(args, { retried = false } = {}) {
    const t = await token({ force: retried });
    try {
      return await callJson({
        ...args,
        query: { ...args.query, access_token: t },
      });
    } catch (err) {
      if (err instanceof KfTokenError && !retried) {
        cache = { token: "", expiresAt: 0 };
        return callWithToken(args, { retried: true });
      }
      throw err;
    }
  }

  /**
   * 取二进制。与 `callJson` 的关键差别：**响应可能是 JSON 错误也可能是一段文件**，
   * 只能靠 content-type 分辨。把 JSON 当文件写下去，会得到一个 200 字节的"假图片"，
   * 而且状态是 done——所以这里对 JSON 一律当失败。
   */
  async function callRaw({ op, path, query = {}, retried = false }) {
    const t = await token({ force: retried });
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries({ ...query, access_token: t })) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const init = { method: "GET" };
    if (timeoutMs > 0 && typeof AbortSignal?.timeout === "function") {
      init.signal = AbortSignal.timeout(Math.max(timeoutMs, 30_000));
    }

    let resp;
    try {
      resp = await fetchImpl(url.toString(), init);
    } catch (err) {
      throw new KfApiError({
        errcode: -1,
        errmsg: redact(`网络失败：${err?.message || err}`, secrets()),
        op,
      });
    }
    const contentType = String(resp?.headers?.get?.("content-type") || "");

    if (contentType.includes("application/json")) {
      let data = null;
      try {
        data = await resp.json();
      } catch {
        throw new KfApiError({ errcode: -3, errmsg: "响应声明是 JSON 但解析失败", op });
      }
      const errcode = Number(data?.errcode ?? 0);
      if (errcode !== 0) {
        const err = classifyKfError({ errcode, errmsg: redact(data?.errmsg, secrets()), op });
        if (err instanceof KfTokenError && !retried) {
          cache = { token: "", expiresAt: 0 };
          return callRaw({ op, path, query, retried: true });
        }
        throw err;
      }
      // 200 + JSON + errcode=0 却要一个文件：这是协议矛盾，不能当成功
      throw new KfApiError({ errcode: -5, errmsg: "接口返回 JSON 而不是媒体内容", op });
    }

    if (typeof resp?.arrayBuffer !== "function") {
      throw new KfApiError({ errcode: -2, errmsg: "响应不可读取", op });
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw new KfApiError({
        errcode: -6,
        errmsg: `媒体 ${buffer.length} 字节，超过运维护栏 ${MAX_MEDIA_BYTES}`,
        op,
      });
    }
    const disposition = String(resp?.headers?.get?.("content-disposition") || "");
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    return { buffer, contentType, filename: match ? decodeURIComponent(match[1]) : "" };
  }

  return {
    /** 只用于诊断：不暴露令牌本身。 */
    tokenState() {
      return { cached: Boolean(cache.token) && now() < cache.expiresAt, expiresAt: cache.expiresAt };
    },

    async getToken() {
      return token();
    },

    /**
     * 拉取一批消息。
     *
     * 注意 `token` 入参：官方 `sync_msg` 有一个同名的事件令牌，只在处理回调事件时有意义，
     * 一次性。轮询模式**不传**——持久化它会让下一次请求从旧位置开始，表现为
     * "有数据、无报错、永不前进"。
     */
    /**
     * 拉取一批消息。
     *
     * 两个入参的语义必须分清（官方文档 94670）：
     *   - `open_kfid` 是**必填**：只能按客服账号拉，文档没有"不填则拉全部"这种行为。
     *     早先我把它当可选，是让用户少填一项，但那是在臆造上游行为——已改回必填。
     *   - `token` 是回调事件令牌、10 分钟有效、一次性。轮询模式**不传**；
     *     持久化它会让下一次请求从旧位置开始，表现为"有数据、无报错、永不前进"。
     *
     * 不填 `cursor` 时官方从 3 天内最早的消息开始，正好对应首轮同步。
     */
    async syncMsg({ cursor = "", openKfId = "", limit = MAX_SYNC_LIMIT, voiceFormat = 0 } = {}) {
      if (!openKfId) {
        throw new KfApiError({
          errcode: -15,
          errmsg: "缺少 open_kfid：sync_msg 必须指定客服账号（文档标为必填）",
          op: "sync_msg",
        });
      }
      const size = Math.max(1, Math.min(MAX_SYNC_LIMIT, Number(limit) || MAX_SYNC_LIMIT));
      const data = await callWithToken({
        op: "sync_msg",
        path: "/cgi-bin/kf/sync_msg",
        body: {
          ...(cursor ? { cursor: String(cursor) } : {}),
          limit: size,
          voice_format: Number(voiceFormat) || 0,
          open_kfid: String(openKfId),
        },
      });
      return {
        nextCursor: String(data.next_cursor ?? ""),
        hasMore: Number(data.has_more || 0) === 1,
        messages: Array.isArray(data.msg_list) ? data.msg_list : [],
      };
    },

    /**
     * 自动决定用哪个客服账号：只配了一个就直接用，多个则报错让人选。
     *
     * 这样既不必让用户去后台翻 id，也不假装"不填就拉全部"。
     */
    async resolveOpenKfId(explicit = "") {
      if (explicit) return { openKfId: String(explicit), source: "config" };
      const accounts = await this.listAccounts();
      const ids = accounts.map((a) => String(a.open_kfid || "")).filter(Boolean);
      if (ids.length === 1) return { openKfId: ids[0], source: "auto", accounts };
      return {
        openKfId: "",
        source: ids.length ? "ambiguous" : "none",
        accounts,
        reason: ids.length
          ? `本企业有 ${ids.length} 个客服账号，请用 KF_OPEN_KFID 指定：${ids.join(", ")}`
          : "本企业没有客服账号：先在微信客服创建，并把接待人员加入应用可见范围",
      };
    },

    /** 批量补客户资料。自动按官方单次 100 上限分片。 */
    async getCustomers(externalUserIds = []) {
      const ids = [...new Set((externalUserIds || []).filter(Boolean).map(String))];
      const customers = [];
      const invalid = [];
      for (let i = 0; i < ids.length; i += MAX_CUSTOMER_BATCH) {
        const chunk = ids.slice(i, i + MAX_CUSTOMER_BATCH);
        const data = await callWithToken({
          op: "customer_batchget",
          path: "/cgi-bin/kf/customer/batchget",
          body: { external_userid_list: chunk, need_enter_session_context: 0 },
        });
        for (const c of data.customer_list || []) customers.push(c);
        for (const id of data.invalid_external_userid || []) invalid.push(String(id));
      }
      return { customers, invalid };
    },

    /** 客服账号列表。诊断用它确认「kf 接口权限真的开了」。 */
    async listAccounts({ offset = 0, limit = 100 } = {}) {
      const data = await callWithToken({
        op: "account_list",
        path: "/cgi-bin/kf/account/list",
        body: { offset: Number(offset) || 0, limit: Number(limit) || 100 },
      });
      return Array.isArray(data.account_list) ? data.account_list : [];
    },

    /**
     * 下载一条媒体（图片 / 语音 / 视频 / 文件）。
     *
     * kf 的媒体是整包返回，没有分块协议。`voice_format` 只对语音有意义
     * （0=amr 1=silk 2=mp3），其它类型传了会被忽略。
     */
    async getMedia({ mediaId, voiceFormat = 0 } = {}) {
      const id = String(mediaId || "").trim();
      if (!id) throw new KfApiError({ errcode: -14, errmsg: "缺少 media_id", op: "media_get" });
      return callRaw({
        op: "media_get",
        path: "/cgi-bin/media/get",
        query: { media_id: id, voice_format: Number(voiceFormat) || 0 },
      });
    },

    /**
     * 发送文本。**这是对外动作**，只在调用方明确指定目标时发生；
     * 摄取循环永远不会调它。
     *
     * 校验放在本地：空正文、超长正文（官方 text 上限 2048 字节）、
     * 缺 `touser`/`open_kfid` 都在发请求之前拒掉——发给真实客户的消息
     * 不该靠"发出去看看报什么错"来验证。
     */
    async sendText({ externalUserId, openKfId, content }) {
      const touser = String(externalUserId || "").trim();
      const kfid = String(openKfId || "").trim();
      const body = String(content ?? "");
      if (!touser) throw new KfApiError({ errcode: -10, errmsg: "缺少 external_userid", op: "send_msg" });
      if (!kfid) throw new KfApiError({ errcode: -11, errmsg: "缺少 open_kfid", op: "send_msg" });
      if (!body.trim()) throw new KfApiError({ errcode: -12, errmsg: "正文为空", op: "send_msg" });
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > MAX_TEXT_BYTES) {
        throw new KfApiError({
          errcode: -13,
          errmsg: `正文 ${bytes} 字节，超过上限 ${MAX_TEXT_BYTES}`,
          op: "send_msg",
        });
      }
      const data = await callWithToken({
        op: "send_msg",
        path: "/cgi-bin/kf/send_msg",
        body: { touser, open_kfid: kfid, msgtype: "text", text: { content: body } },
      });
      return { msgId: String(data.msgid || "") };
    },
  };
}
