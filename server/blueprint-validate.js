// Blueprint validation bridge (add-blueprint-studio Slice 1, design D3/D5).
//
// 零第二造：本模块的每一则校验错误都来自既有校验器原文——
//   parseFleetTemplate      fleet 段（server/fleet-template.js，含编排成环）
//   validatePackManifest    manifest 段（lib/pack-manifest.js，发布门同函数）
//   toolFaceErrors/toolClosureErrors
//                           发布工具闸的 consult 复用（lib/publish-tool-gate.js
//                           同步导出；异步带探针的 toolGateErrors 留在发布门，
//                           design「实施口径对账」D3 补充）
// 唯一本地生成的发现是 shape 闸（凭据扫描 + dataSources 契约），粒度同样
// 逐字段指名——spec「错误文案不得超过既有校验器原文的字段粒度」。
//
// 形状纪律（spec 蓝图不含凭据）：dataSources 只收 registry 在册 server 名或
// 内部库逻辑名；端点/凭据在存储层另有硬拒（blueprints-db.js assertStorable）。

import { parseFleetTemplate } from "./fleet-template.js";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { toolFaceErrors, toolClosureErrors } from "../lib/publish-tool-gate.js";

// ── Shape gate: 凭据扫描（存储层与 validate 路由共用） ─────────────────────

// 键名禁带：子串匹配长词（token/secret/…），短小通用词用精确集合避免误伤
// （"headline" 不吃 "headers" 这类亏）。契约白名单里的键永不判罚。
const FORBIDDEN_KEY_PARTS = /token|secret|password|credential|api[-_]?key|private[-_]?key/i;
const FORBIDDEN_KEY_EXACT = new Set(["endpoint", "url", "headers", "baseurl", "base_url", "base-url", "host"]);
const CONTRACT_KEY_WHITELIST = new Set(["target", "registryName", "allowTools", "requiredGroup", "fullSurface", "reason"]);

// 秘密字面值：命中常见的真凭据形态；普通 URL/散文不匹配。
const SECRET_LITERAL_RE =
  /(sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer\s+[A-Za-z0-9._-]{12,})/i;

