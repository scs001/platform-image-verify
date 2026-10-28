// Sellability gate (add-blueprint-studio task 4.2, design D6/D8).
//
// 可售态的唯一真源是试跑报告（design D6）：模板要进「可售」，必须以试跑断言
// 全绿且报告落账为前提。本闸把它写成结构性闸而非纪律——收费上架（带 pricing）
// 的集群模板必须携铸造追溯 `_casting` 与试跑绿报告；免费上架不拦（内部现状：
// 免费分发是默认），但把「无报告」记成建议项如实回报，便于将来收紧。
//
// 判据为什么不看 vendor 而是看 pricing：2026-10-28 用户裁决——内部现在全免费、
// 后续收费。把闸绑在「是否收费」而非「是否第三方」，收费那一刻闸自动生效，
// 不需要二次改造，也不给存量免费包造祖父条款的例外。
//
// 报告随铸造追溯走（manifest._casting.trialReport），不新造第二个通道：
// 发布门只读 manifest，市场侧不需要新增外键或跨服务查询。

export const TRIAL_GATE_CODES = {
  missingCasting: "priced-template-without-casting",
  missingTrial: "priced-template-without-trial-report",
  trialNotGreen: "priced-template-trial-not-green",
};

const isTemplateManifest = (manifest) => Boolean(manifest && manifest.fleet && typeof manifest.fleet === "object");

/**
 * @param {object} manifest  待发布 manifest（已过结构闸）
 * @param {object} opts
 * @param {object|null} opts.pricing  已解析的 pricing（null/undefined = 免费上架）
 * @returns {{ errors: {error:string,code:string,entry?:string}[], notes: string[] }}
 */
export function sellabilityGate(manifest, { pricing = null } = {}) {
  const errors = [];
  const notes = [];
  if (!isTemplateManifest(manifest)) return { errors, notes };

  const casting = manifest._casting && typeof manifest._casting === "object" ? manifest._casting : null;
  const report = casting?.trialReport && typeof casting.trialReport === "object" ? casting.trialReport : null;

  // 收费上架：铸造追溯 + 试跑绿报告，两者缺一不可。
  if (pricing) {
    if (!casting) {
      errors.push({
        error:
          "a priced cluster template must carry its casting provenance (_casting: source blueprint, version, approver, approval time) — cast it from Blueprint Studio instead of publishing a bare manifest",
        code: TRIAL_GATE_CODES.missingCasting,
        entry: "_casting",
      });
      return { errors, notes };
    }
    if (!report) {
      errors.push({
        error:
          "a priced cluster template must carry a green trial report (_casting.trialReport) — run the first-round trial in Blueprint Studio and re-cast; assertion-green is the only source of sellability",
        code: TRIAL_GATE_CODES.missingTrial,
        entry: "_casting.trialReport",
      });
      return { errors, notes };
    }
    if (report.green !== true) {
      const failed = Array.isArray(report.assertions)
        ? report.assertions.filter((a) => !a?.pass).map((a) => a?.id ?? "(unnamed)")
        : [];
      errors.push({
        error:
          failed.length > 0
            ? `trial report is not green — failing assertion(s): ${failed.join(", ")}; a non-green template cannot be sold`
            : "trial report is not green (no assertion evidence) — a non-green template cannot be sold",
        code: TRIAL_GATE_CODES.trialNotGreen,
        entry: "_casting.trialReport.green",
      });
    }
    return { errors, notes };
  }

  // 免费上架：不拦，但如实记账——将来收费时这批条目需要补报告。
  if (isTemplateManifest(manifest) && (!report || report.green !== true)) {
    notes.push(
      `free template publish without a green trial report (pack '${manifest?.name ?? "unnamed"}') — allowed while distribution is free; a priced version will require it`,
    );
  }
  return { errors, notes };
}