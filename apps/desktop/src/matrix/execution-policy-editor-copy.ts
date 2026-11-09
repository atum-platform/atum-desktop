export type ExecutionPolicyEditorLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'
export type ExecutionPolicyEditorFailure =
  | 'invalid'
  | 'request_conflict'
  | 'revision_conflict'
  | 'inventory_changed'
  | 'unavailable'
  | 'invalid_response'
  | 'queue_busy'

interface ExecutionPolicyEditorWords {
  title: string
  /** The assistant card's row label (§9.4): short, because the row's value says the place. */
  rowTitle: string
  help: string
  statusUnavailable: string
  statusUpdating: string
  statusAsOf: (value: string) => string
  /** The closed title-bar trigger's one tooltip (slice 1): where the answer goes now, or is going. */
  answeringOn: (name: string) => string
  aboutToAnswerOn: (name: string) => string
  /** Every destination is off: the owner paused the assistant. */
  paused: string
  /** The roster's short line for a standby Mac: just the place ("On Mac mini"), never a sentence. */
  rosterOn: (name: string) => string
  /** The card row's value when everything is off: the row's label already says "where it answers". */
  rowPaused: string
  /** Keyboard reordering is the accessible half of drag: dnd-kit announces these as the row moves. */
  reorderStart: (name: string) => string
  reorderOver: (name: string, position: number, total: number) => string
  reorderEnd: (name: string, position: number, total: number) => string
  reorderCancel: (name: string, position: number) => string
  reorderInstructions: string
  /** The grip button's name; the visible grip has no text of its own. */
  dragHandle: (name: string) => string
  cacheUnavailable: string
  turnOn: (name: string) => string
  turnOff: (name: string) => string
  allDisabled: string
  activeTurn: string
  tryAgain: string
  refresh: string
  refreshing: string
  /** A Mac waits for the owner's plan instead of an agent silently moving to it (0238): the truthful remedy. */
  planLapsed: string
  /** This Mac answers a cloud assistant without having read the cloud's latest memory. */
  memoryNote: string
  /** The cloud's copy replaced memory this Mac had changed; the earlier versions are saved on this Mac. */
  memoryLocalSaved: string
  /** The per-agent off switch (0238), offered only when the platform answers it. */
  turnOffFailover: string
  turnOffAsk: string
  turnOffKeep: string
  turnOffConfirm: string
  turningOff: string
  failure: Record<ExecutionPolicyEditorFailure, string>
}

