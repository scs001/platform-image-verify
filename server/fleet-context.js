// Fleet patrol-context renderer (agent-fleet-report-lane).
//
// Renders the {{fleetContext}} segment a post's prompt template carries:
// the DIRECT children's latest reports (declared slot values + blockers +
// summary line), the fleet's on-duty overview, and — from 刀3 on — the pending
// decisions digest (a provider seam that returns null until the decision lane
// exists). Pure over injected deps; cron.js calls this synchronously before
// enqueueing a fire, and a thrown error fails that fire explicitly (never a
// silent empty-context patrol).
//
// Guardrails: 4KB per child post, 24KB total, truncation marked in the text.

const PER_POST_LIMIT = 4 * 1024;
const TOTAL_LIMIT = 24 * 1024;
const SUMMARY_LINE_LIMIT = 300;

// 巡逻纪律（2026-10-29 真机诊断 §15.88）。平台侧注入，对所有现役舰队立即生效，
// 不改任何存量岗位的提示词。
//
// 起因：公司式集群 CEO 岗约每 6 轮就有 1 轮以 `turn_budget_exceeded` 收场且零
// 产出——13 步里 10 步在翻工作区/记忆（`read`×5 + `glob`/`bash`/`grep`），一次
// `report_status` 都没调。工作区里躺着一份 56KB 的 `ceo-patrol-round4.md`（内含
// 40+ 轮历史记录，是历轮自己写下的），每读一次就把后续每一步都拖慢，最终吃掉
// 10 分钟回合预算。根因有两层：提示词没说「注入的即全部输入」，而工作区又把
// 每轮产出累积成下一轮的阅读材料。
//
// 这段只写「怎么用已经给你的」，不新增任何工具或数据面。
const PATROL_DISCIPLINE = [
  "## 本轮怎么干（巡逻纪律）",
  "- 上面的报数**就是本轮的完整输入**——它由平台在开火时现算并注入。不要再去工作区、记忆或历史文件里找「更全的报数」；那些是往轮留下的副本，只会是旧的。",
  "- 先报数再补充：读完上下文就调用 report_status 交本轮的数（槽位值 + 阻塞 + 摘要），然后才做别的。**空手超时是最差结局**——宁可报「本轮无新数据」也不要一轮下来什么都没交。",
  "- 需要往下追问时用 dispatch_post（要 memberId，不是部门显示名），不要靠翻文件推断别部状态。",
  "- 写历史文件是可选的副产品，不是完成任务的前提；不要为了写记录而先把旧记录读一遍。",
].join("\n");

function truncateWithMark(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[截断]`;
}

// One child post's block: title, declared slot values (label: value with unit
// and trend arrow), blockers, one summary line, resource count.
function renderChildBlock({ member, latest, previous }) {
  const lines = [`### ${member.title}`];
  if (!latest) {
    lines.push("（尚无报数）");
    return lines.join("\n");
  }
  const declared = member.kpiSlots ?? [];
  const slotLines = declared
    .filter((s) => latest.metrics?.[s.key] !== undefined)
    .map((s) => {
      const m = latest.metrics[s.key];
      const prev = previous?.metrics?.[s.key];
      let arrow = "";
      if (prev !== undefined && prev !== null) {
        const a = Number(prev.value);
        const b = Number(m.value);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          arrow = b > a ? " ↑" : b < a ? " ↓" : " →";
        } else {
          arrow = String(prev.value) === String(m.value) ? " →" : " ±";
        }
      }
      return `- ${s.label}${s.unit ? `（${s.unit}）` : ""}: ${m.value}${arrow}`;
    });
  if (slotLines.length) lines.push(...slotLines);
  if (Array.isArray(latest.blockers) && latest.blockers.length) {
    lines.push(`- 阻塞: ${latest.blockers.map((b) => String(b).slice(0, 120)).join("；")}`);
  }
  if (Array.isArray(latest.resources) && latest.resources.length) {
    lines.push(`- 受管资源: ${latest.resources.length} 项`);
  }
  const summary = String(latest.summary ?? "").slice(0, SUMMARY_LINE_LIMIT);
  lines.push(`- 摘要: ${summary}`);
  lines.push(`- 报数时间: ${new Date(latest.createdAt).toISOString()}`);
  return lines.join("\n");
}

// deps: { db (fleets-db), deriveStatuses(fleetId) => Map<memberId, status>,
//         decisionDigest(fleetId) => string|null, now? }
export async function buildFleetContext(sourceTag, _task, deps) {
  const { db, deriveStatuses, decisionDigest } = deps;
  const fleet = db.getFleet(sourceTag.fleetId);
  if (!fleet) throw new Error(`fleet ${sourceTag.fleetId} no longer exists`);
  const me = db.getMember(sourceTag.memberId);
  if (!me) throw new Error(`post ${sourceTag.memberId} no longer exists`);

  const members = db.listMembers(fleet.id);
  const children = members.filter((m) => m.parentId === me.id);
  const latestByMember = db.latestReports(fleet.id);

  const statuses = deriveStatuses(fleet.id);
  const onDuty = [...statuses.values()].filter((s) => s === "on_duty").length;

  const header = `【集群巡视上下文】集群「${fleet.name}」在岗 ${onDuty}/${members.length}`;
  const sections = [header];

  if (children.length === 0) {
    sections.push("（本岗位无直接下级）");
  } else {
    let used = header.length;
    for (const child of children) {
      const latest = latestByMember.get(child.id) ?? null;
      const previous = latest ? db.previousReport(child.id, latest.createdAt) : null;
      const raw = renderChildBlock({ member: child, latest, previous });
      const block = truncateWithMark(raw, PER_POST_LIMIT);
      used += block.length;
      if (used > TOTAL_LIMIT) {
        sections.push("…（其余下级报数因总量上限截断）");
        break;
      }
      sections.push(block);
    }
  }

  // Pending decisions digest (decision lane, 刀3): the provider renders THIS
  // firing post's undelivered resolutions as their own segment; null (nothing
  // to deliver, or the lane absent) omits the segment entirely — never an
  // empty placeholder.
  const digest = decisionDigest?.(fleet.id, me.id) ?? null;
  if (digest) {
    sections.push(truncateWithMark(digest, PER_POST_LIMIT));
  }

  sections.push("（以上为系统注入的巡视上下文，供你巡视与决策参考。）");
  sections.push(PATROL_DISCIPLINE);
  return sections.join("\n\n");
}
