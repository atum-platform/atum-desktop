import { describe, expect, it } from 'vitest'

import codeSwitch from './code-switch.json'
import { en } from './en'
import { ja } from './ja'
import { vi } from './vi'
import { zh } from './zh'
import { zhHant } from './zh-hant'

function render(value: unknown, args?: string[]): string {
  if (typeof value === 'function') {
    return String(value(...(args ?? Array.from({ length: value.length }, () => 'X'))))
  }

  return String(value)
}

function isApprovedCodeSwitch(value: string): boolean {
  return codeSwitch.terms.some(term => value === term || value.replaceAll(term, '').trim() === '')
}

function englishLeaks(enNode: unknown, viNode: unknown, path: string): string[] {
  if (enNode && typeof enNode === 'object' && !Array.isArray(enNode) && typeof enNode !== 'function') {
    return Object.keys(enNode as Record<string, unknown>).flatMap(key =>
      englishLeaks(
        (enNode as Record<string, unknown>)[key],
        (viNode as Record<string, unknown> | undefined)?.[key],
        path ? `${path}.${key}` : key
      )
    )
  }

  // Enum formatters need real values: the generic 'X' probe would compare
  // undefined with undefined and miss the copy displayed in every valid state.
  const probes =
    path === 'dm.group.specialistTargetState'
      ? [['available'], ['specialist_not_linked'], ['specialist_room_unsupported']]
      : [undefined]

  return probes.flatMap(args => {
    const english = render(enNode, args)

    return english === render(viNode, args) && !isApprovedCodeSwitch(english) ? [path] : []
  })
}

function renderedLeaves(node: unknown): string[] {
  if (node && typeof node === 'object' && !Array.isArray(node) && typeof node !== 'function') {
    return Object.values(node as Record<string, unknown>).flatMap(renderedLeaves)
  }

  if (Array.isArray(node)) {
    return node.flatMap(renderedLeaves)
  }

  return [render(node)]
}

describe('Vietnamese-first P0 copy', () => {
  it('locks the founder-facing Atum copy verbatim', () => {
    expect(vi.onboarding).toMatchObject({
      headerDesc:
        'Điều khiển mọi tác vụ trên máy tính, sử dụng app yêu thích, nhắn tin cho bạn bè - tất cả cùng một nơi.',
      headerSub: 'AI Superapp cho người Việt',
      headerTitle: 'Atum'
    })
    expect(vi.intro).toEqual({
      body: 'Hỏi bất cứ điều gì, hoặc giao cho Atum một việc trên máy của bạn.',
      heading: 'Bắt đầu với Atum'
    })
  })

  it('covers the chat, recovery, navigation, and tool approval path', () => {
    expect(vi.composer.newSessionPlaceholders).toEqual(['Nhắn cho Atum…'])
    expect(vi.composer).toMatchObject({
      placeholderFollowUp: 'Nhắn tiếp cho Atum…',
      send: 'Gửi',
      stop: 'Dừng',
      thinking: 'Đang suy nghĩ'
    })
    expect(vi.sidebar.nav).toEqual({
      artifacts: 'Tệp kết quả',
      messaging: 'Tin nhắn',
      'new-session': 'Trò chuyện mới',
      skills: 'Kỹ năng'
    })
    expect(vi.sidebar.emptyRoster).toBe('Chưa có cuộc trò chuyện nào')
    expect(vi.errors.offline).toBe('Mất kết nối. Atum sẽ tự kết nối lại.')
    expect(vi.errors.turnFailed).toBe('Không gửi được. Nhấn Thử lại.')
    expect(vi.composer).toMatchObject({
      addContext: 'Thêm ngữ cảnh',
      speakReplies: 'Đọc câu trả lời thành tiếng',
      startVoice: 'Bắt đầu trò chuyện bằng giọng nói',
      voiceDictation: 'Nhập bằng giọng nói',
      wakingProfile: expect.any(Function)
    })
    expect(vi.composer.wakingProfile('')).toBe('Đang kết nối…')
    expect(vi.shell.statusbar.openModelPicker).toBe('Mở trình chọn mô hình')
    expect(vi.assistant.tool).toMatchObject({
      approvalTitle: 'Atum muốn chạy lệnh này',
      approveAlways: 'Luôn cho phép',
      approveOnce: 'Cho phép một lần',
      approveSession: 'Cho phép trong phiên này',
      deny: 'Từ chối',
      statusDone: 'Xong',
      statusRecovered: 'Đã khôi phục',
      statusRunning: 'Đang chạy'
    })
  })

  it('ships the Atum product shell copy Vietnamese-first', () => {
    expect(vi.atum.nav).toEqual({
      aria: 'Điều hướng chính',
      relaunchUpdate: 'Khởi động lại để cập nhật',
      launcher: 'Điều hướng',
      home: 'Trang chính',
      discover: 'Cửa hàng',
      workplaceSoon: 'Nơi làm việc · Sắp có',
      settings: 'Cài đặt',
      account: 'Tài khoản',
      usage: 'Lượt dùng'
    })
    expect(vi.atum.roster).toMatchObject({
      title: 'Trò chuyện',
      search: 'Tìm mọi thứ',
      searchPlaceholder: 'Tìm kiếm',
      assistant: 'Atum',
      badgeFirstParty: 'Ứng dụng Atum',
      badgePartner: 'Ứng dụng đối tác',
      badgeFirstPartyShort: 'Atum',
      badgePartnerShort: 'Đối tác',
      signIn: 'Đăng nhập',
      retry: 'Thử lại',
      emptyChats: 'Chưa có cuộc trò chuyện nào khác',
      emptySearch: 'Không tìm thấy kết quả nào'
    })
    expect(vi.atum.empty.chips).toEqual({
      summarize: 'Tóm tắt tài liệu này giúp mình.',
      openFile: 'Mở một tệp trên máy',
      moon: 'Mở Moon xem lá số',
      today: 'Hôm nay mình nên tập trung vào việc gì?'
    })
    expect(vi.atum.workspace.title).toBe('Bảng làm việc')
    expect(vi.atum.auth.title).toBe('Chào mừng bạn đến với Atum')
    expect(vi.atum.offline.banner).toBe('Đang ngoại tuyến — hiển thị nội dung đã lưu')
  })

  it('never leaks a Hermes noun into the Atum shell vocabulary', () => {
    // Catalog identifiers are implementation details, never rendered copy.
    const copy = renderedLeaves(vi.atum).join('\n').toLowerCase()

    for (const noun of ['hermes', 'session', 'profile', 'phiên làm việc', 'worktree', 'project', 'cron']) {
      expect(copy).not.toContain(noun)
    }
  })
})

