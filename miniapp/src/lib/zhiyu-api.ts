// zhiyu-api — the room endpoints the mini-program calls (openspec:
// add-zhiyu-mobile-clients, tasks 3.1 / 5.1).
//
// Same endpoints as web, through the shared core `http` (whose Taro transport
// is installed at boot by lib/taro-http). Nothing here is mini-program-shaped:
// if this file ever grows a "for mobile" variant of a room field, the two
// clients have started to diverge.
//
// Note what is NOT here: invites, private windows, subscription management, room
// settings. Mobile hands those to the web through a one-time link
// (`mintHandoff`), because a second implementation of a permission model on a
// phone is a second permission model (5.1).

import { http } from "@platform/core";

export interface ZhiyuRoomSummary {
  id: string;
  title: string;
  ownerEmail: string;
  status: "active" | "ended";
  lastActivityAt: number;
  createdAt: number;
}

export interface ZhiyuMemberRow {
  id: string;
  kind: string;
  ref: string;
  display: string;
  presence: string;
  onBehalfOf?: string | null;
  state?: string;
}

async function json<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
  const res = await http(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function listRooms(): Promise<ZhiyuRoomSummary[]> {
  const body = await json<{ rooms?: ZhiyuRoomSummary[] }>("/api/zhiyu/rooms");
  return Array.isArray(body?.rooms) ? body.rooms : [];
}

export async function getRoom(roomId: string): Promise<{ room: ZhiyuRoomSummary; members: ZhiyuMemberRow[]; myMemberId: string | null }> {
  return json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}`);
}

export async function sendMessage(roomId: string, content: string): Promise<void> {
  await json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

// ── Meeting capture (openspec: add-meeting-capture, 5.3) ────────────────────
// The same two calls web makes. Deliberately the SAME shape: a mobile-only
// variant of a meeting field is how the three clients start to disagree about
// who attended.

export interface ZhiyuMeeting {
  id: string;
  roomId: string;
  title: string;
  status: "open" | "ended";
  createdAt: number;
  endedAt: number | null;
}

export interface ZhiyuMeetingParticipant {
  memberRef: string;
  captureId: string | null;
  state: "joined" | "finished" | "abandoned";
}

export interface ZhiyuMeetingView {
  meeting: ZhiyuMeeting;
  participants: ZhiyuMeetingParticipant[];
  delivered: number;
  awaitingConfirmation: number;
  orderBasis: "arrival";
}

export async function openMeeting(roomId: string, title: string): Promise<ZhiyuMeeting> {
  const body = await json<{ meeting: ZhiyuMeeting }>(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return body.meeting;
}

/**
 * What is running in this room right now (add-meeting-discovery).
 *
 * Returns the ONE open meeting plus my stream in it (or null for both). Before
 * this existed, a meeting was only joinable by the person who opened it in the
 * page where they opened it — the second person in a room could not see that a
 * meeting was on, so the whole "everyone claims their own stream" model was
 * unreachable. Read-only; a failure must not block opening a new meeting.
 */
export async function getOpenMeeting(
  roomId: string,
): Promise<{ meeting: ZhiyuMeeting | null; participant: ZhiyuMeetingParticipant | null }> {
  return json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings/open`);
}

export async function joinMeeting(meetingId: string): Promise<void> {
  await json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}/join`, { method: "POST", body: JSON.stringify({}) });
}

export async function endMeeting(meetingId: string): Promise<void> {
  await json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}/end`, { method: "POST", body: JSON.stringify({}) });
}

export async function getMeeting(meetingId: string): Promise<ZhiyuMeetingView> {
  return json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}`);
}

export interface HandoffLink {
  url: string;
  path: string;
  purpose: string;
  expiresAt: number;
}

/**
 * Mint the one-time link to a web-only surface (5.1/5.2).
 *
 * The phone cannot open it itself (WeChat will not navigate to an external
 * host); it puts it on the clipboard and says so. The link is spent the first
 * time it is opened on the web.
 */
export async function mintHandoff(roomId: string, purpose: string): Promise<HandoffLink> {
  return json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/deeplink`, {
    method: "POST",
    body: JSON.stringify({ purpose }),
  });
}
