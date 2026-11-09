import { atom } from 'nanostores'
import { useEffect } from 'react'

import { type Locale, useI18n } from '@/i18n'

import type { MatrixDesktopServicesStatus } from '../../shared/matrix-desktop-services'

const en = {
  share: 'Share usage data',
  shareHelp: 'Usage and errors only — never your messages, files or passwords.',
  feedbackOpen: 'Send feedback…',
  preferenceFailed: 'Could not update this setting. Please try again.',
  copyDiagnostic: 'Copy diagnostic ID',
  diagnosticCopied: 'Copied',
  feedback: 'Send feedback',
  feedbackPlaceholder: 'What could be better?',
  feedbackSend: 'Send feedback',
  feedbackSent: 'Thanks for your feedback.',
  feedbackFailed: 'Feedback could not be sent. Please try again.'
}

type DesktopServicesCopy = typeof en

const copy: Record<Locale, DesktopServicesCopy> = {
  en,
  vi: {
    share: 'Chia sẻ dữ liệu sử dụng',
    shareHelp: 'Chỉ số liệu sử dụng và lỗi — không có tin nhắn, tệp hay mật khẩu.',
    feedbackOpen: 'Gửi phản hồi…',
    preferenceFailed: 'Chưa cập nhật được thiết lập này. Hãy thử lại.',
    copyDiagnostic: 'Sao chép ID chẩn đoán',
    diagnosticCopied: 'Đã sao chép',
    feedback: 'Gửi phản hồi',
    feedbackPlaceholder: 'Atum có thể cải thiện điều gì?',
    feedbackSend: 'Gửi phản hồi',
    feedbackSent: 'Cảm ơn phản hồi của bạn.',
    feedbackFailed: 'Chưa gửi được phản hồi. Hãy thử lại.'
  },
  ja: {
    share: '使用状況データを共有',
    shareHelp: '利用状況とエラーのみ。メッセージ、ファイル、パスワードは含みません。',
    feedbackOpen: 'フィードバックを送信…',
    preferenceFailed: 'この設定を更新できませんでした。もう一度お試しください。',
    copyDiagnostic: '診断 ID をコピー',
    diagnosticCopied: 'コピーしました',
    feedback: 'フィードバックを送信',
    feedbackPlaceholder: '改善できる点を教えてください',
    feedbackSend: 'フィードバックを送信',
    feedbackSent: 'フィードバックをありがとうございます。',
    feedbackFailed: 'フィードバックを送信できませんでした。もう一度お試しください。'
  },
  zh: {
    share: '共享使用数据',
    shareHelp: '仅含使用情况和错误，绝不含你的消息、文件或密码。',
    feedbackOpen: '发送反馈…',
    preferenceFailed: '无法更新此设置。请重试。',
    copyDiagnostic: '复制诊断 ID',
    diagnosticCopied: '已复制',
    feedback: '发送反馈',
    feedbackPlaceholder: 'Atum 可以如何改进？',
    feedbackSend: '发送反馈',
    feedbackSent: '感谢您的反馈。',
    feedbackFailed: '无法发送反馈。请重试。'
  },
  'zh-hant': {
    share: '分享使用資料',
    shareHelp: '僅含使用情況和錯誤，絕不含你的訊息、檔案或密碼。',
    feedbackOpen: '傳送意見回饋…',
    preferenceFailed: '無法更新此設定。請再試一次。',
    copyDiagnostic: '拷貝診斷 ID',
    diagnosticCopied: '已拷貝',
    feedback: '傳送意見回饋',
    feedbackPlaceholder: 'Atum 可以如何改善？',
    feedbackSend: '傳送意見回饋',
    feedbackSent: '感謝您的意見回饋。',
    feedbackFailed: '無法傳送意見回饋。請再試一次。'
  }
}

export const $matrixDesktopServices = atom<MatrixDesktopServicesStatus | null>(null)

export function useMatrixDesktopServicesCopy(): DesktopServicesCopy {
  return copy[useI18n().locale]
}

export function MatrixDesktopServicesBootstrap() {
  useEffect(() => {
    const bridge = window.atumDesktopServices

    if (!bridge) {
      return
    }

    let live = true
    let receivedChange = false

    const unsubscribe = bridge.onChanged(status => {
      if (live) {
        receivedChange = true
        $matrixDesktopServices.set(status)
      }
    })

    void bridge.status().then(
      status => {
        if (live && !receivedChange) {
          $matrixDesktopServices.set(status)
        }
      },
      () => undefined
    )

    return () => {
      live = false
      unsubscribe()
    }
  }, [])

  return null
}

export { installMatrixDiagnostics, reportMatrixRendererError } from './diagnostics'
