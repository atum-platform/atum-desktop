interface InstallCopy {
  title: string
  install: string
  cancel: string
  detail: (agent: string, identifier: string) => string
}

const copy: Record<string, InstallCopy> = {
  en: {
    install: 'Install',
    cancel: 'Cancel',
    title: 'Install this skill?',
    detail: (agent, identifier) =>
      `Install for ${agent} on this Mac. Skills can include instructions and executable files. Only install sources you trust.\n\n${identifier}`
  },
  vi: {
    install: 'Cài đặt',
    cancel: 'Hủy',
    title: 'Cài đặt kỹ năng này?',
    detail: (agent, identifier) =>
      `Cài đặt cho ${agent} trên máy Mac này. Kỹ năng có thể chứa hướng dẫn và tệp thực thi. Chỉ cài đặt từ nguồn bạn tin cậy.\n\n${identifier}`
  },
  ja: {
    install: 'インストール',
    cancel: 'キャンセル',
    title: 'このスキルをインストールしますか？',
    detail: (agent, identifier) =>
      `この Mac の ${agent} にインストールします。スキルには指示や実行可能ファイルが含まれる場合があります。信頼できるソースのみをインストールしてください。\n\n${identifier}`
  },
  zh: {
    install: '安装',
    cancel: '取消',
    title: '安装此技能？',
    detail: (agent, identifier) =>
      `为此 Mac 上的 ${agent} 安装。技能可能包含指令和可执行文件。请仅安装您信任的来源。\n\n${identifier}`
  },
  'zh-hant': {
    install: '安裝',
    cancel: '取消',
    title: '安裝此技能？',
    detail: (agent, identifier) =>
      `為此 Mac 上的 ${agent} 安裝。技能可能包含指令及可執行檔案。請只安裝您信任的來源。\n\n${identifier}`
  }
}

export function matrixPagesInstallCopy(locale: string): InstallCopy {
  return Object.hasOwn(copy, locale) ? copy[locale] : copy.en
}

const scanCopy: Record<string, Pick<InstallCopy, 'title' | 'detail'> & { scan: string }> = {
  en: {
    scan: 'Scan',
    title: 'Scan this skill?',
    detail: (agent, identifier) =>
      `Fetch an isolated copy to inspect for ${agent} on this Mac. This does not install or run the skill. A scan is advisory, not a guarantee of safety.\n\n${identifier}`
  },
  vi: {
    scan: 'Kiểm tra',
    title: 'Kiểm tra kỹ năng này?',
    detail: (agent, identifier) =>
      `Tải một bản sao riêng để kiểm tra cho ${agent} trên máy Mac này. Thao tác này không cài đặt hoặc chạy kỹ năng. Kết quả chỉ mang tính tham khảo, không đảm bảo an toàn tuyệt đối.\n\n${identifier}`
  },
  ja: {
    scan: 'スキャン',
    title: 'このスキルをスキャンしますか？',
    detail: (agent, identifier) =>
      `この Mac の ${agent} のために隔離されたコピーを取得して検査します。スキルのインストールや実行は行いません。スキャン結果は参考情報であり、安全を保証するものではありません。\n\n${identifier}`
  },
  zh: {
    scan: '扫描',
    title: '扫描此技能？',
    detail: (agent, identifier) =>
      `为此 Mac 上的 ${agent} 获取隔离副本进行检查。这不会安装或运行技能。扫描结果仅供参考，不保证安全。\n\n${identifier}`
  },
  'zh-hant': {
    scan: '掃描',
    title: '掃描此技能？',
    detail: (agent, identifier) =>
      `為此 Mac 上的 ${agent} 取得隔離副本進行檢查。這不會安裝或執行技能。掃描結果僅供參考，不保證安全。\n\n${identifier}`
  }
}

export function matrixPagesScanCopy(locale: string) {
  const selected = Object.hasOwn(scanCopy, locale) ? scanCopy[locale] : scanCopy.en

  return { ...selected, cancel: matrixPagesInstallCopy(locale).cancel }
}

interface ArchiveCopy {
  title: string
  archive: string
  cancel: string
  detail: (agent: string, name: string) => string
}

