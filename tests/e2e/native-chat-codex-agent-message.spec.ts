import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const AGENT_BODY = 'E2E_CODEX_AGENT_MESSAGE_PLAINTEXT'
const CIPHERTEXT = 'E2E_CODEX_CIPHERTEXT_MUST_STAY_HIDDEN'
const REPLAY_CHECKPOINT = 'E2E_CODEX_TRANSCRIPT_REPLAY_CHECKPOINT'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings })
  })
}

async function seedCodexProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e Codex inter-agent message', agentType: 'codex' },
        'Codex',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
  }, args)
}

async function toggleTerminalTabToChatView(
  page: Page,
  args: { tabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate(({ tabId, worktreeId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found for chat toggle')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

function agentMessageRecord(id: string, text: string): unknown {
  return {
    type: 'response_item',
    payload: {
      type: 'agent_message',
      id,
      author: '/root/worker',
      recipient: '/root',
      content: [
        {
          type: 'input_text',
          text: `Message Type: MESSAGE\nTask name: /root\nSender: /root/worker\nPayload:\n${text}`
        },
        { type: 'encrypted_content', encrypted_content: CIPHERTEXT }
      ]
    }
  }
}

test('renders Codex agent messages once with attribution and a safe encrypted-content marker', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-codex-agent-message-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-codex-agent-message-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  registerPostElectronShutdownCleanup(async () => {
    rmSync(scratchDir, { recursive: true, force: true })
  })

  const messageId = `agent-message-${randomUUID()}`
  const messageRecord = agentMessageRecord(messageId, AGENT_BODY)
  const checkpoint = agentMessageRecord(`checkpoint-${randomUUID()}`, REPLAY_CHECKPOINT)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify(messageRecord)}\n${JSON.stringify(messageRecord)}\n${JSON.stringify(checkpoint)}\n`
  )

  await enableNativeChatSetting(orcaPage)
  await seedCodexProviderSession(orcaPage, {
    paneKey: descriptor.paneKey,
    worktreeId: descriptor.worktreeId,
    sessionId,
    transcriptPath
  })
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

  await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
    timeout: 15_000
  })
  const transcriptWindow = orcaPage.locator('[data-native-chat-window]')
  await expect(transcriptWindow).toBeVisible({ timeout: 30_000 })
  await expect(transcriptWindow).toContainText('From: /root/worker')
  await expect(transcriptWindow).toContainText('To: /root')
  await expect(transcriptWindow).toContainText(AGENT_BODY)
  await expect(transcriptWindow).toContainText('Encrypted message content is unavailable.')
  await expect(transcriptWindow).not.toContainText('Message Type:')
  await expect(transcriptWindow).not.toContainText(CIPHERTEXT)

  const agentMessageRow = transcriptWindow.locator('[data-index]').filter({ hasText: AGENT_BODY })
  await expect(agentMessageRow).toHaveCount(1)

  await expect(transcriptWindow).toContainText(REPLAY_CHECKPOINT)
  const checkpointRow = transcriptWindow
    .locator('[data-index]')
    .filter({ hasText: REPLAY_CHECKPOINT })
  await expect(checkpointRow).toHaveCount(1)
  await expect(agentMessageRow).toHaveCount(1)
  await expect(transcriptWindow).not.toContainText(CIPHERTEXT)
  await orcaPage.screenshot({ path: test.info().outputPath('codex-agent-message.png') })
})
