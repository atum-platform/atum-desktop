import type { LookPackGround, LookPackPublished } from '../../../shared/look-pack'
import type { MatrixAppMenu } from '../../../shared/matrix'

/**
 * Declared app data for the side panel's look-pack proof .
 * Moon's pack is the published contract fixture (fixtures.ts). Andy's and Demoza's are
 * illustrative packs in the same `atum.look-pack/1` shape, not published catalog rows: Andy a
 * light paper ground with a tiled pattern, Demoza a colour-only ground. "Orbit" declares
 * nothing, so it shows the default Kit panel. The renderer reads none of these names.
 */

/** The playground's art files by look-asset digest, for the real-Chromium proof to serve. */
export const PLAYGROUND_LOOK_ASSET_FILES: Record<string, string> = {
  // Moon's published SVG variant (shared/__fixtures__/look-pack-v1).
  '7b6e946ecb9cbbe0dd1fe6ea799150b2394694f608f5350223265509d34c62dc':
    'shared/__fixtures__/look-pack-v1/assets/moon-gravity-well-atum.svg',
  b5a5d14ac4583d4f29237d5db6a780c3d46ab6491c1deecfc39a461bca7f0be7: 'src/matrix/playground/assets/andy-grid.svg',
  // Moon's proposed panel ground: its orbit lattice in navy on paper (fixtures.ts).
  '6f2c6c150730f2d87dcf760b29f6ea94dbadf410a9b53987b63207946ccf05d2': 'src/matrix/playground/assets/moon-orbit-lattice-paper.svg'
}

const ANDY_GRID = {
  sha256: 'b5a5d14ac4583d4f29237d5db6a780c3d46ab6491c1deecfc39a461bca7f0be7',
  kind: 'vector' as const,
  width: 24,
  height: 24,
  variants: [
    {
      mime: 'image/svg+xml' as const,
      sha256: 'b5a5d14ac4583d4f29237d5db6a780c3d46ab6491c1deecfc39a461bca7f0be7',
      bytes: 258,
      width: 24,
      height: 24,
      use: 'full' as const
    }
  ]
}

const tiled = (tone: LookPackGround['tone'], base: string, opacity: number): LookPackGround => ({
  tone,
  base,
  layers: [{ asset: ANDY_GRID, fit: 'tile', tile_px: 24, position: 'center', opacity }]
})

const legacyPresentation = {
  radii: { owner_bubble: 'xl', app_bubble: 'xl', composer: 'xl' },
  fonts: { ui: 'system-sans', body: 'system-sans' },
  composer: null
} as const

export const PLAYGROUND_ANDY_LOOK = {
  profile: 'atum.look-pack/1',
  pack_id: '00000000-0000-4000-8000-519d966274c9',
  version: 1,
  digest: 'c'.repeat(64),
  publisher: { kind: 'app', app_id: '00000000-0000-4000-8000-a8353ed0bde9' },
  name: { en: 'Andy', vi: 'Andy' },
  accent: { light: '#3D4A5C', dark: '#9FB3CC' },
  chat: {
    background: { light: tiled('light', '#EEF1F4', 0.7), dark: tiled('dark', '#1B2230', 0.45) },
    tokens: {
      colors: {
        foreground: '#151A22',
        background: '#EEF1F4',
        owner_bubble: '#DCE3EC',
        app_bubble: '#FFFFFF',
        bubble_foreground: '#151A22',
        border: '#D5DBE3'
      },
      ...legacyPresentation
    }
  },
  start_card: null,
  regions: {},
  derived: {
    light: {
      worst: '#E2E6EC',
      ink: '#151A22FF',
      ink_soft: '#151A22F2',
      ink_muted: '#151A22B8',
      ink_faint: '#151A2299',
      line: '#151A2229',
      scrim: '#EEF1F4'
    },
    dark: {
      worst: '#2A3242',
      ink: '#F2F4F8FF',
      ink_soft: '#F2F4F8F2',
      ink_muted: '#F2F4F8C2',
      ink_faint: '#F2F4F899',
      line: '#F2F4F833',
      scrim: '#1B2230'
    }
  }
} satisfies LookPackPublished

