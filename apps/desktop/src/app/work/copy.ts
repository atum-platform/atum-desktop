import type { MatrixWorkViewState } from '../../../shared/matrix-work'

/** "Work" is the product's name in every language (FL keeps it in the fork's Vietnamese lines too). */
export interface WorkWords {
  rail: string
  title: string
  /** The body when the owner view is not painted. Null: nothing to say (the view is there). */
  view: Record<MatrixWorkViewState, string | null>
  retry: string
  addProtons: string
  settings: { title: string; help: string; failed: string }
  /** The title band's controls (design spec §1.4, §8.2): the mode switch and the list toggle. New lives on the view's list. */
  band: { mode: string; work: string; code: string; toggleSidebar: string }
}

const en: WorkWords = {
  rail: 'Work',
  title: 'Work',
  view: {
    starting: 'Opening Work…',
    ready: null,
    unavailable: 'Work couldn’t open just now.',
    off: 'Work is off on this Mac.'
  },
  retry: 'Try again',
  addProtons: 'Add Protons',
  settings: {
    title: 'Work on this Mac',
    help: 'Turn off to stop all Work on this Mac.',
    failed: 'Could not change Work just now.'
  },
  band: { mode: 'Mode', work: 'Work', code: 'Code', toggleSidebar: 'Show or hide sessions' }
}

const vi: WorkWords = {
  rail: 'Work',
  title: 'Work',
  view: {
    starting: 'Đang mở Work…',
    ready: null,
    unavailable: 'Chưa mở được Work.',
    off: 'Work đang tắt trên máy Mac này.'
  },
  retry: 'Thử lại',
  addProtons: 'Nạp Proton',
  settings: {
    title: 'Work trên máy Mac này',
    help: 'Tắt để dừng mọi việc Work trên máy Mac này.',
    failed: 'Chưa đổi được Work lúc này.'
  },
  band: { mode: 'Chế độ', work: 'Work', code: 'Code', toggleSidebar: 'Hiện hoặc ẩn danh sách việc' }
}

const words: Record<'en' | 'vi', WorkWords> = { en, vi }

/** English and Vietnamese in slice A; other languages read English until they are written. */
export function workCopy(locale: string): WorkWords {
  return locale === 'vi' ? words.vi : words.en
}
