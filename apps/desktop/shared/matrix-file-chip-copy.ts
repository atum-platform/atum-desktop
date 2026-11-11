/**
 * The words a file chip in a chat uses (plan "You talk and things happen" §3.2; Atum Kit
 * STYLE.md "Files"). The chip's state is shown, never told: there is no sentence about saving.
 * Atum's own voice (no first person), one or two words, and never "lost": an expired draft is
 * still only "not confirmed". Vietnamese is the default; every locale changes together.
 */
import type { DesktopLocale } from './desktop-locale'

interface FileChipCopy {
  /** The list of chips under an answer, for screen readers. */
  files: string
  /** The trailing spinner's name and tooltip while a save settles. */
  saving: string
  /** The line of a chip whose save Atum can't confirm (and of an expired one). */
  notConfirmed: string
  /** The info button beside a copy: its name, and the one line its tooltip says. */
  copyLabel: string
  copyReason: string
}

export const matrixFileChipCopy: Record<DesktopLocale, FileChipCopy> = {
  vi: {
    files: 'Tệp',
    saving: 'Đang lưu',
    notConfirmed: 'Chưa xác nhận',
    copyLabel: 'Vì sao có bản này',
    copyReason: 'Bản gốc vừa thay đổi nên bản này nằm bên cạnh.'
  },
  en: {
    files: 'Files',
    saving: 'Saving',
    notConfirmed: 'Not confirmed',
    copyLabel: 'Why this copy',
    copyReason: 'The original changed, so this one sits beside it.'
  },
  ja: {
    files: 'ファイル',
    saving: '保存中',
    notConfirmed: '未確認',
    copyLabel: 'このコピーについて',
    copyReason: '元のファイルが変更されたため、これはその隣にあります。'
  },
  zh: {
    files: '文件',
    saving: '正在保存',
    notConfirmed: '未确认',
    copyLabel: '为什么有这一份',
    copyReason: '原文件刚有变动，所以这一份放在它旁边。'
  },
  'zh-hant': {
    files: '檔案',
    saving: '正在儲存',
    notConfirmed: '未確認',
    copyLabel: '為什麼有這一份',
    copyReason: '原檔案剛有變動，所以這一份放在它旁邊。'
  }
}

export function matrixFileChipText(locale: DesktopLocale): FileChipCopy {
  return matrixFileChipCopy[locale] ?? matrixFileChipCopy.vi
}
