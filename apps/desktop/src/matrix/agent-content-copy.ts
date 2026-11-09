import type { Locale } from '@/i18n'

import type { MatrixAgentContentSkillState, MatrixAgentContentView } from '../../shared/matrix'

interface ContentCopy {
  title(name: string): string
  states: Record<MatrixAgentContentView['state'], string>
  help: string
  lastCounts: string
  skills: string
  newSkills: string
  persona: string
  personas: Record<NonNullable<MatrixAgentContentView['persona']>, string>
  counts: Record<MatrixAgentContentSkillState, string>
  checked: string
  receiptReset: string
  /** The edit sheet's one line (Advanced): skills that are not on this Mac yet. */
  missingSkills(count: number): string
  details: string
}

export const agentContentCopy: Record<Locale, ContentCopy> = {
  en: {
    title: name => `Content on this Mac · ${name}`,
    states: {
      checking: 'Checking content',
      complete: 'Content ready on this Mac',
      differs: 'Local changes kept',
      incomplete: 'Some content is missing',
      error: 'Content check didn’t finish'
    },
    help: 'Checks saved instructions and portable skills. Local changes are kept; this does not pause your agent.',
    lastCounts: 'Showing the last completed check.',
    skills: 'Declared skills',
    newSkills: 'Added in that check',
    persona: 'Instructions',
    personas: {
      matches: 'Match saved instructions',
      differs: 'Local instructions kept',
      absent: 'Not on this Mac yet',
      none: 'None saved for this agent'
    },
    counts: {
      installed: 'Present on this Mac',
      bundled: 'Included with Atum',
      bundled_version: 'Included version kept',
      different: 'Local changes kept',
      suppressed: 'Local removals kept',
      collision: 'Name already in use',
      blocked: 'Could not install safely',
      missing: 'Not installed',
      unsupported: 'Unsupported content',
      unavailable: 'Could not download'
    },
    checked: 'Last completed check',
    receiptReset:
      'The local skill-removal record was damaged, so an earlier removed skill may reappear. Remove it again if needed.',
    missingSkills: count => (count === 1 ? '1 skill isn’t on this Mac yet' : `${count} skills aren’t on this Mac yet`),
    details: 'Details'
  },
  vi: {
    title: name => `Nội dung trên Mac này · ${name}`,
    states: {
      checking: 'Đang kiểm tra nội dung',
      complete: 'Nội dung đã sẵn sàng trên Mac này',
      differs: 'Đã giữ thay đổi cục bộ',
      incomplete: 'Một số nội dung còn thiếu',
      error: 'Chưa kiểm tra xong nội dung'
    },
    help: 'Kiểm tra hướng dẫn đã lưu và kỹ năng có thể đồng bộ. Giữ nguyên thay đổi cục bộ; không tạm dừng trợ lý.',
    lastCounts: 'Đang hiển thị lần kiểm tra hoàn tất gần nhất.',
    skills: 'Kỹ năng đã khai báo',
    newSkills: 'Đã thêm trong lần kiểm tra đó',
    persona: 'Hướng dẫn',
    personas: {
      matches: 'Khớp hướng dẫn đã lưu',
      differs: 'Giữ hướng dẫn cục bộ',
      absent: 'Chưa có trên Mac này',
      none: 'Trợ lý chưa có hướng dẫn đã lưu'
    },
    counts: {
      installed: 'Đã có trên Mac này',
      bundled: 'Đi kèm Atum',
      bundled_version: 'Giữ phiên bản đi kèm',
      different: 'Giữ thay đổi cục bộ',
      suppressed: 'Giữ lựa chọn xóa cục bộ',
      collision: 'Tên đã được dùng',
      blocked: 'Chưa thể cài đặt an toàn',
      missing: 'Chưa cài đặt',
      unsupported: 'Nội dung chưa được hỗ trợ',
      unavailable: 'Chưa tải được'
    },
    checked: 'Lần kiểm tra hoàn tất gần nhất',
    receiptReset:
      'Bản ghi xóa kỹ năng cục bộ đã bị hỏng nên kỹ năng từng xóa có thể xuất hiện lại. Hãy xóa lại nếu cần.',
    missingSkills: count => `${count} kỹ năng chưa có trên máy này`,
    details: 'Chi tiết'
  },
  ja: {
    title: name => `このMacの内容 · ${name}`,
    states: {
      checking: '内容を確認中',
      complete: 'このMacの内容は準備済み',
      differs: 'ローカルの変更を保持',
      incomplete: '一部の内容が不足',
      error: '内容の確認が未完了'
    },
    help: '保存済みの指示と移動可能なスキルを確認します。ローカルの変更を保持し、エージェントを停止しません。',
    lastCounts: '最後に完了した確認結果を表示しています。',
    skills: '登録されたスキル',
    newSkills: 'その確認で追加',
    persona: '指示',
    personas: {
      matches: '保存済みの指示と一致',
      differs: 'ローカルの指示を保持',
      absent: 'このMacには未配置',
      none: '保存済みの指示なし'
    },
    counts: {
      installed: 'このMacに配置済み',
      bundled: 'Atumに付属',
      bundled_version: '付属バージョンを保持',
      different: 'ローカルの変更を保持',
      suppressed: 'ローカルの削除を保持',
      collision: '名前が使用済み',
      blocked: '安全にインストールできず',
      missing: '未インストール',
      unsupported: '未対応の内容',
      unavailable: 'ダウンロードできず'
    },
    checked: '最後に完了した確認',
    receiptReset:
      'ローカルのスキル削除記録が破損したため、以前削除したスキルが再表示される場合があります。必要ならもう一度削除してください。',
    missingSkills: count => `${count} 個のスキルがまだこのMacにありません`,
    details: '詳細'
  },
  zh: {
    title: name => `这台 Mac 上的内容 · ${name}`,
    states: {
      checking: '正在检查内容',
      complete: '这台 Mac 上的内容已就绪',
      differs: '已保留本地修改',
      incomplete: '部分内容尚未就绪',
      error: '内容检查未完成'
    },
    help: '检查已保存的指令和可同步技能。保留本地修改，不会暂停智能体。',
    lastCounts: '显示最近一次已完成的检查。',
    skills: '已声明技能',
    newSkills: '在该次检查中添加',
    persona: '指令',
    personas: {
      matches: '与已保存指令一致',
      differs: '保留本地指令',
      absent: '这台 Mac 上尚未安装',
      none: '该智能体没有已保存指令'
    },
    counts: {
      installed: '这台 Mac 上已有',
      bundled: '随 Atum 提供',
      bundled_version: '保留随附版本',
      different: '保留本地修改',
      suppressed: '保留本地删除',
      collision: '名称已被使用',
      blocked: '无法安全安装',
      missing: '尚未安装',
      unsupported: '不支持的内容',
      unavailable: '无法下载'
    },
    checked: '最近一次已完成的检查',
    receiptReset: '本地技能删除记录已损坏，因此之前删除的技能可能会重新出现。如有需要，请再次删除。',
    missingSkills: count => `${count} 个技能尚未在这台 Mac 上`,
    details: '详情'
  },
  'zh-hant': {
    title: name => `這台 Mac 上的內容 · ${name}`,
    states: {
      checking: '正在檢查內容',
      complete: '這台 Mac 上的內容已就緒',
      differs: '已保留本機修改',
      incomplete: '部分內容尚未就緒',
      error: '內容檢查未完成'
    },
    help: '檢查已儲存的指示和可同步技能。保留本機修改，不會暫停智慧代理。',
    lastCounts: '顯示最近一次已完成的檢查。',
    skills: '已宣告技能',
    newSkills: '在該次檢查中新增',
    persona: '指示',
    personas: {
      matches: '與已儲存指示一致',
      differs: '保留本機指示',
      absent: '這台 Mac 上尚未安裝',
      none: '此智慧代理沒有已儲存指示'
    },
    counts: {
      installed: '這台 Mac 上已有',
      bundled: '隨 Atum 提供',
      bundled_version: '保留隨附版本',
      different: '保留本機修改',
      suppressed: '保留本機刪除',
      collision: '名稱已被使用',
      blocked: '無法安全安裝',
      missing: '尚未安裝',
      unsupported: '不支援的內容',
      unavailable: '無法下載'
    },
    checked: '最近一次已完成的檢查',
    receiptReset: '本機技能刪除記錄已損壞，因此先前刪除的技能可能會再次出現。如有需要，請再次刪除。',
    missingSkills: count => `${count} 個技能尚未在這台 Mac 上`,
    details: '詳細資料'
  }
}
