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

  const header = `【舰队巡视上下文】舰队「${fleet.name}」在岗 ${onDuty}/${members.length}`;
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
  return sections.join("\n\n");
}