describe('Vietnamese preview rail coverage', () => {
  // `defineLocale` merges over `en`, so every key EXISTS in `vi` whether or not
  // it was translated. The only honest completeness check is whether the value
  // still renders the English string.
  it('translates the whole preview namespace — the workspace panel is the demo surface', () => {
    expect(englishLeaks(en.preview, vi.preview, '')).toEqual([])
  })

  it('keeps the workspace panel empty state Vietnamese', () => {
    expect(vi.preview.emptyTitle).toBe('XEM TRƯỚC')
    expect(vi.preview.emptyHint).toBe('Chọn một tệp ở mục Tệp để xem tại đây')
  })

  it('never names Hermes in the Vietnamese preview copy', () => {
    expect(
      JSON.stringify(vi.preview, (_key, value) => (typeof value === 'function' ? render(value) : value))
    ).not.toMatch(/hermes/i)
  })
})

describe('Vietnamese coverage for every Atum consumer surface', () => {
  const reachable = {
    atum: [en.atum, vi.atum],
    boot: [en.boot, vi.boot],
    dm: [en.dm, vi.dm],
    install: [en.install, vi.install],
    language: [en.language, vi.language],
    notifications: [en.notifications, vi.notifications],
    preview: [en.preview, vi.preview],
    'assistant.thread': [en.assistant.thread, vi.assistant.thread],
    'prompts.approval': [en.assistant.tool, vi.assistant.tool],
    'settings.consumer': [
      { atum: en.atum.settings, language: en.language, modeOptions: en.settings.modeOptions },
      { atum: vi.atum.settings, language: vi.language, modeOptions: vi.settings.modeOptions }
    ],
    updates: [en.updates, vi.updates]
  } as const

  it.each(Object.entries(reachable))('has no unapproved English leaves in %s', (namespace, [english, vietnamese]) => {
    expect(englishLeaks(english, vietnamese, namespace)).toEqual([])
  })

  it('contains no Hermes product noun anywhere in Vietnamese copy', () => {
    expect(renderedLeaves(vi).join('\n')).not.toMatch(/Hermes/i)
  })
})