const words: Record<ExecutionPolicyEditorLocale, ExecutionPolicyEditorWords> = {
  en: {
    title: 'Where this assistant answers',
    rowTitle: 'Where it answers',
    help: 'Put the preferred location first. Atum skips locations that are offline or cannot run this assistant.',
    statusUnavailable: 'Status unavailable',
    statusUpdating: 'Updating status…',
    statusAsOf: value => `Status updated ${value}`,
    answeringOn: name => `Answering on ${name}`,
    aboutToAnswerOn: name => `About to answer on ${name}`,
    paused: 'Paused',
    rosterOn: name => `On ${name}`,
    rowPaused: 'Paused',
    cacheUnavailable: 'Could not refresh these choices. Reload to try again.',
    reorderStart: name => `Picked up ${name}. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
    reorderOver: (name, position, total) => `${name} is at position ${position} of ${total}.`,
    reorderEnd: (name, position, total) => `${name} dropped at position ${position} of ${total}.`,
    reorderCancel: (name, position) => `Move cancelled. ${name} is back at position ${position}.`,
    reorderInstructions: 'To reorder, press Space on a row, use the arrow keys, then press Space again.',
    dragHandle: name => `Reorder ${name}`,
    turnOn: name => `Turn on ${name}`,
    turnOff: name => `Turn off ${name}`,
    allDisabled: 'This assistant will pause until you turn a location back on.',
    activeTurn: 'Its current reply can finish before this location turns off.',
    tryAgain: 'Try again',
    refresh: 'Reload',
    refreshing: 'Reloading…',
    planLapsed: 'Your cloud plan has ended, so this assistant waits instead of moving to a Mac on its own. Add Protons to resume, or turn the cloud off here to answer from a Mac now.',
    memoryNote: 'This Mac is answering without the cloud’s recent memory, so it may not know the latest.',
    memoryLocalSaved: 'The cloud’s copy replaced some of what this Mac had remembered. The earlier versions are saved on this Mac.',
    turnOffFailover: 'Turn off failover',
    turnOffAsk: 'Turn off failover for this assistant? It stops using this order and answers only on your Macs again, like a local assistant. You can set an order again here later.',
    turnOffKeep: 'Keep',
    turnOffConfirm: 'Turn off',
    turningOff: 'Turning off…',
    failure: {
      invalid: 'Atum could not save these choices. Check them and try again.',
      request_conflict: 'This save could not be replayed safely. Try again.',
      revision_conflict: 'These choices changed elsewhere. Reload before editing again.',
      inventory_changed: 'The available locations changed. Reload before editing again.',
      unavailable: 'Could not reach Atum. Your choices are still here.',
      invalid_response: 'Atum returned an invalid policy. Your choices are still here.',
      queue_busy: 'A reply is in progress. Try again when it finishes.'
    }
  },
  vi: {
    title: 'Nơi trợ lý này trả lời',
    rowTitle: 'Nơi trả lời',
    help: 'Đặt nơi ưu tiên lên đầu. Atum sẽ bỏ qua nơi ngoại tuyến hoặc không chạy được trợ lý này.',
    statusUnavailable: 'Chưa có trạng thái',
    statusUpdating: 'Đang cập nhật trạng thái…',
    statusAsOf: value => `Trạng thái cập nhật ${value}`,
    answeringOn: name => `Đang trả lời trên ${name}`,
    aboutToAnswerOn: name => `Sắp trả lời trên ${name}`,
    paused: 'Đang tạm dừng',
    rosterOn: name => `Trên ${name}`,
    rowPaused: 'Tạm dừng',
    cacheUnavailable: 'Chưa cập nhật được lựa chọn này. Hãy tải lại để thử lại.',
    reorderStart: name => `Đã chọn ${name}. Dùng phím mũi tên để di chuyển, phím cách để thả, Esc để huỷ.`,
    reorderOver: (name, position, total) => `${name} đang ở vị trí ${position}/${total}.`,
    reorderEnd: (name, position, total) => `Đã đặt ${name} ở vị trí ${position}/${total}.`,
    reorderCancel: (name, position) => `Đã huỷ di chuyển. ${name} về lại vị trí ${position}.`,
    reorderInstructions: 'Để đổi thứ tự, nhấn phím cách trên một dòng, dùng phím mũi tên, rồi nhấn phím cách lần nữa.',
    dragHandle: name => `Đổi thứ tự ${name}`,
    turnOn: name => `Bật ${name}`,
    turnOff: name => `Tắt ${name}`,
    allDisabled: 'Trợ lý này sẽ tạm dừng cho đến khi bạn bật lại một nơi.',
    activeTurn: 'Câu trả lời hiện tại có thể hoàn tất trước khi nơi này tắt.',
    tryAgain: 'Thử lại',
    refresh: 'Tải lại',
    refreshing: 'Đang tải lại…',
    planLapsed: 'Gói đám mây của bạn đã hết hạn, nên trợ lý này chờ chứ không tự chuyển sang máy Mac. Nạp thêm Proton để tiếp tục, hoặc tắt Đám mây ở đây để trả lời trên máy Mac ngay.',
    memoryNote: 'Máy Mac này đang trả lời mà chưa có trí nhớ mới nhất từ đám mây, nên có thể chưa biết những điều gần đây.',
    memoryLocalSaved: 'Bản trên đám mây đã thay một phần những gì máy Mac này nhớ. Các bản cũ vẫn được lưu trên máy này.',
    turnOffFailover: 'Tắt tự động chuyển nơi trả lời',
    turnOffAsk: 'Tắt tự động chuyển nơi trả lời cho trợ lý này? Trợ lý sẽ không dùng thứ tự này nữa mà chỉ trả lời trên các máy Mac của bạn, như một trợ lý cục bộ. Sau này bạn có thể đặt lại thứ tự ở đây.',
    turnOffKeep: 'Giữ nguyên',
    turnOffConfirm: 'Tắt',
    turningOff: 'Đang tắt…',
    failure: {
      invalid: 'Atum chưa lưu được lựa chọn này. Hãy kiểm tra rồi thử lại.',
      request_conflict: 'Không thể lặp lại lần lưu này một cách an toàn. Hãy thử lại.',
      revision_conflict: 'Lựa chọn đã thay đổi ở nơi khác. Hãy tải lại trước khi sửa tiếp.',
      inventory_changed: 'Danh sách nơi chạy đã thay đổi. Hãy tải lại trước khi sửa tiếp.',
      unavailable: 'Chưa kết nối được với Atum. Lựa chọn vẫn còn ở đây.',
      invalid_response: 'Atum trả về chính sách không hợp lệ. Lựa chọn vẫn còn ở đây.',
      queue_busy: 'Trợ lý đang trả lời một tin nhắn. Hãy thử lại khi trả lời xong.'
    }
  },
  ja: {
    title: 'このアシスタントが応答する場所',
    rowTitle: '応答する場所',
    help: '優先する場所を先頭にします。オフライン、またはこのアシスタントを実行できない場所はスキップされます。',
    statusUnavailable: '状態を確認できません',
    statusUpdating: '状態を更新中…',
    statusAsOf: value => `ステータス更新: ${value}`,
    answeringOn: name => `${name} で応答中`,
    aboutToAnswerOn: name => `まもなく ${name} で応答します`,
    paused: '一時停止中',
    rosterOn: name => `${name} で`,
    rowPaused: '一時停止',
    cacheUnavailable: 'この選択を更新できませんでした。再読み込みしてもう一度お試しください。',
    reorderStart: name => `${name} を選択しました。矢印キーで移動し、スペースキーで確定、Esc でキャンセルします。`,
    reorderOver: (name, position, total) => `${name} は ${total} 件中 ${position} 番目です。`,
    reorderEnd: (name, position, total) => `${name} を ${total} 件中 ${position} 番目に移動しました。`,
    reorderCancel: (name, position) => `移動をキャンセルしました。${name} は ${position} 番目に戻りました。`,
    reorderInstructions: '並べ替えるには、行の上でスペースキーを押し、矢印キーで移動して、もう一度スペースキーを押します。',
    dragHandle: name => `${name} を並べ替え`,
    turnOn: name => `${name}をオン`,
    turnOff: name => `${name}をオフ`,
    allDisabled: 'いずれかの場所をオンに戻すまで、このアシスタントは一時停止します。',
    activeTurn: 'この場所がオフになる前に、現在の応答が完了する場合があります。',
    tryAgain: '再試行',
    refresh: '再読み込み',
    refreshing: '再読み込み中…',
    planLapsed: 'クラウドのプランが終了したため、このアシスタントは自動で Mac に切り替えず待機しています。Proton を追加して再開するか、ここでクラウドをオフにすると今すぐ Mac で応答します。',
    memoryNote: 'この Mac はクラウドの最新の記憶なしで応答しています。最近の内容を把握していない場合があります。',
    memoryLocalSaved: 'この Mac が覚えていた内容の一部がクラウドのコピーに置き換わりました。以前の内容はこの Mac に保存されています。',
    turnOffFailover: '自動切り替えをオフ',
    turnOffAsk: 'このアシスタントの自動切り替えをオフにしますか？この順序は使われなくなり、ローカルのアシスタントとして Mac だけで応答します。順序はあとでここから設定し直せます。',
    turnOffKeep: 'そのままにする',
    turnOffConfirm: 'オフにする',
    turningOff: 'オフにしています…',
    failure: {
      invalid: 'この選択を保存できませんでした。内容を確認して、もう一度お試しください。',
      request_conflict: 'この保存を安全に再実行できませんでした。もう一度お試しください。',
      revision_conflict: '別の場所で選択が変更されました。編集を続ける前に再読み込みしてください。',
      inventory_changed: '利用できる場所が変わりました。編集を続ける前に再読み込みしてください。',
      unavailable: 'Atum に接続できませんでした。選択内容は保持されています。',
      invalid_response: 'Atum から無効なポリシーが返されました。選択内容は保持されています。',
      queue_busy: '応答の途中です。終わってからもう一度お試しください。'
    }
  },
  zh: {
    title: '此助手的回复位置',
    rowTitle: '回复位置',
    help: '将首选位置放在最前。Atum 会跳过离线或无法运行此助手的位置。',
    statusUnavailable: '状态不可用',
    statusUpdating: '正在更新状态…',
    statusAsOf: value => `状态更新于${value}`,
    answeringOn: name => `正在由${name}回复`,
    aboutToAnswerOn: name => `即将由${name}回复`,
    paused: '已暂停',
    rosterOn: name => `在${name}`,
    rowPaused: '已暂停',
    cacheUnavailable: '无法刷新这些选择。请重新加载后重试。',
    reorderStart: name => `已选中${name}。使用方向键移动，按空格键放置，按 Esc 取消。`,
    reorderOver: (name, position, total) => `${name} 现在位于第 ${position}/${total} 位。`,
    reorderEnd: (name, position, total) => `已将${name}放到第 ${position}/${total} 位。`,
    reorderCancel: (name, position) => `已取消移动。${name} 回到第 ${position} 位。`,
    reorderInstructions: '要调整顺序，请在一行上按空格键，使用方向键移动，然后再按一次空格键。',
    dragHandle: name => `调整${name}的顺序`,
    turnOn: name => `开启${name}`,
    turnOff: name => `关闭${name}`,
    allDisabled: '此助手会暂停，直到你重新开启一个位置。',
    activeTurn: '当前位置关闭前，当前回复可能会先完成。',
    tryAgain: '重试',
    refresh: '重新加载',
    refreshing: '正在重新加载…',
    planLapsed: '云端套餐已结束，因此此助手会等待，而不会自行切换到 Mac。充值 Proton 即可恢复，或在此关闭云端，立即改由 Mac 回复。',
    memoryNote: '这台 Mac 正在没有云端最新记忆的情况下回复，可能不了解最近的内容。',
    memoryLocalSaved: '云端的副本替换了这台 Mac 记住的部分内容。之前的版本仍保存在这台 Mac 上。',
    turnOffFailover: '关闭自动切换',
    turnOffAsk: '要为此助手关闭自动切换吗？它将不再使用此顺序，而像本地助手一样只在你的 Mac 上回复。以后可以在此重新设置顺序。',
    turnOffKeep: '保持不变',
    turnOffConfirm: '关闭',
    turningOff: '正在关闭…',
    failure: {
      invalid: 'Atum 无法保存这些选择。请检查后重试。',
      request_conflict: '无法安全地重放此次保存。请重试。',
      revision_conflict: '这些选择已在其他位置更改。请重新加载后再编辑。',
      inventory_changed: '可用位置已发生变化。请重新加载后再编辑。',
      unavailable: '无法连接 Atum。你的选择仍保留在这里。',
      invalid_response: 'Atum 返回了无效策略。你的选择仍保留在这里。',
      queue_busy: '正在回复中。请在回复结束后再试。'
    }
  },
  'zh-hant': {
    title: '此助理的回覆位置',
    rowTitle: '回覆位置',
    help: '將偏好位置放在最前。Atum 會略過離線或無法執行此助理的位置。',
    statusUnavailable: '狀態無法使用',
    statusUpdating: '正在更新狀態…',
    statusAsOf: value => `狀態更新於${value}`,
    answeringOn: name => `正在由${name}回覆`,
    aboutToAnswerOn: name => `即將由${name}回覆`,
    paused: '已暫停',
    rosterOn: name => `在${name}`,
    rowPaused: '已暫停',
    cacheUnavailable: '無法重新整理這些選擇。請重新載入後再試一次。',
    reorderStart: name => `已選取${name}。使用方向鍵移動，按空白鍵放置，按 Esc 取消。`,
    reorderOver: (name, position, total) => `${name} 目前在第 ${position}/${total} 位。`,
    reorderEnd: (name, position, total) => `已將${name}放到第 ${position}/${total} 位。`,
    reorderCancel: (name, position) => `已取消移動。${name} 回到第 ${position} 位。`,
    reorderInstructions: '若要調整順序，請在某一列上按空白鍵，使用方向鍵移動，然後再按一次空白鍵。',
    dragHandle: name => `調整${name}的順序`,
    turnOn: name => `開啟${name}`,
    turnOff: name => `關閉${name}`,
    allDisabled: '此助理會暫停，直到你重新開啟一個位置。',
    activeTurn: '目前位置關閉前，現有回覆可能會先完成。',
    tryAgain: '重試',
    refresh: '重新載入',
    refreshing: '正在重新載入…',
    planLapsed: '雲端方案已結束，因此此助理會等待，而不會自行切換到 Mac。儲值 Proton 即可恢復，或在此關閉雲端，立即改由 Mac 回覆。',
    memoryNote: '這台 Mac 正在沒有雲端最新記憶的情況下回覆，可能不了解最近的內容。',
    memoryLocalSaved: '雲端的副本取代了這台 Mac 記住的部分內容。先前的版本仍保存在這台 Mac 上。',
    turnOffFailover: '關閉自動切換',
    turnOffAsk: '要為此助理關閉自動切換嗎？它將不再使用此順序，而像本機助理一樣只在你的 Mac 上回覆。之後可以在此重新設定順序。',
    turnOffKeep: '保持不變',
    turnOffConfirm: '關閉',
    turningOff: '正在關閉…',
    failure: {
      invalid: 'Atum 無法儲存這些選擇。請檢查後再試一次。',
      request_conflict: '無法安全地重播此次儲存。請再試一次。',
      revision_conflict: '這些選擇已在其他位置變更。請重新載入後再編輯。',
      inventory_changed: '可用位置已變更。請重新載入後再編輯。',
      unavailable: '無法連線至 Atum。你的選擇仍保留在這裡。',
      invalid_response: 'Atum 傳回了無效政策。你的選擇仍保留在這裡。',
      queue_busy: '正在回覆中。請在回覆結束後再試。'
    }
  }
}

export function executionPolicyEditorCopy(locale: string): ExecutionPolicyEditorWords {
  return Object.hasOwn(words, locale) ? words[locale as ExecutionPolicyEditorLocale] : words.en
}

/** Bounded relative status age; future/skewed provider clocks display as current, never a promise. */
export function executionPolicyStatusAge(locale: string, asOf: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - asOf)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (elapsed < 60_000) {
    return formatter.format(-Math.floor(elapsed / 1_000), 'second')
  }

  if (elapsed < 60 * 60_000) {
    return formatter.format(-Math.floor(elapsed / 60_000), 'minute')
  }

  if (elapsed < 24 * 60 * 60_000) {
    return formatter.format(-Math.floor(elapsed / (60 * 60_000)), 'hour')
  }

  return formatter.format(-Math.floor(Math.min(elapsed, 30 * 24 * 60 * 60_000) / (24 * 60 * 60_000)), 'day')
}
