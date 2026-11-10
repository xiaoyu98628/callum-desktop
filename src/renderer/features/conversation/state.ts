import { reactive } from 'vue'
import type {
  ChatEvent,
  ChatModel,
  ChatRun,
  Conversation,
  ConversationDetail,
  Workspace,
  UserInputAnswer,
} from '../../../shared/chat.ts'
import type { ExecutionSettings } from '../../../shared/execution.ts'
import type { ContextUsage } from '../../../shared/context-usage.ts'
export interface ConversationGroup {
  items: Conversation[]
  loading: boolean
  error: string
  hasMore: boolean
  offset: number
  revision: number
  generation: number
  expanded: boolean
  events: Map<string, ChatEvent>
}

export function createConversationState() {
  const state = reactive({
    conversations: [] as Conversation[],
    models: [] as ChatModel[],
    selectedId: null as string | null,
    workspaceId: null as string | null,
    workspaces: [] as Workspace[],
    workspaceGroups: {} as Record<string, ConversationGroup>,
    workspacesLoading: false,
    workspacesError: '',
    workspacesHasMore: false,
    managing: false,
    archivesOpen: false,
    archivedConversations: [] as Conversation[],
    archivedWorkspaces: [] as Workspace[],
    archiveKind: 'conversations' as 'conversations' | 'workspaces',
    archivesLoading: false,
    archivesError: '',
    archivesHasMore: false,
    modelId: '',
    detail: null as ConversationDetail | null,
    activeRuns: {} as Record<string, ChatRun>,
    loading: true,
    loadingList: true,
    sending: false,
    resending: false,
    compacting: '',
    executionSettings: null as ExecutionSettings | null,
    executionSettingsLoading: false,
    executionSettingsSaving: false,
    executionSettingsError: '',
    contextUsageEvent: null as ContextUsage | null,
    usageActivityRevision: 0,
    editing: null as {
      messageId: string
      originalText: string
      text: string
      error: string
    } | null,
    cancelling: false,
    deciding: '',
    revokingDirectory: '',
    directoriesLoading: false,
    directoriesOffset: 0,
    directoriesError: '',
    replying: '',
    inputReplies: {} as Record<string, UserInputAnswer>,
    collapsedCards: {} as Record<string, boolean>,
    error: '',
    serviceError: '',
    modelsLoading: false,
    modelError: '',
    hasMore: false,
    historical: false,
    drafts: {} as Record<string, string>,
  })
  return state
}
export type ConversationState = ReturnType<typeof createConversationState>
