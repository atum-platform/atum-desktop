import type * as React from 'react'

import { Spinner } from '@/components/ui/spinner'
import {
  AlertCircle,
  AlertTriangle,
  Apps,
  AppWindow,
  Archive,
  ArrowBackUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowsExchange,
  ArrowUp,
  Ban,
  Book,
  Box,
  Broadcast,
  Bug,
  Building,
  Bulb,
  Check,
  CheckCircle2,
  Checklist,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleX,
  ClearAll,
  Clock,
  Cloud,
  CloudDownload,
  Code,
  Compass,
  Copy,
  CreditCard,
  Database,
  DeviceDesktop,
  DeviceMobile,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileDiff,
  Files,
  FileText,
  Flame,
  Flask,
  Fold,
  Folder,
  FolderOpen,
  FolderPlus,
  Folders,
  Gift,
  GitBranch,
  GitFork,
  GitPullRequest,
  Globe,
  GripVertical,
  Heart,
  HelpCircle,
  Home,
  ImageIcon,
  Inbox,
  Json,
  Keyboard,
  KeyRound,
  Layout,
  LayoutColumns,
  LayoutDashboard,
  LayoutSidebar,
  LayoutSidebarRight,
  List,
  ListTree,
  Markdown,
  MessageCircle,
  Mic,
  MicOff,
  Minus,
  MoreHorizontal,
  MoreVertical,
  Package,
  Palette,
  Pause,
  Pencil,
  Pin,
  PinFilled,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Regex,
  Repo,
  Robot,
  Rocket,
  Save,
  Search,
  Server,
  Settings,
  Shield,
  Sparkles,
  SquareArrowRight,
  SquareDot,
  SquareMinus,
  SquarePlus,
  Stack2,
  Star,
  Starmap,
  Tag,
  Target,
  Telescope,
  Terminal,
  TextSize,
  Trash2,
  User,
  UserCircle,
  Volume,
  VolumeX,
  Wrench,
  X,
  Zap
} from '@/lib/icons'
import type { IconComponent as Icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

/**
 * Every codicon name the app passes today → the Tabler glyph that now draws it.
 * Sources swept: JSX `name="…"`, menu/item configs (`icon: '…'`), TOOL_META,
 * AT_ICON_BY_TYPE, GROUP_ICON, markdown-code language map, PanelEmpty /
 * PanelAction `icon` props, notification `icon`, and the persisted project-glyph
 * picker (ICONS in project-menu.tsx — stored values keep resolving).
 */
const CODICON_TO_TABLER: Record<string, Icon> = {
  account: UserCircle,
  add: Plus,
  agent: Robot,
  archive: Archive,
  'arrow-down': ArrowDown,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'arrow-swap': ArrowsExchange,
  'arrow-up': ArrowUp,
  beaker: Flask,
  book: Book,
  broadcast: Broadcast,
  browser: AppWindow,
  bug: Bug,
  check: Check,
  checklist: Checklist,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'circle-slash': Ban,
  'clear-all': ClearAll,
  close: X,
  'close-all': CircleX,
  cloud: Cloud,
  'cloud-download': CloudDownload,
  code: Code,
  'collapse-all': Fold,
  comment: MessageCircle,
  compass: Compass,
  copy: Copy,
  'credit-card': CreditCard,
  dashboard: LayoutDashboard,
  database: Database,
  'debug-pause': Pause,
  'device-desktop': DeviceDesktop,
  'device-mobile': DeviceMobile,
  diff: FileDiff,
  'diff-added': SquarePlus,
  'diff-modified': SquareDot,
  'diff-removed': SquareMinus,
  'diff-renamed': SquareArrowRight,
  discard: ArrowBackUp,
  edit: Pencil,
  ellipsis: MoreHorizontal,
  error: AlertCircle,
  eye: Eye,
  extensions: Apps,
  'eye-closed': EyeOff,
  file: File,
  'file-media': ImageIcon,
  'file-text': FileText,
  files: Files,
  flame: Flame,
  folder: Folder,
  'folder-library': Folders,
  'folder-opened': FolderOpen,
  gift: Gift,
  'git-branch': GitBranch,
  'git-pull-request': GitPullRequest,
  globe: Globe,
  grabber: GripVertical,
  graph: Starmap,
  gripper: GripVertical,
  heart: Heart,
  home: Home,
  inbox: Inbox,
  hubot: Robot,
  json: Json,
  'kebab-vertical': MoreVertical,
  key: KeyRound,
  keyboard: Keyboard,
  layers: Stack2,
  layout: Layout,
  'layout-sidebar-left': LayoutSidebar,
  'layout-sidebar-right': LayoutSidebarRight,
  lightbulb: Bulb,
  'link-external': ExternalLink,
  'list-flat': List,
  'list-tree': ListTree,
  'list-unordered': List,
  markdown: Markdown,
  mic: Mic,
  'mic-off': MicOff,
  mute: VolumeX,
  'new-folder': FolderPlus,
  organization: Building,
  package: Package,
  'pass-filled': CheckCircle2,
  person: User,
  pin: Pin,
  'pinned-dirty': PinFilled,
  play: Play,
  plug: Plug,
  question: HelpCircle,
  'radio-tower': Broadcast,
  refresh: RefreshCw,
  regex: Regex,
  remove: Minus,
  repo: Repo,
  'repo-forked': GitFork,
  rocket: Rocket,
  'root-folder': Folders,
  save: Save,
  search: Search,
  'server-process': Server,
  'settings-gear': Settings,
  shield: Shield,
  sparkle: Sparkles,
  'split-horizontal': LayoutColumns,
  'star-full': Star,
  starmap: Starmap,
  'symbol-color': Palette,
  'symbol-misc': Box,
  sync: RefreshCw,
  tag: Tag,
  target: Target,
  telescope: Telescope,
  terminal: Terminal,
  'text-size': TextSize,
  tools: Wrench,
  trash: Trash2,
  'triangle-right': Play,
  unmute: Volume,
  warning: AlertTriangle,
  watch: Clock,
  zap: Zap
}

export function tablerForCodicon(name: string): Icon | undefined {
  return name === 'loading' ? (Spinner as unknown as Icon) : CODICON_TO_TABLER[name]
}

export interface CodiconProps extends React.HTMLAttributes<HTMLElement> {
  name: string
  size?: number | string
  spinning?: boolean
}

/**
 * Legacy API, Tabler output. `size` keeps its old meaning (CSS length for the
 * glyph box); without it the glyph is 16px like the codicon font default, and a
 * `size-*` class in `className` wins via tailwind-merge.
 *
 * Unmapped names (only reachable from plugins via `sdk` `Codicon` or a gateway
 * `data.codicon`) still render the codicon font so third-party UI doesn't break.
 * The app's own names are all mapped; a dev warning flags anything new.
 */
export function Codicon({ className, name, size, spinning, style, ...props }: CodiconProps) {
  const Glyph = tablerForCodicon(name)
  const dimension = size === undefined ? undefined : typeof size === 'number' ? `${size}px` : size

  if (!Glyph) {
    if (import.meta.env.DEV) {
      console.warn(`[Codicon] no Tabler mapping for "${name}" — rendering the legacy font`)
    }

    return (
      <i
        aria-hidden="true"
        className={cn('codicon', `codicon-${name}`, spinning && 'codicon-modifier-spin', className)}
        style={{ fontSize: dimension, ...style }}
        {...props}
      />
    )
  }

  return (
    <Glyph
      aria-hidden
      className={cn('size-4 shrink-0', spinning && 'animate-spin', className)}
      style={dimension ? { height: dimension, width: dimension, ...style } : style}
      {...(props as Record<string, unknown>)}
    />
  )
}

/** Wrap a codicon name as a Tabler-shaped icon for nav rows that expect `IconComponent`. */
export function codiconIcon(name: string): Icon {
  return tablerForCodicon(name) ?? (MoreHorizontal as Icon)
}
