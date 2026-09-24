import { extname, isAbsolute } from 'node:path'

import {
  readJsonlCursor,
  record,
  type JsonlCursor,
  type JsonRecord
} from './codex-rollout-jsonl-cursor'
import { BoundedMap } from './bounded-map'
import { resolveChildTranscript, SAFE_THREAD_ID } from './codex-subagent-transcript-path'

import { readApprovalsReviewer } from './codex-subagent-reviewer'
import type { CodexApprovalsReviewer } from './codex-subagent-reviewer'

import {
  finishCodexSubagent,
  setCodexSubagentModel,
  upsertCodexSubagent,
  type CodexSubagentRoster
} from './codex-subagent-roster'

type TrackedTranscriptSubagent = JsonlCursor & {
  awaitingRetiredTurnComplete?: boolean
  awaitingTaskStarted?: boolean
  completedTurnId?: string
  currentTurnId?: string
  description?: string
  /** Retained because incremental reads rarely repeat the child's turn_context. */
  model?: string
  retiredTurnId?: string
  startedAt: number
}

// ponytail: both session ledgers retain 256 entries; raise only if long sessions prove this cap is hit.
const MAX_SUBAGENT_TRACKING_ENTRIES = 256

export type CodexSubagentTranscriptState = {
  parent: JsonlCursor
  subagents: Map<string, TrackedTranscriptSubagent>
  followupTaskCallIds: BoundedMap<string, true>
  retiredSubagentCursorsById: BoundedMap<string, TrackedTranscriptSubagent>
  /** Incremental reviewer cursors for child rollouts, which must not replace the parent cursor. */
  reviewerCursorsByPath: Map<string, JsonlCursor>
  /** Reviewer ownership discovered from child rollouts, keyed by their bounded cursor paths. */
  reviewersByPath: Map<string, CodexApprovalsReviewer>
  /** Who resolves this turn's approvals in the parent rollout. */
  approvalsReviewer?: CodexApprovalsReviewer
}

function readActivity(recordValue: JsonRecord):
  | {
      id: string
      description?: string
      eventId?: string
      kind: 'started' | 'interacted' | 'interrupted' | 'completed'
      startedAt: number
    }
  | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  if (payload?.type !== 'sub_agent_activity') {
    return undefined
  }
  const id = typeof payload.agent_thread_id === 'string' ? payload.agent_thread_id.trim() : ''
  const rawKind = typeof payload.kind === 'string' ? payload.kind.toLowerCase() : ''
  if (
    !SAFE_THREAD_ID.test(id) ||
    (rawKind !== 'started' &&
      rawKind !== 'interacted' &&
      rawKind !== 'interrupted' &&
      rawKind !== 'completed')
  ) {
    return undefined
  }
  return {
    id,
    description:
      typeof payload.agent_path === 'string' ? payload.agent_path.trim() || undefined : undefined,
    eventId:
      typeof payload.event_id === 'string' ? payload.event_id.trim() || undefined : undefined,
    kind: rawKind,
    startedAt:
      typeof payload.occurred_at_ms === 'number' && Number.isFinite(payload.occurred_at_ms)
        ? payload.occurred_at_ms
        : Date.now()
  }
}

function readFollowupTaskCallId(recordValue: JsonRecord): string | undefined {
  const payload = recordValue.type === 'response_item' ? record(recordValue.payload) : recordValue
  if (payload?.type !== 'function_call' || payload.name !== 'followup_task') {
    return undefined
  }
  const callId = typeof payload.call_id === 'string' ? payload.call_id : payload.id
  return typeof callId === 'string' ? callId.trim() || undefined : undefined
}

function readCompletedTurnId(kind: string, eventId: string | undefined): string | undefined {
  const prefix = 'subagent-completed-'
  return kind === 'completed' && eventId?.startsWith(prefix)
    ? eventId.slice(prefix.length) || undefined
    : undefined
}