export const PLAYGROUND_Demoza_LOOK = {
  profile: 'atum.look-pack/1',
  pack_id: '00000000-0000-4000-8000-f4a116c11a9d',
  version: 1,
  digest: 'd'.repeat(64),
  publisher: { kind: 'app', app_id: '00000000-0000-4000-8000-6b7be92641ae' },
  name: { en: 'Demoza', vi: 'Demoza' },
  accent: { light: '#A4553F', dark: '#E3A08C' },
  chat: {
    background: {
      light: { tone: 'light', base: '#F7EDE9', layers: [] },
      dark: { tone: 'dark', base: '#2A1F1D', layers: [] }
    },
    tokens: {
      colors: {
        foreground: '#2A1F1D',
        background: '#F7EDE9',
        owner_bubble: '#F0D9D0',
        app_bubble: '#FFFFFF',
        bubble_foreground: '#2A1F1D',
        border: '#E9D6CF'
      },
      ...legacyPresentation
    }
  },
  start_card: null,
  regions: {},
  derived: {
    light: {
      worst: '#F7EDE9',
      ink: '#2A1F1DFF',
      ink_soft: '#2A1F1DF2',
      ink_muted: '#2A1F1DB8',
      ink_faint: '#2A1F1D99',
      line: '#2A1F1D24',
      scrim: '#F7EDE9'
    },
    dark: {
      worst: '#2A1F1D',
      ink: '#F8EFEBFF',
      ink_soft: '#F8EFEBF2',
      ink_muted: '#F8EFEBC2',
      ink_faint: '#F8EFEB99',
      line: '#F8EFEB33',
      scrim: '#2A1F1D'
    }
  }
} satisfies LookPackPublished

type Route = MatrixAppMenu['routes'][number]

const route = (id: string, en: string, vi: string, icon: string, session: Route['session'] = 'required'): Route => ({
  id,
  label: { en, vi },
  icon,
  session
})

/** Each fixture app's declared functions, as the catalog's menu read returns them. */
export const PLAYGROUND_APP_MENUS: Record<string, Pick<MatrixAppMenu, 'routes' | 'actions'>> = {
  // Moon's glyph strings as its approved version declares them (Tabler-style legacy names that
  // the desktop alias table maps to Phosphor), so the proof shows what production draws.
  moon: {
    routes: [
      route('chat', 'Chat', 'Trò chuyện', 'message'),
      route('library', 'Library', 'Thư viện', 'books'),
      route('readings', 'Readings', 'Luận Giải', 'book-2'),
      route('match', 'Match', 'Nhân Duyên', 'hearts'),
      route('tarot', 'Tarot', 'Tarot', 'cards'),
      route('birth-time', 'Birth time', 'Dò Giờ Sinh', 'clock-search')
    ],
    actions: [
      route('chat', 'Chat', 'Trò chuyện', 'message'),
      route('tarot', 'Tarot', 'Tarot', 'cards'),
      route('match', 'Match', 'Nhân Duyên', 'hearts'),
      route('top-up', 'Top up', 'Nạp tin nhắn', 'coin')
    ]
  },
  andy: {
    routes: [
      route('chat', 'Chat', 'Trò chuyện', 'chat'),
      route('tasks', 'Tasks', 'Việc cần làm', 'checklist'),
      route('calendar', 'Calendar', 'Lịch', 'calendar'),
      route('notes', 'Notes', 'Ghi chú', 'file'),
      route('settings', 'Settings', 'Cài đặt', 'settings')
    ]
  },
  demoza: {
    routes: [
      route('chat', 'Chat', 'Trò chuyện', 'chat'),
      route('routine', 'My routine', 'Quy trình của tôi', 'sparkles'),
      route('scan', 'Skin check', 'Kiểm tra da', 'camera'),
      route('shop', 'Products', 'Sản phẩm', 'shop')
    ]
  },
  // An app this client has never heard of: an alias it does not know draws the generic glyph.
  orbit: {
    routes: [
      route('chat', 'Chat', 'Trò chuyện', 'chat'),
      route('home', 'Home', 'Trang chủ', 'home', 'none'),
      route('board', 'Board', 'Bảng', 'zz-unknown-glyph', 'none'),
      route('files', 'Files', 'Tệp', 'file', 'none')
    ]
  },
  river: { routes: [route('home', 'Open', 'Mở', 'globe', 'none')] },
  atlas: { routes: [route('home', 'Open', 'Mở', 'globe', 'none')] }
}
