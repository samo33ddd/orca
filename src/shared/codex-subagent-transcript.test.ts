import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Why: ESM namespaces are not configurable, so counting rollout opens needs a
// delegating mock rather than vi.spyOn. Every other export stays real.
const openSyncCalls = vi.hoisted(() => vi.fn())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      openSyncCalls(...args)
      return actual.openSync(...args)
    }
  }
})

import {
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import { codexRosterToSnapshots, type CodexSubagentRoster } from './codex-subagent-roster'

const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function activity(
  kind: string,
  occurredAtMs = 1234,
  agentThreadId = CHILD_ID,
  agentPath = '/root/sidebar_repro',
  eventId = `${agentThreadId}-${kind}-${occurredAtMs}`
): unknown {
  return {
    type: 'event_msg',
    payload: {
      type: 'sub_agent_activity',
      event_id: eventId,
      occurred_at_ms: occurredAtMs,
      agent_thread_id: agentThreadId,
      agent_path: agentPath,
      kind
    }
  }
}

function toolCall(name: 'send_message' | 'followup_task', callId: string): unknown {
  return {
    type: 'response_item',
    payload: { type: 'function_call', call_id: callId, name, arguments: '{}' }
  }
}

function toolCallOutput(callId: string): unknown {
  return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId } }
}

function childTaskEvent(
  type: 'task_started' | 'task_complete',
  turnId: string,
  outcome?: 'error'
): unknown {
  return { type: 'event_msg', payload: { type, turn_id: turnId, ...(outcome ? { outcome } : {}) } }
}