function storeChildCursor(
  state: CodexSubagentTranscriptState,
  id: string,
  cursor: TrackedTranscriptSubagent
) {
  state.retiredSubagentCursorsById.delete(id)
  state.retiredSubagentCursorsById.set(id, { ...cursor })
}

/** Reads the child's model from its own rollout, never from the parent. */
function readChildModel(records: JsonRecord[]): string | undefined {
  let model: string | undefined
  for (const recordValue of records) {
    if (recordValue.type !== 'turn_context') {
      continue
    }
    const payload = record(recordValue.payload)
    const value = typeof payload?.model === 'string' ? payload.model.trim() : ''
    if (value) {
      model = value
    }
  }
  return model
}

function normalizedTranscriptPath(transcriptPath: string | undefined): string | undefined {
  const normalizedPath = transcriptPath?.trim()
  return normalizedPath && isAbsolute(normalizedPath) && extname(normalizedPath) === '.jsonl'
    ? normalizedPath
    : undefined
}

function childIsComplete(records: JsonRecord[], tracked: TrackedTranscriptSubagent): boolean {
  let complete = false
  for (const recordValue of records) {
    if (recordValue.type !== 'event_msg') {
      continue
    }
    const payload = record(recordValue.payload)
    const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : ''
    if (tracked.awaitingRetiredTurnComplete) {
      if (payload?.type === 'task_complete' && turnId === tracked.retiredTurnId) {
        tracked.completedTurnId = turnId
        tracked.awaitingRetiredTurnComplete = false
      }
      continue
    }
    if (payload?.type === 'task_started') {
      if (tracked.retiredTurnId && (!turnId || turnId === tracked.retiredTurnId)) {
        continue
      }
      tracked.currentTurnId = turnId || tracked.currentTurnId
      tracked.awaitingTaskStarted = false
      complete = false
    } else if (
      payload?.type === 'task_complete' &&
      !tracked.awaitingTaskStarted &&
      (!tracked.retiredTurnId ||
        (turnId && turnId === tracked.currentTurnId && turnId !== tracked.retiredTurnId))
    ) {
      tracked.completedTurnId = turnId || tracked.currentTurnId
      complete = true
    }
  }
  return complete
}

export function createCodexSubagentTranscriptState(): CodexSubagentTranscriptState {
  return {
    parent: { offset: 0, carry: '' },
    subagents: new Map(),
    followupTaskCallIds: new BoundedMap<string, true>({
      maxEntries: MAX_SUBAGENT_TRACKING_ENTRIES
    }),
    retiredSubagentCursorsById: new BoundedMap<string, TrackedTranscriptSubagent>({
      maxEntries: MAX_SUBAGENT_TRACKING_ENTRIES
    }),
    reviewerCursorsByPath: new Map(),
    reviewersByPath: new Map()
  }
}

export function hasTrackedCodexTranscriptSubagents(
  state: CodexSubagentTranscriptState | undefined
): boolean {
  return Boolean(state && state.subagents.size > 0)
}