export function credentialFindings(content) {
  const findings = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${at}[${i}]`);
      return;
    }
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && SECRET_LITERAL_RE.test(node)) {
        findings.push({ error: `secret-like literal is not allowed in a blueprint`, entry: at || "$" });
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const entry = at ? `${at}.${key}` : key;
      if (
        !CONTRACT_KEY_WHITELIST.has(key) &&
        (FORBIDDEN_KEY_PARTS.test(key) || FORBIDDEN_KEY_EXACT.has(key.toLowerCase()))
      ) {
        findings.push({ error: `key '${key}' may not carry endpoints or credentials in a blueprint`, entry });
        continue; // 命中禁键即名之，不再下探该子树（错误归主键）。
      }
      walk(value, entry);
    }
  };
  walk(content, "");
  return findings;
}

// ── Shape gate: dataSources 契约（只在册名/逻辑名，禁端点禁凭据） ──────────

const DATASOURCE_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function dataSourceFindings(content) {
  const findings = [];
  const sources = content?.dataSources;
  if (sources === undefined || sources === null) return findings;
  if (!Array.isArray(sources)) {
    return [{ error: "dataSources must be an array of { ref } entries naming registry servers or internal libraries", entry: "dataSources" }];
  }
  sources.forEach((src, i) => {
    const entry = `dataSources[${i}]`;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
      findings.push({ error: `data source must be an object of { ref, note? } naming a registry server or internal-library logical name`, entry });
      return;
    }
    if (typeof src.ref !== "string" || !DATASOURCE_REF_RE.test(src.ref)) {
      findings.push({
        error: `data source ref '${src.ref}' must be a registry server name or internal-library logical name (no endpoints, no credentials)`,
        entry: `${entry}.ref`,
      });
    }
    if (src.note !== undefined && typeof src.note !== "string") {
      findings.push({ error: `data source note must be a string when present`, entry: `${entry}.note` });
    }
  });
  return findings;
}

export function shapeFindings(content) {
  return [...credentialFindings(content), ...dataSourceFindings(content)];
}

// ── Manifest 组装与全链校验 ────────────────────────────────────────────────

// 铸造时喂给既有校验器的 manifest：名字取场景中文主名（类型由「集群模板」
// 专辑位/徽章承载，名字不背类型——产品命名决议）；category 钉 "fleet"
// （代码键零改老律：专辑显示名是市场层的词，键不动）。
export function assembleManifest(content, { name } = {}) {
  const sceneName = name ?? content?.boundary?.name ?? content?.fleet?.name ?? content?.fleet?.nameKey ?? "";
  const manifest = {
    name: sceneName,
    description: content?.boundary?.oneLine ?? "",
    category: "fleet",
  };
  if (Array.isArray(content?.tags)) manifest.tags = content.tags;
  if (content?.agents !== undefined) manifest.agents = content.agents;
  if (content?.mcpServers !== undefined) manifest.mcpServers = content.mcpServers;
  if (content?.fleet !== undefined) manifest.fleet = content.fleet;
  return manifest;
}

// 提交前全套校验链（spec 要求三 + D3 consult）：shape → parseFleetTemplate
// → validatePackManifest → toolFace/toolClosure。返回按链序摊平的 errors
// （既有校验器原文逐字段）+ manifestPreview 供编辑面/铸造复用。
export function validateBlueprint(content) {
  const manifestPreview = assembleManifest(content);
  const shape = shapeFindings(content ?? {});
  const fleetParsed = parseFleetTemplate(manifestPreview);
  const fleet = fleetParsed.ok ? [] : [{ error: fleetParsed.error, entry: "fleet" }];
  const manifest = validatePackManifest(manifestPreview);
  const toolFace = toolFaceErrors(manifestPreview);
  const toolClosure = toolClosureErrors(manifestPreview);
  const errors = [...shape, ...fleet, ...manifest, ...toolFace, ...toolClosure];
  return {
    ok: errors.length === 0,
    errors,
    findings: { shape, fleet, manifest, toolFace, toolClosure },
    manifestPreview,
  };
}

// ── 归一化 diff（批准面渲染与批准凭据同源） ────────────────────────────────

const clip = (s) => {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  return text && text.length > 80 ? `${text.slice(0, 77)}…` : text;
};
const countOf = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);

export function diffBlueprint(prev, next) {
  const diff = [];
  const pushScalar = (field, a, b) => {
    if ((a ?? "") !== (b ?? "")) diff.push({ field, before: clip(a ?? ""), after: clip(b ?? "") });
  };
  const pushCount = (field, a, b) => {
    if (countOf(a) !== countOf(b)) diff.push({ field, before: countOf(a), after: countOf(b) });
  };

  pushScalar("boundary.name", prev?.boundary?.name, next?.boundary?.name);
  pushScalar("boundary.oneLine", prev?.boundary?.oneLine, next?.boundary?.oneLine);
  pushScalar("boundary.outOfScope", prev?.boundary?.outOfScope, next?.boundary?.outOfScope);
  pushCount("dataSources", prev?.dataSources, next?.dataSources);
  pushCount("fleet.members", prev?.fleet?.members, next?.fleet?.members);
  pushCount("fleet.orchestration.edges", prev?.fleet?.orchestration?.edges, next?.fleet?.orchestration?.edges);
  pushCount("agents", prev?.agents, next?.agents);
  pushCount("mcpServers", prev?.mcpServers, next?.mcpServers);
  pushCount("acceptance", prev?.acceptance, next?.acceptance);
  pushCount("monitoring", prev?.monitoring, next?.monitoring);
  if (Boolean(prev?.board) !== Boolean(next?.board)) {
    diff.push({ field: "board", before: Boolean(prev?.board), after: Boolean(next?.board) });
  }
  return diff;
}

// ── 铸造：依赖占位补齐 + _casting 追溯 ────────────────────────────────────
//
// 占位形态（finddata fleet-packs 契约）：
//   {{PACK_ID:<name>}}  依赖包引用（纪律 pack 等）——铸造时按名字经市场解析
//                       落实 packId；解析不出 = 依赖漂移，铸造拒（design D4）。
//   {{PACK_ID}} / {{PACK_ID:self}}  包自引用——续铸（已知 cast_pack_id）回补
//                       自身谱系；首铸保持占位（paas 装台链按 presetId 物化，
//                       从不消费 target.packId——fleet-provisioner.js 实证，
//                       占位在发布后呈惰性）。

const PACK_REF_RE = /\{\{PACK_ID:([^}]+)\}\}/g;
const SELF_REF_RE = /\{\{PACK_ID(?::self)?\}\}/g;

export function collectPackRefs(content) {
  const refs = new Set();
  const text = JSON.stringify(content ?? {});
  for (const match of text.matchAll(PACK_REF_RE)) {
    const name = match[1]?.trim();
    if (name && name !== "self") refs.add(name);
  }
  return [...refs];
}

export function buildCastManifest({ content, resolved = {}, selfPackId = null, casting }) {
  const assembled = assembleManifest(content);
  let text = JSON.stringify(assembled);
  const missing = [];
  text = text.replace(PACK_REF_RE, (whole, raw) => {
    const name = raw.trim();
    if (name === "self") return whole; // 自引用走 SELF_REF_RE 通道
    const hit = resolved[name];
    if (!hit?.packId) {
      missing.push(name);
      return whole;
    }
    return hit.packId;
  });
  let selfPending = false;
  text = text.replace(SELF_REF_RE, (whole) => {
    if (selfPackId) return selfPackId;
    selfPending = true;
    return whole;
  });
  const manifest = JSON.parse(text);
  manifest._casting = {
    source: "fleet-blueprint-studio",
    blueprintId: casting.blueprintId,
    version: casting.version,
    approvedBy: casting.approvedBy,
    approvedAt: casting.approvedAt,
    diffSummary: casting.diffSummary ?? null,
  };
  return { manifest, missing, selfPending };
}
