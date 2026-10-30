// ── 类目→线归位展示映射 (add-legacy-pack-rebrand 2.x; spec: pack-category-line-mapping) ──
//
// 市场历史遗留的散类目 slug（daas / data / dash / authoring / docs / company）在浏览分面
// 统合到「线（供给域）」语义呈现。映射 SHALL 只作用于读面展示与分面聚合：
//   - packs.db / manifest 的 category 值 SHALL 零迁移（存储不动）；
//   - curation 写入端点仍收原 slug 语义（写面不经过这里）；
//   - 未映射的类目按原样呈现（不消失、不猜测归位）；
//   - `company` 归 null：六分身由 badge=facade 承担，不再以类目形式出现在主货架分面。
//
// 表本身部署侧可配（PACK_CATEGORY_LINES=JSON），缺省内置这张。value 为字符串 = 归位线词；
// value 为 null = 从分面剔除。一个 slug 只落一条线（多对一，非一对多）。

// 表本身部署侧可配（PACK_CATEGORY_LINES=JSON），缺省内置这张。value 为字符串 = 归位线词；
// value 为 null = 从分面剔除。一个 slug 只落一条线（多对一，非一对多）。
//
// 线词按愿景定为「品牌 · 领域」：买家在市场找的是「谁供给、干什么活」，结构（团队模板/
// 分身/助手/工具）由 badge 承担、官方性由 official 标承担、归属由这张线词表承担——三层正交。
// 值对齐五线定案（寻数·壹座/识律/柏讯/谦面/萬星）。现网 14 个真实类目的归位：
//   cluster/fleet/fleet-shared → 壹座 · 智能体团队（团队蓝图与共享岗位都属平台本体）
//   wire/research (+ 历史 daas/data/dash/analytics) → 柏讯 · 数据与情报
//   legal → 识律 · 法律智能
//   facet/text/doc-studio/crm/operations/business (+ 历史 authoring/docs/writing) → 谦面 · 业务流
//   wanxing → 萬星 · 智能体连接
//   facade/company → null（分身类由 badge=facade 承担，不以类目出现）

const DEFAULT_LINES = {
  // 壹座 · 智能体团队 — 平台本体的团队蓝图与共享岗位
  cluster: "壹座 · 智能体团队",
  fleet: "壹座 · 智能体团队",
  "fleet-shared": "壹座 · 智能体团队",
  // 柏讯 · 数据与情报
  wire: "柏讯 · 数据与情报",
  research: "柏讯 · 数据与情报",
  daas: "柏讯 · 数据与情报",
  data: "柏讯 · 数据与情报",
  dash: "柏讯 · 数据与情报",
  analytics: "柏讯 · 数据与情报",
  // 识律 · 法律智能
  legal: "识律 · 法律智能",
  // 谦面 · 业务流 — 文本与数据的业务垂直工作流
  facet: "谦面 · 业务流",
  text: "谦面 · 业务流",
  "doc-studio": "谦面 · 业务流",
  crm: "谦面 · 业务流",
  operations: "谦面 · 业务流",
  business: "谦面 · 业务流",
  authoring: "谦面 · 业务流",
  docs: "谦面 · 业务流",
  writing: "谦面 · 业务流",
  // 萬星 · 智能体连接
  wanxing: "萬星 · 智能体连接",
  // 分身类由 badge=facade 承担，不在主货架按类目展示
  facade: null,
  company: null,
};

let _configured = null; // cached parsed env

/** The active table: env PACK_CATEGORY_LINES (JSON object) overrides the built-in. */
export function categoryLines(env = process.env) {
  const raw = (env.PACK_CATEGORY_LINES || "").trim();
  if (!raw) {
    if (!_configured) _configured = { ...DEFAULT_LINES };
    return _configured;
  }
  if (_configured) return _configured;
  let built = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // null is a legitimate value (suppress from facet); anything else → string.
      const out = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v === null || typeof v === "string") out[k] = v;
      }
      built = out;
    }
  } catch {
    // malformed override falls back to the built-in rather than breaking the face.
  }
  _configured = built || { ...DEFAULT_LINES };
  return _configured;
}

/** Reset the parsed override cache (tests mutate the env between cases). */
export function _resetCategoryLinesCache() {
  _configured = null;
}

/** The display line word a stored slug maps to; the slug itself when unmapped
 *  (`present as-is`), or `null` for a slug deliberately suppressed from the facet. */
export function lineOf(slug, env = process.env) {
  const s = String(slug ?? "");
  if (!s) return "";
  const table = categoryLines(env);
  if (Object.hasOwn(table, s)) return table[s];
  return s;
}

/** The set of stored slugs that all归位 to a given display line word. Used to expand a
 *  facet selection (which now carries the LINE word) back to the raw slugs it stands for. */
export function slugsForLine(lineWord, env = process.env) {
  const out = new Set();
  for (const [slug, line] of Object.entries(categoryLines(env))) {
    if (line === lineWord) out.add(slug);
  }
  return [...out];
}

/** True when a facet selection is a line word (so it must be expanded to slugs). A raw
 *  slug is indistinguishable when it is its own line word (e.g. an unmapped category),
 *  so only the line word is expanded when it is NOT itself a stored slug key. */
export function isLineWord(word, env = process.env) {
  const w = String(word ?? "");
  if (!w) return false;
  const table = categoryLines(env);
  const values = new Set(Object.values(table).filter((v) => v !== null));
  // A word that is simultaneously a slug key maps to itself — that is an exact match,
  // not a line selection. Only treat it as a line when it is not a stored-key slug.
  return values.has(w) && !(w in table);
}

/** Aggregate the distinct facet line words for a category-slug set, sorted, with the
 *  suppressed (company→null) bucket dropped. Unmapped slugs pass through as themselves. */
export function facetLinesOf(slugs, env = process.env) {
  const set = new Set();
  for (const s of slugs) {
    const line = lineOf(s, env);
    if (line) set.add(line);
  }
  return [...set].sort();
}