export function reconcileCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  transcriptPath: string | undefined
): void {
  const normalizedPath = normalizedTranscriptPath(transcriptPath)
  if (!normalizedPath) {
    return
  }
  if (state.parent.filePath !== normalizedPath) {
    for (const id of state.subagents.keys()) {
      finishCodexSubagent(roster, id)
    }
    state.parent = { filePath: normalizedPath, offset: 0, carry: '' }
    state.subagents.clear()
    state.followupTaskCallIds = new BoundedMap<string, true>({
      maxEntries: MAX_SUBAGENT_TRACKING_ENTRIES
    })
    state.retiredSubagentCursorsById = new BoundedMap<string, TrackedTranscriptSubagent>({
      maxEntries: MAX_SUBAGENT_TRACKING_ENTRIES
    })
    state.reviewerCursorsByPath.clear()
    state.reviewersByPath.clear()
    // Why: a different rollout is a different session, so its predecessor's reviewer is void.
    state.approvalsReviewer = undefined
  }
  const parentRecords = readJsonlCursor(state.parent)
  // A stale reviewer must never turn an unreadable rollout into a hidden prompt.
  state.approvalsReviewer =
    parentRecords === undefined
      ? undefined
      : (readApprovalsReviewer(parentRecords) ?? state.approvalsReviewer)
  const entriesByDirectory = new Map<string, string[]>()
  const childPathFor = (id: string, startedAt: number) =>
    resolveChildTranscript(normalizedPath, id, startedAt, entriesByDirectory)
  for (const recordValue of parentRecords ?? []) {
    const followupCallId = readFollowupTaskCallId(recordValue)
    if (followupCallId) {
      state.followupTaskCallIds.set(followupCallId, true)
    }
    const output = recordValue.type === 'response_item' ? record(recordValue.payload) : undefined
    if (output?.type === 'function_call_output' && typeof output.call_id === 'string') {
      state.followupTaskCallIds.delete(output.call_id.trim())
    }
    const activity = readActivity(recordValue)
    if (!activity) {
      continue
    }
    const followupTriggered = activity.eventId
      ? state.followupTaskCallIds.delete(activity.eventId)
      : false
    if (activity.kind === 'interacted' && !followupTriggered) {
      continue
    }
    const pathSegments = activity.description?.split('/').filter(Boolean)
    if (pathSegments?.length === 1 && pathSegments[0] === 'root') {
      continue
    }
    if (activity.kind === 'interrupted' || activity.kind === 'completed') {
      const tracked = state.subagents.get(activity.id)
      const retired = state.retiredSubagentCursorsById.get(activity.id)
      const completedTurnId = readCompletedTurnId(activity.kind, activity.eventId)
      if (completedTurnId && tracked?.retiredTurnId === completedTurnId) {
        continue
      }
      const cursor = tracked ?? retired ?? { offset: 0, carry: '', startedAt: activity.startedAt }
      const retiredTurnId = completedTurnId ?? cursor.currentTurnId ?? cursor.retiredTurnId
      cursor.retiredTurnId = retiredTurnId
      cursor.awaitingRetiredTurnComplete =
        activity.kind === 'completed' &&
        Boolean(retiredTurnId) &&
        cursor.completedTurnId !== retiredTurnId
      storeChildCursor(state, activity.id, cursor)
      finishCodexSubagent(roster, activity.id)
      state.subagents.delete(activity.id)
      continue
    }
    const retiredCursor = state.retiredSubagentCursorsById.get(activity.id)
    const tracked = state.subagents.get(activity.id) ?? {
      ...(retiredCursor ?? { offset: 0, carry: '' }),
      awaitingTaskStarted: Boolean(retiredCursor),
      startedAt: activity.startedAt
    }
    if (retiredCursor) {
      state.retiredSubagentCursorsById.delete(activity.id)
    }
    tracked.description = activity.description ?? tracked.description
    state.subagents.set(activity.id, tracked)
    upsertCodexSubagent(
      roster,
      activity.id,
      { description: tracked.description, state: 'working' },
      tracked.startedAt
    )
  }
  for (const [id, tracked] of state.subagents) {
    tracked.filePath ??= childPathFor(id, tracked.startedAt)
    const records = readJsonlCursor(tracked)
    if (!records) {
      // A missing rollout cannot prove the child exited; wait for terminal activity.
      tracked.filePath = undefined
      continue
    }
    tracked.model = readChildModel(records) ?? tracked.model
    // Reapply after each upsert, which can rebuild the child roster row.
    setCodexSubagentModel(roster, id, tracked.model)
    if (!childIsComplete(records, tracked)) {
      continue
    }
    tracked.retiredTurnId = tracked.currentTurnId
    storeChildCursor(state, id, tracked)
    finishCodexSubagent(roster, id)
    state.subagents.delete(id)
  }
}
