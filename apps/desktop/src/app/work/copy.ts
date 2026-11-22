import type { MatrixWorkAssistants, MatrixWorkViewState } from '../../../shared/matrix-work'

/** "Work" is the product's name in every language (FL keeps it in the fork's Vietnamese lines too). */
export interface WorkWords {
  rail: string
  title: string
  /** The body when the owner view is not painted. Null: nothing to say (the view is there). */
  view: Record<MatrixWorkViewState, string | null>
  retry: string
  addProtons: string
  /** The title pill: short, a state you can read at a glance. */
  pill: Record<Exclude<MatrixWorkAssistants, 'not_enrolled'>, string>
  /** One quiet line under the switch, per state. */
  line: Record<Exclude<MatrixWorkAssistants, 'not_enrolled' | 'needs_grant'>, string>
  switchLabel: string
  /** Gate 4b: the per-Mac switch for the owner's own ChatGPT plan. Off until the owner turns it on. */
  planSwitch: { label: string; help: string }
  reconnect: string
  /** D9 / T13: the enrollment text. One paragraph, everyday words. */
  enrollTitle: string
  enrollBody: string
  allow: string
  notNow: string
  close: string
  /** Agent activity. `name` comes from the account's own agent record. */
  working(name: string, count: number): string
  stopping(name: string): string
  pillWorking(names: string[]): string
  anAssistant: string
  /** Settings: one row to turn Work on or off on this Mac. */
  settings: { title: string; help: string; failed: string }
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
  pill: {
    needs_grant: 'Let assistants work here',
    on: 'Assistants on',
    off: 'Assistants off',
    holding: 'Assistants paused',
    stale: 'Reconnecting',
    unreachable: 'Assistants can’t reach this Mac'
  },
  line: {
    on: 'What they start shows here with their name. You can step in or stop it anytime.',
    off: 'Your own work here isn’t affected.',
    holding: 'Paused for a moment while Work finishes an update.',
    stale: 'Atum is catching up. Assistants can start work again in a moment.',
    unreachable: 'Assistants can’t reach this Mac right now.'
  },
  switchLabel: 'Assistants can start work here',
  planSwitch: {
    label: 'Agents may use my ChatGPT plan here',
    help: 'Only your assistants you chose in your account, and only on this Mac. They use your plan the way you would, and it counts against your own plan. Turn it off anytime: anything they started on it stops.'
  },
  reconnect: 'Try again',
  enrollTitle: 'Let your assistants work on this Mac?',
  enrollBody:
    'Your assistants can start, read and stop work on this Mac, in every folder you add to Work. They can read any Work conversation here at any time, not only when you ask. Their work uses Protons, like everything else they do. This traffic passes through Cloudflare on Atum’s account, which can read it. You can turn this off here anytime.',
  allow: 'Allow',
  notNow: 'Not now',
  close: 'Close',
  working: (name, count) => (count === 1 ? `${name} is working on 1 task` : `${name} is working on ${count} tasks`),
  stopping: name => `Stopping ${name}’s work…`,
  pillWorking: names =>
    names.length === 1 ? `${names[0]} is working` : `${names.length} assistants working`,
  anAssistant: 'An assistant',
  settings: {
    title: 'Work on this Mac',
    help: 'Turn off to stop all Work on this Mac.',
    failed: 'Could not change Work just now.'
  }
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
  pill: {
    needs_grant: 'Cho trợ lý làm việc tại đây',
    on: 'Trợ lý: bật',
    off: 'Trợ lý: tắt',
    holding: 'Trợ lý tạm dừng',
    stale: 'Đang kết nối lại',
    unreachable: 'Trợ lý chưa kết nối được máy này'
  },
  line: {
    on: 'Việc họ bắt đầu hiện ở đây kèm tên họ. Bạn có thể vào giúp hoặc dừng bất cứ lúc nào.',
    off: 'Công việc của chính bạn ở đây không bị ảnh hưởng.',
    holding: 'Tạm dừng một chút trong lúc Work cập nhật xong.',
    stale: 'Atum đang đồng bộ lại. Trợ lý sẽ bắt đầu được việc mới trong giây lát.',
    unreachable: 'Hiện trợ lý chưa kết nối được máy Mac này.'
  },
  switchLabel: 'Trợ lý có thể bắt đầu việc tại đây',
  planSwitch: {
    label: 'Cho phép trợ lý dùng gói ChatGPT của tôi tại đây',
    help: 'Chỉ những trợ lý bạn đã chọn trong tài khoản, và chỉ trên máy Mac này. Họ dùng gói của bạn như bạn dùng, và việc đó tính vào gói của chính bạn. Tắt bất cứ lúc nào: mọi việc họ đã bắt đầu bằng gói này sẽ dừng.'
  },
  reconnect: 'Thử lại',
  enrollTitle: 'Cho trợ lý làm việc trên máy Mac này?',
  enrollBody:
    'Trợ lý của bạn có thể bắt đầu, đọc và dừng công việc trên máy Mac này, trong mọi thư mục bạn thêm vào Work. Họ có thể đọc mọi cuộc trò chuyện Work ở đây bất cứ lúc nào, không chỉ khi bạn nhờ. Công việc của họ dùng Proton, như mọi việc khác họ làm. Dữ liệu này đi qua Cloudflare trên tài khoản của Atum, nơi có thể đọc được nó. Bạn có thể tắt tại đây bất cứ lúc nào.',
  allow: 'Cho phép',
  notNow: 'Để sau',
  close: 'Đóng',
  working: (name, count) => `${name} đang làm ${count} việc`,
  stopping: name => `Đang dừng việc của ${name}…`,
  pillWorking: names => (names.length === 1 ? `${names[0]} đang làm việc` : `${names.length} trợ lý đang làm việc`),
  anAssistant: 'Một trợ lý',
  settings: {
    title: 'Work trên máy Mac này',
    help: 'Tắt để dừng mọi việc Work trên máy Mac này.',
    failed: 'Chưa đổi được Work lúc này.'
  }
}

const words: Record<'en' | 'vi', WorkWords> = { en, vi }

/** English and Vietnamese in slice A; other languages read English until they are written. */
export function workCopy(locale: string): WorkWords {
  return locale === 'vi' ? words.vi : words.en
}
