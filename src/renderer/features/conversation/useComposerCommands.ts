import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { Ref } from 'vue'
import { isCompactCommand, matchesCompactCommand } from '@shared/manual-compaction'
import type { Skill } from '@shared/skills'
import { getDesktopApi } from '@/lib/desktop'
import type { DraftSkill } from './state'

export const compactCommandId = 'composer-compact-command'

export interface SkillOption extends Skill {
  id: string
  sharedName: boolean
}

export function useComposerCommands(
  draft: Readonly<Ref<string>>,
  hasAttachments: Readonly<Ref<boolean>>,
  available: Readonly<Ref<boolean>>,
) {
  const focused = ref(false)
  const dismissed = ref(false)
  const selectedId = ref<string | null>(null)
  const skills = shallowRef<SkillOption[]>([])
  const loading = ref(false)
  const failed = ref(false)
  let disposed = false

  const query = computed(
    () =>
      draft.value
        .trim()
        .match(/^\/([^\s/\\]{0,128})$/u)?.[1]
        ?.toLowerCase() ?? null,
  )
  const open = computed(
    () => available.value && focused.value && !dismissed.value && query.value !== null,
  )
  const showCompact = computed(() => !hasAttachments.value && matchesCompactCommand(draft.value))
  const matchingSkills = computed(() => {
    const filter = query.value
    if (filter === null) return []
    return skills.value.filter(
      ({ name, description }) =>
        name.toLowerCase().includes(filter) || description.toLowerCase().includes(filter),
    )
  })
  const optionIds = computed(() => [
    ...(showCompact.value ? [compactCommandId] : []),
    ...matchingSkills.value.map((option) => option.id),
  ])
  const activeId = computed(() => {
    const id = selectedId.value
    return id && optionIds.value.includes(id) ? id : (optionIds.value[0] ?? null)
  })
  const requestingCompact = computed(
    () =>
      showCompact.value &&
      (open.value ? activeId.value === compactCommandId : isCompactCommand(draft.value)),
  )

  function focus(): void {
    focused.value = true
    dismissed.value = false
  }
  function dismiss(): void {
    dismissed.value = true
  }
  function move(direction: -1 | 1): void {
    const ids = optionIds.value
    if (!ids.length) return
    const index = activeId.value ? ids.indexOf(activeId.value) : 0
    selectedId.value = ids[(index + direction + ids.length) % ids.length] ?? null
  }
  function skillForOption(id: string): DraftSkill | null {
    if (!open.value) return null
    const skill = matchingSkills.value.find((item) => item.id === id)
    if (!skill) return null
    return { name: skill.name, ...(skill.sharedName ? { path: skill.path } : {}) }
  }
  async function readSkills(): Promise<void> {
    if (loading.value) return
    loading.value = true
    failed.value = false
    skills.value = []
    try {
      const result = await getDesktopApi().listSkills()
      if (disposed || !open.value) return
      if (!result.ok) throw new Error(result.error)
      const names = new Map<string, number>()
      for (const skill of result.value) {
        const name = skill.name.toLowerCase()
        names.set(name, (names.get(name) ?? 0) + 1)
      }
      skills.value = result.value
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((skill, index) => ({
          ...skill,
          id: `composer-skill-${index}`,
          sharedName: (names.get(skill.name.toLowerCase()) ?? 0) > 1,
        }))
    } catch {
      if (!disposed && open.value) failed.value = true
    } finally {
      if (!disposed) loading.value = false
    }
  }

  watch([draft, hasAttachments], () => {
    dismissed.value = false
    selectedId.value = null
  })
  watch(open, (visible) => {
    selectedId.value = null
    if (visible) void readSkills()
    else skills.value = []
  })
  onScopeDispose(() => {
    disposed = true
  })

  return {
    focused,
    open,
    showCompact,
    activeId,
    requestingCompact,
    matchingSkills,
    loading,
    failed,
    focus,
    dismiss,
    move,
    skillForOption,
  }
}
