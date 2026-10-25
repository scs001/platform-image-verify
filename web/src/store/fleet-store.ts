// Live fleet turn store (agent-fleet-runs / cockpit v2 face 1).
//
// Owns the fleet_* WS events the way the cron store owns cron_*: the started
// event parks the in-flight turn, the ended event retires it (the outcome
// facts arrive via the throttled cockpit refetch — the store never holds
// them), and every event bumps a version the page uses as its throttled
// refresh trigger. The socket lives in useWebSocket; this store never owns one.

import { create } from "zustand";
import type { ServerMessage } from "@platform/core";

export interface LiveTurn {
  turnId: string;
  runId: string;
  fleetId: string;
  memberId: string;
  parentTurnId: string | null;
  parentMemberId: string | null;
  edgeKind: string | null;
  source: string;
  startedAt: number;
}

interface FleetLiveState {
  /** In-flight turns keyed by turnId. */
  liveTurns: Record<string, LiveTurn>;
  /** Bumped on every fleet event — the cockpit's throttled refetch trigger. */
  version: number;
  /** Bumped on fleet_run_updated — the run timeline's refresh trigger (face 2). */
  runsVersion: number;
  /**
   * Replay cursor (face 2): while set, the canvas derives node/edge state at
   * this instant instead of live; null = real time. Set by the timeline
   * slider, cleared on release (回放释放后恢复实时态).
   */
  replayAt: number | null;
  /**
   * The replayed run's in-flight turns AT replayAt — synthesized by the
   * timeline (turns open at the cursor), same shape as liveTurns so the
   * canvas reads one type either way. Empty when not replaying.
   */
  replayTurns: LiveTurn[];

  apply: (m: ServerMessage) => void;
  liveTurnsFor: (memberId: string) => LiveTurn[];
  setReplayAt: (at: number | null) => void;
  setReplayTurns: (turns: LiveTurn[]) => void;
}

export const useFleetStore = create<FleetLiveState>((set, get) => ({
  liveTurns: {},
  version: 0,
  runsVersion: 0,
  replayAt: null,
  replayTurns: [],

  apply: (m) =>
    set((state) => {
      if (m.type === "fleet_turn_started") {
        return {
          liveTurns: {
            ...state.liveTurns,
            [m.turnId]: {
              turnId: m.turnId,
              runId: m.runId,
              fleetId: m.fleetId,
              memberId: m.memberId,
              parentTurnId: m.parentTurnId,
              parentMemberId: m.parentMemberId,
              edgeKind: m.edgeKind,
              source: m.source,
              startedAt: m.startedAt,
            },
          },
          version: state.version + 1,
        };
      }
      if (m.type === "fleet_turn_ended") {
        const next = { ...state.liveTurns };
        delete next[m.turnId];
        return { liveTurns: next, version: state.version + 1 };
      }
      if (m.type === "fleet_run_updated") {
        return { runsVersion: state.runsVersion + 1 };
      }
      return {};
    }),

  liveTurnsFor: (memberId) => {
    const all = get().liveTurns;
    return Object.values(all).filter((t) => t.memberId === memberId);
  },

  setReplayAt: (at) => set({ replayAt: at }),

  setReplayTurns: (turns) => set({ replayTurns: turns }),
}));