/** `<root>/YYYY/MM/DD` for a timestamp, matching how Codex buckets rollouts by local start date. */
function dayDirectory(root: string, atMs: number): string {
  const at = new Date(atMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return join(root, String(at.getFullYear()), pad(at.getMonth() + 1), pad(at.getDate()))
}

describe('Codex subagent transcript reconciliation', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('adds a child from the parent rollout and removes it after task completion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, jsonl([activity('started')]))
    writeFileSync(childPath, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)
    expect(codexRosterToSnapshots(roster)).toEqual([
      {
        id: CHILD_ID,
        description: '/root/sidebar_repro',
        state: 'working',
        startedAt: 1234,
        agentType: undefined,
        model: undefined
      }
    ])

    writeFileSync(
      childPath,
      jsonl([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(codexRosterToSnapshots(roster)).toBeUndefined()
  })

  it('resolves a child rollout filed under a later session day than the parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(root)
    const childStartedAt = Date.now()
    const parentDir = dayDirectory(root, childStartedAt - 24 * 60 * 60 * 1000)
    const childDir = dayDirectory(root, childStartedAt)
    mkdirSync(parentDir, { recursive: true })
    mkdirSync(childDir, { recursive: true })
    const parentPath = join(parentDir, 'rollout-parent.jsonl')
    const childPath = join(childDir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(parentPath, jsonl([activity('started', childStartedAt)]))
    writeFileSync(childPath, jsonl([{ type: 'event_msg', payload: { type: 'task_started' } }]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)
    writeFileSync(
      childPath,
      jsonl([
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    // Why: only a cross-day lookup can observe the completion; the parent-directory scan never finds this file.
    expect(roster.size).toBe(0)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
  })

  it('does not treat an unreadable child rollout as proof of completion', () => {
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
      dirs.push(dir)
      const parentPath = join(dir, 'rollout-parent.jsonl')
      writeFileSync(parentPath, jsonl([activity('started')]))
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()

      reconcileCodexSubagentTranscript(state, roster, parentPath)
      expect(roster.size).toBe(1)

      // Why: within the grace window a slow-to-appear rollout must not drop a live child.
      vi.advanceTimersByTime(30_000)
      reconcileCodexSubagentTranscript(state, roster, parentPath)
      expect(roster.size).toBe(1)

      vi.advanceTimersByTime(31_000)
      reconcileCodexSubagentTranscript(state, roster, parentPath)
      expect(roster.size).toBe(1)
      expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes a child when Codex reports it interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(parentPath, jsonl([activity('started')]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    writeFileSync(parentPath, jsonl([activity('started'), activity('interrupted')]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(roster.size).toBe(0)
  })

  it('removes a child on the current completed activity even without a readable child rollout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(
      parentPath,
      jsonl([
        activity('started'),
        activity('started'),
        activity('completed', 1235),
        activity('completed', 1235)
      ])
    )
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(roster.size).toBe(0)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
  })

  it('does not count the root agent path as its own child', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(parentPath, jsonl([activity('started', 1234, 'root-thread', '/root')]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(roster.size).toBe(0)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
  })

  it('keeps one child row through repeated started and interacted events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(
      parentPath,
      jsonl([
        activity('started'),
        activity('started'),
        activity('interacted', 1235),
        activity('interacted', 1235)
      ])
    )
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(codexRosterToSnapshots(roster)).toMatchObject([
      { id: CHILD_ID, state: 'working', startedAt: 1234, description: '/root/sidebar_repro' }
    ])
  })

  it('does not reactivate a completed child for send_message but accepts followup_task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(parentPath, jsonl([activity('started')]))
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(roster.size).toBe(1)

    appendFileSync(parentPath, jsonl([activity('completed', 1235)]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(roster.size).toBe(0)

    const sendMessageCallId = 'call-send-message'
    appendFileSync(parentPath, jsonl([toolCall('send_message', sendMessageCallId)]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    appendFileSync(
      parentPath,
      jsonl([activity('interacted', 1236, CHILD_ID, '/root/sidebar_repro', sendMessageCallId)])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(roster.size).toBe(0)

    const followupCallId = 'call-followup-task'
    appendFileSync(parentPath, jsonl([toolCall('followup_task', followupCallId)]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    appendFileSync(
      parentPath,
      jsonl([
        activity('interacted', 1237, CHILD_ID, '/root/sidebar_repro', followupCallId),
        toolCallOutput(followupCallId)
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(codexRosterToSnapshots(roster)).toMatchObject([
      { id: CHILD_ID, state: 'working', startedAt: 1237, description: '/root/sidebar_repro' }
    ])
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(codexRosterToSnapshots(roster)).toMatchObject([
      { id: CHILD_ID, state: 'working', startedAt: 1237, description: '/root/sidebar_repro' }
    ])
    expect(roster.size).toBe(1)
  })

  it('keeps a followup active until the new child task completes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
    const followupCallId = 'call-followup-after-complete'
    const olderTurnId = 'turn-older'
    const oldTurnId = 'turn-old'
    const newTurnId = 'turn-new'
    writeFileSync(
      parentPath,
      jsonl([
        activity('started'),
        activity(
          'completed',
          1235,
          CHILD_ID,
          '/root/sidebar_repro',
          `subagent-completed-${oldTurnId}`
        )
      ])
    )
    writeFileSync(
      childPath,
      jsonl([
        childTaskEvent('task_started', olderTurnId),
        childTaskEvent('task_complete', olderTurnId),
        childTaskEvent('task_started', oldTurnId),
        childTaskEvent('task_complete', oldTurnId)
      ])
    )
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()

    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(roster.size).toBe(0)

    appendFileSync(
      parentPath,
      jsonl([
        toolCall('followup_task', followupCallId),
        activity('interacted', 1236, CHILD_ID, '/root/sidebar_repro', followupCallId)
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(codexRosterToSnapshots(roster)).toMatchObject([
      { id: CHILD_ID, state: 'working', startedAt: 1236, description: '/root/sidebar_repro' }
    ])
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(true)

    appendFileSync(
      parentPath,
      jsonl([
        activity(
          'completed',
          1237,
          CHILD_ID,
          '/root/sidebar_repro',
          `subagent-completed-${oldTurnId}`
        )
      ])
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(roster.size).toBe(1)

    appendFileSync(childPath, jsonl([childTaskEvent('task_started', newTurnId)]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(roster.size).toBe(1)

    appendFileSync(childPath, jsonl([childTaskEvent('task_complete', newTurnId, 'error')]))
    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    expect(roster.size).toBe(0)
  })

  it('clears failed followup calls and bounds pending followup correlations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const state = createCodexSubagentTranscriptState()
    const roster: CodexSubagentRoster = new Map()
    writeFileSync(
      parentPath,
      jsonl([toolCall('followup_task', 'call-failed'), toolCallOutput('call-failed')])
    )

    reconcileCodexSubagentTranscript(state, roster, parentPath)
    expect(state.followupTaskCallIds.has('call-failed')).toBe(false)

    const pendingCallIds = Array.from({ length: 260 }, (_, index) => `call-bounded-${index}`)
    appendFileSync(
      parentPath,
      jsonl(pendingCallIds.map((callId) => toolCall('followup_task', callId)))
    )
    reconcileCodexSubagentTranscript(state, roster, parentPath)

    expect(state.followupTaskCallIds.has(pendingCallIds[0] ?? '')).toBe(false)
    expect(state.followupTaskCallIds.has(pendingCallIds[3] ?? '')).toBe(false)
    expect(state.followupTaskCallIds.has(pendingCallIds[4] ?? '')).toBe(true)
    expect(state.followupTaskCallIds.has(pendingCallIds.at(-1) ?? '')).toBe(true)
  })

  describe('child model identity', () => {
    function turnContext(model: string): unknown {
      return { type: 'turn_context', payload: { turn_id: 'turn-1', model } }
    }

    function started(): unknown {
      return { type: 'event_msg', payload: { type: 'task_started' } }
    }

    /** Parent rollout with one live child, plus that child's own rollout. */
    function seedPair(childRecords: unknown[]): {
      parentPath: string
      childPath: string
    } {
      const dir = mkdtempSync(join(tmpdir(), 'codex-subagent-model-'))
      dirs.push(dir)
      const parentPath = join(dir, 'rollout-parent.jsonl')
      const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
      writeFileSync(parentPath, jsonl([turnContext('gpt-5.6-sol'), activity('started')]))
      writeFileSync(childPath, jsonl(childRecords))
      return { parentPath, childPath }
    }

    it('reports the model from the child rollout, not the parent model', () => {
      const { parentPath } = seedPair([started(), turnContext('gpt-5.6-terra')])
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()

      reconcileCodexSubagentTranscript(state, roster, parentPath)

      // The parent runs sol; only the child's own turn_context may set its model.
      expect(codexRosterToSnapshots(roster)?.[0]?.model).toBe('gpt-5.6-terra')
    })

    it('keeps the discovered model when a later poll carries no turn_context', () => {
      const { parentPath, childPath } = seedPair([started(), turnContext('gpt-5.6-terra')])
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()
      reconcileCodexSubagentTranscript(state, roster, parentPath)

      // The cursor is incremental: this appended line is all the next read sees.
      writeFileSync(
        childPath,
        jsonl([
          started(),
          turnContext('gpt-5.6-terra'),
          { type: 'event_msg', payload: { type: 'agent_message' } }
        ])
      )
      reconcileCodexSubagentTranscript(state, roster, parentPath)

      expect(codexRosterToSnapshots(roster)?.[0]?.model).toBe('gpt-5.6-terra')
    })

    it('tracks the newest model when the child switches mid-session', () => {
      const { parentPath } = seedPair([
        started(),
        turnContext('gpt-5.6-terra'),
        turnContext('gpt-5.6-sol')
      ])
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()

      reconcileCodexSubagentTranscript(state, roster, parentPath)

      expect(codexRosterToSnapshots(roster)?.[0]?.model).toBe('gpt-5.6-sol')
    })

    it('leaves the child working and keeps its identity while reading the model', () => {
      const { parentPath } = seedPair([started(), turnContext('gpt-5.6-terra')])
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()

      reconcileCodexSubagentTranscript(state, roster, parentPath)

      // Model discovery must not move lifecycle or overwrite the child's label.
      expect(codexRosterToSnapshots(roster)).toEqual([
        {
          id: CHILD_ID,
          description: '/root/sidebar_repro',
          state: 'working',
          startedAt: 1234,
          agentType: undefined,
          model: 'gpt-5.6-terra'
        }
      ])
    })

    it('does not resurrect a child that completed in the same read', () => {
      const { parentPath } = seedPair([
        started(),
        turnContext('gpt-5.6-terra'),
        { type: 'event_msg', payload: { type: 'task_complete' } }
      ])
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()

      reconcileCodexSubagentTranscript(state, roster, parentPath)

      expect(roster.size).toBe(0)
      expect(hasTrackedCodexTranscriptSubagents(state)).toBe(false)
    })

    it('reads the model without opening any file beyond the parent and child rollouts', () => {
      const { parentPath } = seedPair([started(), turnContext('gpt-5.6-terra')])
      const state = createCodexSubagentTranscriptState()
      const roster: CodexSubagentRoster = new Map()
      openSyncCalls.mockClear()

      reconcileCodexSubagentTranscript(state, roster, parentPath)

      // Why: model extraction reuses the records already read for completion
      // detection, so it must add no file I/O of its own.
      expect(openSyncCalls).toHaveBeenCalledTimes(2)
      expect(codexRosterToSnapshots(roster)?.[0]?.model).toBe('gpt-5.6-terra')
    })
  })
})