describe('Atum namespace coverage across every locale', () => {
  const LOCALES = { en, ja, vi, zh, 'zh-hant': zhHant }

  // `defineLocale` merges over `en`, so a missing override silently falls back
  // to English. Assert real translations exist rather than that the KEY exists.
  it.each(Object.entries(LOCALES))('%s carries the whole atum namespace', (name, catalog) => {
    expect(Object.keys(catalog.atum).sort()).toEqual(Object.keys(en.atum).sort())
    expect(typeof catalog.atum.roster.unread(3)).toBe('string')
    expect(typeof catalog.atum.roster.results(3)).toBe('string')
    expect(Object.keys(catalog.atum.empty.chips)).toHaveLength(4)
    expect(catalog.atum.workspace.title.length).toBeGreaterThan(0)
    expect(catalog.dm.signInStorage.length).toBeGreaterThan(0)
    expect(catalog.dm.signInPlatform.length).toBeGreaterThan(0)
    expect(catalog.dm.signInLocal.length).toBeGreaterThan(0)

    if (name !== 'en') {
      // A locale that merely inherited English here would be a regression.
      expect(catalog.atum.nav.aria).not.toBe(en.atum.nav.aria)
      expect(catalog.atum.auth.title).not.toBe(en.atum.auth.title)
      expect(catalog.atum.protons.checkout.qrNote).not.toBe(en.atum.protons.checkout.qrNote)
      expect(catalog.atum.protons.checkout.transferNote).not.toBe(en.atum.protons.checkout.transferNote)
      expect(catalog.atum.protons.purchaseTerms).not.toBe(en.atum.protons.purchaseTerms)
      expect(catalog.atum.agents.applyCloudHint).not.toBe(en.atum.agents.applyCloudHint)
      expect(catalog.dm.signInStorage).not.toBe(en.dm.signInStorage)
      expect(catalog.dm.signInPlatform).not.toBe(en.dm.signInPlatform)
      expect(catalog.dm.signInLocal).not.toBe(en.dm.signInLocal)
    }
  })
})

describe('Matrix window copy never falls back to English (FR34)', () => {
  // What the Matrix window (src/matrix, src/matrix-pages) and the shared UI it mounts read from
  // the catalog: whole namespaces where the window owns them, single keys where it borrows a few
  // from an older surface. Every key `en` has here must render a translation in every shipped
  // locale, because `defineLocale` fills a missing key with English instead of failing.
  const MATRIX_COPY = [
    'agents',
    'assistant.approval',
    'assistant.clarify',
    'assistant.thread',
    'assistant.tool',
    'atum',
    'boot',
    'commandCenter.commands',
    'commandCenter.noResults',
    'commandCenter.paletteTitle',
    'commandCenter.searchPlaceholder',
    'common',
    'composer.dictating',
    'composer.preparingAudio',
    'composer.readingAloud',
    'composer.speakingResponse',
    'composer.stopDictation',
    'composer.transcribing',
    'composer.transcribingDictation',
    'composer.voiceDictation',
    'cron',
    'desktop',
    'dm',
    'document',
    'errors',
    'install',
    'intro',
    'keybinds.actions',
    'language',
    'matrixShell',
    'notifications',
    'preview',
    'prompts',
    'rightSidebar.terminal',
    'settings.mcp',
    'settings.modeOptions',
    'settings.providers.localEndpoint',
    'sidebar.pinned',
    'skills',
    'starmap',
    'ui',
    'updates'
  ]

  const LOCALES = { ja, vi, zh, 'zh-hant': zhHant }

  function at(catalog: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], catalog)
  }

  // A template that only arranges its arguments (`${a} ${b}`, `${amount} ₫`) has no words to
  // translate; anything with a letter left over once the probe arguments are gone does.
  function hasWords(path: string): boolean {
    const english = at(en, path)

    const rendered =
      typeof english === 'function'
        ? String(english(...Array.from({ length: english.length }, () => 'X')))
        : String(english)

    return /[A-Za-z]/.test(rendered.replaceAll('X', ''))
  }

  it('reads keys that exist in the English catalog', () => {
    for (const path of MATRIX_COPY) {
      expect(at(en, path), path).toBeDefined()
    }
  })

  it.each(Object.entries(LOCALES))('%s translates every string the Matrix window reads', (_name, catalog) => {
    const fallbacks = MATRIX_COPY.flatMap(path => englishLeaks(at(en, path), at(catalog, path), path)).filter(hasWords)

    expect(fallbacks).toEqual([])
  })
})