const archiveCopy: Record<string, Omit<ArchiveCopy, 'cancel'>> = {
  en: {
    archive: 'Archive',
    title: 'Archive this skill?',
    detail: (agent, name) =>
      `Remove this skill from ${agent} on this Mac. Its files and installation record will be kept in the local archive. Existing conversations may keep using their saved instructions until a new session.\n\n${name}`
  },
  vi: {
    archive: 'Lưu trữ',
    title: 'Lưu trữ kỹ năng này?',
    detail: (agent, name) =>
      `Gỡ kỹ năng này khỏi ${agent} trên máy Mac này. Tệp và bản ghi cài đặt sẽ được giữ trong kho lưu trữ cục bộ. Cuộc trò chuyện hiện tại có thể tiếp tục dùng hướng dẫn đã lưu cho đến phiên mới.\n\n${name}`
  },
  ja: {
    archive: 'アーカイブ',
    title: 'このスキルをアーカイブしますか？',
    detail: (agent, name) =>
      `この Mac の ${agent} からスキルを取り除きます。ファイルとインストール記録はローカルのアーカイブに保持されます。既存の会話は新しいセッションまで保存済みの指示を使い続ける場合があります。\n\n${name}`
  },
  zh: {
    archive: '归档',
    title: '归档此技能？',
    detail: (agent, name) =>
      `从此 Mac 上的 ${agent} 移除此技能。文件和安装记录将保留在本地归档中。现有对话可能会继续使用已保存的指令，直到开始新会话。\n\n${name}`
  },
  'zh-hant': {
    archive: '封存',
    title: '封存此技能？',
    detail: (agent, name) =>
      `從此 Mac 上的 ${agent} 移除此技能。檔案和安裝記錄會保留在本機封存中。現有對話可能會繼續使用已儲存的指示，直到開始新工作階段。\n\n${name}`
  }
}

export function matrixPagesArchiveCopy(locale: string): ArchiveCopy {
  const selected = Object.hasOwn(archiveCopy, locale) ? archiveCopy[locale] : archiveCopy.en

  return { ...selected, cancel: matrixPagesInstallCopy(locale).cancel }
}

interface UpdateCopy {
  title: string
  update: string
  cancel: string
  detail: (agent: string, name: string) => string
}

interface UpdateLocale {
  title: string
  allTitle: string
  update: string
  allUpdate: string
  detail: (agent: string) => string
  allDetail: (agent: string) => string
}

const updateCopy: Record<string, UpdateLocale> = {
  en: {
    title: 'Update this skill?',
    allTitle: 'Update installed skills?',
    update: 'Update',
    allUpdate: 'Update installed',
    detail: agent =>
      `Update this skill for ${agent} on this Mac. Its previous files and installation record will be kept for rollback. Changes apply to a new conversation.`,
    allDetail: agent =>
      `Check and update installed skills for ${agent} on this Mac. Each previous version will be kept for rollback, and any incomplete updates will be reported. Changes apply to a new conversation.`
  },
  vi: {
    title: 'Cập nhật kỹ năng này?',
    allTitle: 'Cập nhật các kỹ năng đã cài?',
    update: 'Cập nhật',
    allUpdate: 'Cập nhật kỹ năng đã cài',
    detail: agent =>
      `Cập nhật kỹ năng này cho ${agent} trên máy Mac này. Tệp và bản ghi cài đặt cũ sẽ được giữ để khôi phục. Thay đổi áp dụng cho cuộc trò chuyện mới.`,
    allDetail: agent =>
      `Kiểm tra và cập nhật các kỹ năng đã cài cho ${agent} trên máy Mac này. Mỗi phiên bản cũ được giữ để khôi phục; những cập nhật chưa hoàn tất sẽ được báo rõ. Thay đổi áp dụng cho cuộc trò chuyện mới.`
  },
  ja: {
    title: 'このスキルを更新しますか？',
    allTitle: 'インストール済みのスキルを更新しますか？',
    update: '更新',
    allUpdate: 'インストール済みを更新',
    detail: agent =>
      `この Mac の ${agent} のスキルを更新します。以前のファイルとインストール記録は復元用に保持されます。変更は新しい会話から適用されます。`,
    allDetail: agent =>
      `この Mac の ${agent} のインストール済みスキルを確認して更新します。各旧バージョンは復元用に保持され、完了しなかった更新は報告されます。変更は新しい会話から適用されます。`
  },
  zh: {
    title: '更新此技能？',
    allTitle: '更新已安装的技能？',
    update: '更新',
    allUpdate: '更新已安装技能',
    detail: agent => `为此 Mac 上的 ${agent} 更新此技能。旧文件和安装记录将保留以便恢复。更改将在新对话中生效。`,
    allDetail: agent =>
      `检查并更新此 Mac 上 ${agent} 已安装的技能。每个旧版本都将保留以便恢复，未完成的更新会明确报告。更改将在新对话中生效。`
  },
  'zh-hant': {
    title: '更新此技能？',
    allTitle: '更新已安裝的技能？',
    update: '更新',
    allUpdate: '更新已安裝技能',
    detail: agent => `為此 Mac 上的 ${agent} 更新此技能。舊檔案與安裝記錄將保留以便還原。變更會在新對話中生效。`,
    allDetail: agent =>
      `檢查並更新此 Mac 上 ${agent} 已安裝的技能。每個舊版本都會保留以便還原，未完成的更新會明確回報。變更會在新對話中生效。`
  }
}

export function matrixPagesUpdateCopy(locale: string, all = false): UpdateCopy {
  const selected = Object.hasOwn(updateCopy, locale) ? updateCopy[locale] : updateCopy.en

  return {
    title: all ? selected.allTitle : selected.title,
    update: all ? selected.allUpdate : selected.update,
    cancel: matrixPagesInstallCopy(locale).cancel,
    detail: (agent, name) => (all ? selected.allDetail(agent) : `${selected.detail(agent)}\n\n${name}`)
  }
}
