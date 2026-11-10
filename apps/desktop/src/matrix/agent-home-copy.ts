import type { MatrixAgentHomeDestinationView, MatrixAgentHomeMoveResult, MatrixAgentHomeView } from '../../shared/matrix'

export type AgentHomeLocale = 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant'

type Move = NonNullable<MatrixAgentHomeView['move']>
type Place = MatrixAgentHomeView['lives']
type Refusal = Extract<MatrixAgentHomeMoveResult, { ok: false }>['reason']

interface AgentHomeWords {
  /** The card row's label: short, because the row's value says the place. */
  rowTitle: string
  /** The popover's heading over the current place. */
  livesWhere: string
  /** The popover's read-only list of the owner's Macs this assistant can use (U1), and its empty state. */
  canUse: string
  noMac: string
  title: string
  /** While the platform has not answered yet, and when it could not be read after asking. */
  finding: string
  unknownPlace: string
  retryRead: string
  /** The Mac's name when the registry has none for it. */
  anotherMac: string
  /** Mid-sentence, after a verb: "…move to the cloud". */
  cloud: string
  /** The cloud standing alone as a place value (the card row, the popover's current place). */
  cloudPlace: string
  /**
   * D1 slice 1, the one short line under the current place: it has one home and moves only when the
   * owner moves it. Automatic slow moves and periodic saves are not live, so they are never promised.
   */
  homeLine: string
  /** Cloud-only S0: the one quiet line on an assistant that still lives on a Mac (its one action is Move to the cloud). */
  macHomeNote: string
  /** A Mac by the owner's name (or "another Mac" without one), and the same with "this Mac" said. */
  place: (name: string) => string
  placeHere: (name: string) => string
  moveHeading: string
  /** The popover's label over the places it can move to (a Kit menu label, no ellipsis). */
  moveSection: string
  /** A place's row trailing word when it can't be moved to now, by the platform's closed reason. */
  unavailableReasons: Record<NonNullable<MatrixAgentHomeDestinationView['reason']>, string>
  unavailableFallback: string
  moveTo: (name: string) => string
  moveHere: (name: string) => string
  moveToCloud: string
  noOtherMac: string
  /** The status line while a move is under way, in the owner's steps (never a platform word). */
  steps: Record<Move['step'], (name: string) => string>
  cancel: string
  cancelling: string
  cancelFailed: string
  /** The reason the last attempt did not finish, as one calm sentence. */
  issues: Record<string, string>
  /** A move under way that has not progressed, and one that was called off: the assistant stays where it was. */
  issueFallback: string
  endedFallback: string
  refusals: Record<Refusal, string>
  livesOn: string
  model: string
  reviewMove: string
  move: string
  moving: string
  saveModel: string
  savingModel: string
  ready: string
  readinessChecking: string
  readinessAsleep: string
  readinessUnavailable: string
  actualLosses: string
  noLosses: string
  /** Beside the loss that discloses it: when the newest checkpoint was taken. */
  lastCheckpoint: (time: string) => string
  /** The owner's own tick for losing the work since that checkpoint. */
  acceptCheckpointLoss: string
  noModels: (name: string) => string
  waitingForMac: (name: string) => string
  /** The Mac the window is on when the registry has no name for it. */
  thisMac: string
  /** While this Mac enrolls for the assistant and publishes its models (it starts by itself). */
  preparing: (name: string) => string
  /** The assistant's Mac is not answering: Atum waits for it, and the move to the cloud stays the owner's to make. */
  waitingForCurrentMac: (mac: string) => string
  summary: (place: string, provider: string, model: string) => string
  progress: Record<'finishing_current_work' | 'moving' | 'waiting_for_destination' | 'reconciling' | 'ready' | 'failed', (name: string) => string>
  losses: Record<string, string>
}

const words: Record<AgentHomeLocale, AgentHomeWords> = {
  en: {
    rowTitle: 'Lives on',
    livesWhere: 'Lives on',
    canUse: 'Can use',
    noMac: 'No Mac yet',
    title: 'Where it lives',
    finding: 'Finding where it lives…',
    unknownPlace: 'Couldn’t tell where it lives yet.',
    retryRead: 'Try again',
    anotherMac: 'another Mac',
    cloud: 'the cloud',
    cloudPlace: 'The cloud',
    homeLine: 'Home · moves are manual',
    macHomeNote: 'Assistants now live in the cloud.',
    place: name => name || 'Another Mac',
    placeHere: name => (name ? `${name} · this Mac` : 'This Mac'),
    moveHeading: 'Move to…',
    moveSection: 'Move to',
    unavailableReasons: {
      offline: 'Offline',
      not_enrolled: 'Not set up',
      version_unsupported: 'Needs an update',
      home_conflict: 'Busy',
      catalog_unavailable: 'No models yet'
    },
    unavailableFallback: 'Unavailable',
    moveToCloud: 'Move to the cloud',
    moveTo: name => `Move to ${name || 'another Mac'}`,
    moveHere: name => `Move to this Mac${name ? ` (${name})` : ''}`,
    noOtherMac: 'Sign in to Atum on another Mac to move it there.',
    steps: {
      asking: name => `Starting the move to ${name}…`,
      saving: () => 'Finishing what it is doing and saving its memory…',
      handing_over: name => `Handing over to ${name}…`,
      taking_over: name => `Setting up on ${name}…`
    },
    cancel: 'Cancel move',
    cancelling: 'Cancelling…',
    cancelFailed: 'It is too late to cancel. The move is finishing.',
    issues: {
      no_local_home: 'That Mac has not set this assistant up yet. Open Atum there once, then try again.',
      no_local_agent: 'That Mac has not set this assistant up yet. Open Atum there once, then try again.',
      runtime_unavailable: 'Atum is not ready on that Mac yet.',
      platform_unsupported: 'Moving between Macs is not available yet.',
      platform_unavailable: 'Atum cannot be reached right now. The move will carry on when it can.',
      placement_stale: 'It lives in the cloud, but Atum must repair its saved location before it can be changed. Try again later.',
      placement_unavailable: 'It lives in the cloud, but Atum could not refresh that location. Try again in a moment.',
      platform_unauthorized: 'Sign in to Atum again to carry on with the move.',
      lease_term_unavailable: 'This Mac is not answering for it right now, so it could not hand it over. It stays here.',
      drain_timed_out: 'It was still busy, so the move was called off. It stays here.',
      target_unavailable: 'The other Mac did not take over in time, so the move was called off. It stays here.'
    },
    issueFallback: 'The move has not finished yet. It will keep trying.',
    endedFallback: 'The last move did not finish, so it stays where it was.',
    refusals: {
      unsupported: 'Moving between Macs is not available yet.',
      not_enrolled: 'Set up this Mac for your assistants first, then try again.',
      cloud_source: 'This assistant lives in the cloud.',
      already_there: 'It already lives there.',
      busy: 'Another move is still going.',
      stale: 'Something changed. Try again.',
      forbidden: 'This Mac cannot move it.',
      unavailable: 'Atum cannot be reached right now. Try again in a moment.',
      invalid: 'Pick one of your Macs.',
      unauthorized: 'Sign in to Atum again, then try once more.',
      conflict: 'Something changed. Try again.',
      another_move_in_progress: 'Another move is still going.',
      not_eligible: "It can't move there right now.",
      preflight_required: 'Review the move again, then try once more.',
      preflight_expired: 'That review is out of date. Review the move again.',
      feature_losses_changed: 'What will not move has changed. Review the move again.',
      cloud_controller_version_unsupported: 'Moving to or from the cloud needs an update first.',
      catalog_stale: "That Mac's models are out of date. Open Atum on it, then try again.",
      idempotency_conflict: 'That request was already used for something different. Review the move again.',
      committed_epoch_preserved: 'It is too late to cancel. The move is finishing.',
      surface_mismatch: "This window can't make that change.",
      checkpoint_loss_not_accepted: 'Tick the box to accept losing those changes, then move.',
      unknown_export_class: "Some of its data can't be moved safely yet.",
      target_unavailable: "That place isn't available right now.",
      connection_unavailable: "That model's connection isn't available right now.",
      stale_home: 'Where it lives changed. Try again.',
      active_move_changed: 'A move started or ended. Try again.',
      stale_choice_revision: 'Its model was just changed somewhere else. Try again.',
      model_unavailable: "That model isn't available there right now.",
      destination_not_current: 'That model belongs to somewhere else. Move it there first.',
      setup_busy: 'Atum is busy with this assistant on this Mac. Try again in a moment.',
      not_ready: 'Atum isn\'t ready on this Mac yet. Try again in a minute.',
      target_not_prepared: 'That Mac isn\'t set up for this assistant yet. Set it up first, then try again.',
      connect_model: 'No model is connected on this Mac yet. Connect one, then try again.',
      current_home_unreachable: 'Its Mac isn\'t answering right now. Wait for it, or move to the cloud.'
    },
    livesOn: 'Lives on',
    model: 'Model',
    reviewMove: 'Review move',
    move: 'Move',
    moving: 'Moving…',
    saveModel: 'Use this model',
    savingModel: 'Saving…',
    ready: 'Ready',
    readinessChecking: 'Checking…',
    readinessAsleep: 'Asleep',
    readinessUnavailable: 'Not reachable',
    actualLosses: 'Some local access won’t move.',
    noLosses: 'Everything supported moves.',
    lastCheckpoint: time => `Last checkpoint: ${time}`,
    acceptCheckpointLoss: 'I accept losing changes since this checkpoint',
    noModels: name => `No model is connected on ${name || 'that Mac'} yet.`,
    waitingForMac: name => `Waiting for ${name || 'your Mac'}`,
    thisMac: 'This Mac',
    preparing: name => `Setting up ${name || 'this Mac'}…`,
    waitingForCurrentMac: mac => `${mac} is offline; wait or move to cloud.`,
    summary: (place, provider, model) => `Lives on: ${place} · Model: ${provider} · ${model}`,
    progress: {
      finishing_current_work: () => 'Finishing current work',
      moving: () => 'Moving',
      waiting_for_destination: name => `Waiting for ${name || 'your Mac'}`,
      reconciling: () => 'Checking the move',
      ready: name => `Ready on ${name}`,
      failed: () => 'Move did not finish'
    },
    losses: {
      google_protected_route: 'Protected Google access on the current home',
      protected_private_skill: 'A private skill that cannot be exported',
      cloud_browser_session: 'Cloud browser sessions',
      cloud_computer: 'Cloud computer access',
      drive_publication: 'Drive publication from the current home',
      routine_execution: 'Routines that only run on the current home',
      push_delivery: 'Push delivery from the current home',
      changes_since_last_checkpoint_lost: 'Changes since the last checkpoint',
      model_source_changes_to_atum: 'The current Mac connection; cloud uses an Atum model',
      local_tools_unavailable: 'Tools installed only on this Mac',
      local_files_unavailable: 'Files stored only on this Mac',
      local_browser_sessions_unavailable: 'Browser sessions stored only on this Mac',
      conversation_overrides_cleared: 'Conversation-specific model choices'
    }
  },
  vi: {
    rowTitle: 'Đang ở trên',
    livesWhere: 'Đang ở trên',
    canUse: 'Dùng được',
    noMac: 'Chưa có máy Mac',
    title: 'Trợ lý đang ở đâu',
    finding: 'Đang xác định vị trí…',
    unknownPlace: 'Chưa xác định được vị trí.',
    retryRead: 'Thử lại',
    anotherMac: 'một máy Mac khác',
    cloud: 'đám mây',
    cloudPlace: 'Đám mây',
    homeLine: 'Nơi chính · chuyển thủ công',
    macHomeNote: 'Trợ lý giờ chạy trên đám mây.',
    place: name => name || 'Một máy Mac khác',
    placeHere: name => (name ? `${name} · máy này` : 'Máy này'),
    moveHeading: 'Chuyển sang…',
    moveSection: 'Chuyển sang',
    unavailableReasons: {
      offline: 'Ngoại tuyến',
      not_enrolled: 'Chưa thiết lập',
      version_unsupported: 'Cần cập nhật',
      home_conflict: 'Đang bận',
      catalog_unavailable: 'Chưa có mô hình'
    },
    unavailableFallback: 'Chưa thể chuyển',
    moveToCloud: 'Chuyển lên đám mây',
    moveTo: name => `Chuyển sang ${name || 'một máy Mac khác'}`,
    moveHere: name => `Chuyển về máy này${name ? ` (${name})` : ''}`,
    noOtherMac: 'Đăng nhập Atum trên một máy Mac khác để chuyển trợ lý sang đó.',
    steps: {
      asking: name => `Đang bắt đầu chuyển sang ${name}…`,
      saving: () => 'Đang hoàn tất việc đang làm và lưu trí nhớ…',
      handing_over: name => `Đang bàn giao cho ${name}…`,
      taking_over: name => `Đang thiết lập trên ${name}…`
    },
    cancel: 'Hủy chuyển',
    cancelling: 'Đang hủy…',
    cancelFailed: 'Đã quá muộn để hủy. Việc chuyển sắp xong.',
    issues: {
      no_local_home: 'Máy đó chưa thiết lập trợ lý này. Hãy mở Atum trên máy đó một lần, rồi thử lại.',
      no_local_agent: 'Máy đó chưa thiết lập trợ lý này. Hãy mở Atum trên máy đó một lần, rồi thử lại.',
      runtime_unavailable: 'Atum chưa sẵn sàng trên máy đó.',
      platform_unsupported: 'Chưa thể chuyển giữa các máy Mac.',
      platform_unavailable: 'Hiện chưa kết nối được Atum. Việc chuyển sẽ tiếp tục khi kết nối lại.',
      placement_stale: 'Trợ lý đang ở trên đám mây, nhưng Atum cần sửa vị trí đã lưu trước khi thay đổi. Hãy thử lại sau.',
      placement_unavailable: 'Trợ lý đang ở trên đám mây, nhưng Atum chưa làm mới được vị trí. Hãy thử lại sau một lát.',
      platform_unauthorized: 'Hãy đăng nhập lại Atum để tiếp tục việc chuyển.',
      lease_term_unavailable: 'Máy này hiện không trả lời thay trợ lý nên chưa thể bàn giao. Trợ lý vẫn ở lại đây.',
      drain_timed_out: 'Trợ lý vẫn đang bận nên việc chuyển đã bị hủy. Trợ lý vẫn ở lại đây.',
      target_unavailable: 'Máy kia chưa tiếp nhận kịp nên việc chuyển đã bị hủy. Trợ lý vẫn ở lại đây.'
    },
    issueFallback: 'Việc chuyển chưa xong. Atum sẽ tiếp tục thử.',
    endedFallback: 'Lần chuyển vừa rồi chưa xong, nên trợ lý vẫn ở nơi cũ.',
    refusals: {
      unsupported: 'Chưa thể chuyển giữa các máy Mac.',
      not_enrolled: 'Hãy thiết lập máy này cho các trợ lý trước, rồi thử lại.',
      cloud_source: 'Trợ lý này đang ở trên đám mây.',
      already_there: 'Trợ lý đã ở đó rồi.',
      busy: 'Một lần chuyển khác vẫn đang diễn ra.',
      stale: 'Có thay đổi. Hãy thử lại.',
      forbidden: 'Máy này không thể chuyển trợ lý.',
      unavailable: 'Hiện chưa kết nối được Atum. Hãy thử lại sau một lát.',
      invalid: 'Hãy chọn một trong các máy Mac của bạn.',
      unauthorized: 'Hãy đăng nhập lại Atum, rồi thử lại.',
      conflict: 'Có thay đổi. Hãy thử lại.',
      another_move_in_progress: 'Một lần chuyển khác vẫn đang diễn ra.',
      not_eligible: 'Hiện chưa thể chuyển trợ lý đến đó.',
      preflight_required: 'Hãy xem lại việc chuyển, rồi thử lần nữa.',
      preflight_expired: 'Bản xem trước đã cũ. Hãy xem lại việc chuyển.',
      feature_losses_changed: 'Những gì sẽ không được chuyển đã thay đổi. Hãy xem lại việc chuyển.',
      cloud_controller_version_unsupported: 'Cần cập nhật trước khi chuyển đến hoặc đi từ đám mây.',
      catalog_stale: 'Danh sách mô hình trên máy Mac đó đã cũ. Hãy mở Atum trên máy đó rồi thử lại.',
      idempotency_conflict: 'Yêu cầu này đã được dùng cho việc khác. Hãy xem lại việc chuyển.',
      committed_epoch_preserved: 'Đã quá muộn để hủy. Việc chuyển sắp xong.',
      surface_mismatch: 'Cửa sổ này không thể thực hiện thay đổi đó.',
      checkpoint_loss_not_accepted: 'Hãy đánh dấu đồng ý mất các thay đổi đó, rồi chuyển.',
      unknown_export_class: 'Một số dữ liệu chưa thể chuyển an toàn.',
      target_unavailable: 'Nơi đó hiện chưa sẵn sàng.',
      connection_unavailable: 'Kết nối của mô hình đó hiện chưa sẵn sàng.',
      stale_home: 'Nơi trợ lý đang ở đã thay đổi. Hãy thử lại.',
      active_move_changed: 'Một việc chuyển vừa bắt đầu hoặc kết thúc. Hãy thử lại.',
      stale_choice_revision: 'Mô hình vừa được đổi ở nơi khác. Hãy thử lại.',
      model_unavailable: 'Mô hình đó hiện chưa dùng được ở đó.',
      destination_not_current: 'Mô hình đó thuộc về nơi khác. Hãy chuyển trợ lý đến đó trước.',
      setup_busy: 'Atum đang bận với trợ lý này trên máy này. Hãy thử lại sau một lát.',
      not_ready: 'Atum chưa sẵn sàng trên máy này. Hãy thử lại sau một phút.',
      target_not_prepared: 'Máy Mac đó chưa được thiết lập cho trợ lý này. Hãy thiết lập trước, rồi thử lại.',
      connect_model: 'Máy này chưa có mô hình nào được kết nối. Hãy kết nối một mô hình, rồi thử lại.',
      current_home_unreachable: 'Máy Mac của trợ lý hiện chưa phản hồi. Hãy chờ máy đó, hoặc chuyển lên đám mây.'
    },
    livesOn: 'Đang ở trên',
    model: 'Mô hình',
    reviewMove: 'Xem trước khi chuyển',
    move: 'Chuyển',
    moving: 'Đang chuyển…',
    saveModel: 'Dùng mô hình này',
    savingModel: 'Đang lưu…',
    ready: 'Sẵn sàng',
    readinessChecking: 'Đang kiểm tra…',
    readinessAsleep: 'Đang ngủ',
    readinessUnavailable: 'Chưa kết nối được',
    actualLosses: 'Một số quyền cục bộ sẽ không chuyển.',
    noLosses: 'Mọi nội dung được hỗ trợ sẽ chuyển.',
    lastCheckpoint: time => `Điểm lưu gần nhất: ${time}`,
    acceptCheckpointLoss: 'Tôi chấp nhận mất thay đổi kể từ điểm lưu này',
    noModels: name => `Chưa có mô hình nào được kết nối trên ${name || 'máy Mac đó'}.`,
    waitingForMac: name => `Đang chờ ${name || 'máy Mac của bạn'}`,
    thisMac: 'Máy này',
    preparing: name => `Đang thiết lập ${name || 'máy này'}…`,
    waitingForCurrentMac: mac => `${mac} ngoại tuyến; hãy chờ hoặc chuyển lên đám mây.`,
    summary: (place, provider, model) => `Đang ở trên: ${place} · Mô hình: ${provider} · ${model}`,
    progress: {
      finishing_current_work: () => 'Đang hoàn tất công việc hiện tại',
      moving: () => 'Đang chuyển',
      waiting_for_destination: name => `Đang chờ ${name || 'máy Mac của bạn'}`,
      reconciling: () => 'Đang kiểm tra việc chuyển',
      ready: name => `Sẵn sàng trên ${name}`,
      failed: () => 'Việc chuyển chưa hoàn tất'
    },
    losses: {
      google_protected_route: 'Quyền truy cập Google được bảo vệ ở nơi hiện tại',
      protected_private_skill: 'Một kỹ năng riêng tư không thể xuất',
      cloud_browser_session: 'Các phiên trình duyệt trên đám mây',
      cloud_computer: 'Quyền dùng máy tính đám mây',
      drive_publication: 'Đăng lên Drive từ nơi hiện tại',
      routine_execution: 'Các lịch việc chỉ chạy ở nơi hiện tại',
      push_delivery: 'Thông báo đẩy từ nơi hiện tại',
      changes_since_last_checkpoint_lost: 'Các thay đổi kể từ điểm lưu gần nhất',
      model_source_changes_to_atum: 'Kết nối trên Mac hiện tại; đám mây dùng mô hình Atum',
      local_tools_unavailable: 'Công cụ chỉ được cài trên máy Mac này',
      local_files_unavailable: 'Tệp chỉ được lưu trên máy Mac này',
      local_browser_sessions_unavailable: 'Phiên trình duyệt chỉ được lưu trên máy Mac này',
      conversation_overrides_cleared: 'Lựa chọn mô hình riêng của từng cuộc trò chuyện'
    }
  },
  ja: {
    rowTitle: 'いる場所',
    livesWhere: '現在の場所',
    canUse: '使える Mac',
    noMac: 'まだ Mac がありません',
    title: 'アシスタントがいる場所',
    finding: '場所を確認しています…',
    unknownPlace: '場所を確認できませんでした。',
    retryRead: 'もう一度試す',
    anotherMac: '別の Mac',
    cloud: 'クラウド',
    cloudPlace: 'クラウド',
    homeLine: '主な場所 · 移動は手動',
    macHomeNote: 'アシスタントはクラウドで動くようになりました。',
    place: name => name || '別の Mac',
    placeHere: name => (name ? `${name} · この Mac` : 'この Mac'),
    moveHeading: '移動先…',
    moveSection: '移動先',
    unavailableReasons: {
      offline: 'オフライン',
      not_enrolled: '未設定',
      version_unsupported: 'アップデートが必要',
      home_conflict: '使用中',
      catalog_unavailable: 'モデルなし'
    },
    unavailableFallback: '利用できません',
    moveToCloud: 'クラウドへ移動',
    moveTo: name => `${name || '別の Mac'} に移動`,
    moveHere: name => `この Mac に移動${name ? `（${name}）` : ''}`,
    noOtherMac: '別の Mac で Atum にサインインすると、そこへ移動できます。',
    steps: {
      asking: name => `${name} への移動を開始しています…`,
      saving: () => '作業を終えて、記憶を保存しています…',
      handing_over: name => `${name} に引き継いでいます…`,
      taking_over: name => `${name} で準備しています…`
    },
    cancel: '移動をキャンセル',
    cancelling: 'キャンセルしています…',
    cancelFailed: 'キャンセルするには遅すぎます。移動はまもなく完了します。',
    issues: {
      no_local_home: 'その Mac ではまだこのアシスタントの準備ができていません。その Mac で Atum を一度開いてから、もう一度お試しください。',
      no_local_agent: 'その Mac ではまだこのアシスタントの準備ができていません。その Mac で Atum を一度開いてから、もう一度お試しください。',
      runtime_unavailable: 'その Mac ではまだ Atum の準備ができていません。',
      platform_unsupported: 'Mac 間の移動はまだご利用いただけません。',
      platform_unavailable: '現在 Atum に接続できません。接続できるようになったら移動を続けます。',
      placement_stale: 'クラウドにいますが、場所を変更する前に Atum が保存済みの場所を修復する必要があります。後でもう一度お試しください。',
      placement_unavailable: 'クラウドにいますが、Atum はその場所を更新できませんでした。しばらくしてからもう一度お試しください。',
      platform_unauthorized: '移動を続けるには、Atum にもう一度サインインしてください。',
      lease_term_unavailable: 'この Mac は今このアシスタントの応答を担当していないため、引き継げませんでした。アシスタントはこのまま残ります。',
      drain_timed_out: 'まだ作業中だったため、移動を取りやめました。アシスタントはこのまま残ります。',
      target_unavailable: 'もう一方の Mac が時間内に引き継げなかったため、移動を取りやめました。アシスタントはこのまま残ります。'
    },
    issueFallback: '移動はまだ完了していません。引き続き試行します。',
    endedFallback: '前回の移動は完了しなかったため、アシスタントは元の場所に残っています。',
    refusals: {
      unsupported: 'Mac 間の移動はまだご利用いただけません。',
      not_enrolled: 'まずこの Mac をアシスタント用に設定してから、もう一度お試しください。',
      cloud_source: 'このアシスタントはクラウドにいます。',
      already_there: 'すでにそこにいます。',
      busy: '別の移動がまだ進行中です。',
      stale: '状況が変わりました。もう一度お試しください。',
      forbidden: 'この Mac では移動できません。',
      unavailable: '現在 Atum に接続できません。しばらくしてからもう一度お試しください。',
      invalid: 'お持ちの Mac から選んでください。',
      unauthorized: 'Atum にもう一度サインインして、やり直してください。',
      conflict: '状況が変わりました。もう一度お試しください。',
      another_move_in_progress: '別の移動がまだ進行中です。',
      not_eligible: '今はそこへ移動できません。',
      preflight_required: '移動内容をもう一度確認してから、やり直してください。',
      preflight_expired: '確認内容が古くなりました。移動内容をもう一度確認してください。',
      feature_losses_changed: '移動しないものが変わりました。移動内容をもう一度確認してください。',
      cloud_controller_version_unsupported: 'クラウドへの移動、またはクラウドからの移動には、先にアップデートが必要です。',
      catalog_stale: 'その Mac のモデル情報が古くなっています。その Mac で Atum を開いてから、もう一度お試しください。',
      idempotency_conflict: 'このリクエストはすでに別の内容で使われています。移動内容をもう一度確認してください。',
      committed_epoch_preserved: 'キャンセルするには遅すぎます。移動はまもなく完了します。',
      surface_mismatch: 'このウインドウではその変更はできません。',
      checkpoint_loss_not_accepted: '変更が失われることに同意するボックスにチェックを入れてから、移動してください。',
      unknown_export_class: '一部のデータはまだ安全に移動できません。',
      target_unavailable: 'その場所は今ご利用いただけません。',
      connection_unavailable: 'そのモデルの接続は今ご利用いただけません。',
      stale_home: 'アシスタントがいる場所が変わりました。もう一度お試しください。',
      active_move_changed: '移動が開始または終了しました。もう一度お試しください。',
      stale_choice_revision: 'モデルがほかの場所で変更されました。もう一度お試しください。',
      model_unavailable: 'そのモデルは今そこでは使えません。',
      destination_not_current: 'そのモデルは別の場所のものです。先にそこへ移動してください。',
      setup_busy: 'この Mac では、Atum がこのアシスタントの処理中です。しばらくしてからもう一度お試しください。',
      not_ready: 'この Mac ではまだ Atum の準備ができていません。1 分ほどしてからもう一度お試しください。',
      target_not_prepared: 'その Mac は、まだこのアシスタント用に設定されていません。先に設定してから、もう一度お試しください。',
      connect_model: 'この Mac にはまだモデルが接続されていません。接続してから、もう一度お試しください。',
      current_home_unreachable: 'アシスタントがいる Mac が今応答していません。待つか、クラウドへ移動してください。'
    },
    livesOn: 'いる場所',
    model: 'モデル',
    reviewMove: '移動内容を確認',
    move: '移動',
    moving: '移動しています…',
    saveModel: 'このモデルを使う',
    savingModel: '保存しています…',
    ready: '準備完了',
    readinessChecking: '確認しています…',
    readinessAsleep: 'スリープ中',
    readinessUnavailable: '現在接続できません',
    actualLosses: '一部のローカルアクセスは移動しません。',
    noLosses: '対応する内容はすべて移動します。',
    lastCheckpoint: time => `最後のチェックポイント: ${time}`,
    acceptCheckpointLoss: 'このチェックポイント以降の変更が失われることに同意します',
    noModels: name => `${name || 'その Mac'} にはまだモデルが接続されていません。`,
    waitingForMac: name => `${name || 'Mac'} を待っています`,
    thisMac: 'この Mac',
    preparing: name => `${name || 'この Mac'} を設定しています…`,
    waitingForCurrentMac: mac => `${mac} はオフラインです。待つかクラウドへ移します。`,
    summary: (place, provider, model) => `いる場所: ${place} · モデル: ${provider} · ${model}`,
    progress: {
      finishing_current_work: () => '現在の作業を終えています',
      moving: () => '移動しています',
      waiting_for_destination: name => `${name || 'Mac'} を待っています`,
      reconciling: () => '移動を確認しています',
      ready: name => `${name} で準備完了`,
      failed: () => '移動は完了しませんでした'
    },
    losses: {
      google_protected_route: '現在の場所にある保護された Google アクセス',
      protected_private_skill: '書き出せないプライベートスキル',
      cloud_browser_session: 'クラウドのブラウザセッション',
      cloud_computer: 'クラウドコンピュータへのアクセス',
      drive_publication: '現在の場所からの Drive 公開',
      routine_execution: '現在の場所でのみ動くルーティン',
      push_delivery: '現在の場所からのプッシュ配信',
      changes_since_last_checkpoint_lost: '最後のチェックポイント以降の変更',
      model_source_changes_to_atum: '現在の Mac 接続。クラウドでは Atum モデルを使用します',
      local_tools_unavailable: 'この Mac にのみインストールされたツール',
      local_files_unavailable: 'この Mac にのみ保存されたファイル',
      local_browser_sessions_unavailable: 'この Mac にのみ保存されたブラウザセッション',
      conversation_overrides_cleared: '会話ごとのモデル選択'
    }
  },
  zh: {
    rowTitle: '所在位置',
    livesWhere: '目前位置',
    canUse: '可使用',
    noMac: '还没有 Mac',
    title: '助手所在的位置',
    finding: '正在确认所在位置…',
    unknownPlace: '暂时无法确认所在位置。',
    retryRead: '重试',
    anotherMac: '另一台 Mac',
    cloud: '云端',
    cloudPlace: '云端',
    homeLine: '主要位置 · 手动移动',
    macHomeNote: '助理现在在云端运行。',
    place: name => name || '另一台 Mac',
    placeHere: name => (name ? `${name} · 这台 Mac` : '这台 Mac'),
    moveHeading: '移动到…',
    moveSection: '移动到',
    unavailableReasons: {
      offline: '离线',
      not_enrolled: '未设置',
      version_unsupported: '需要更新',
      home_conflict: '忙碌中',
      catalog_unavailable: '暂无模型'
    },
    unavailableFallback: '暂不可用',
    moveToCloud: '移到云端',
    moveTo: name => `移动到 ${name || '另一台 Mac'}`,
    moveHere: name => `移动到这台 Mac${name ? `（${name}）` : ''}`,
    noOtherMac: '在另一台 Mac 上登录 Atum，即可将助手移动到那里。',
    steps: {
      asking: name => `正在开始移动到 ${name}…`,
      saving: () => '正在完成当前工作并保存记忆…',
      handing_over: name => `正在移交给 ${name}…`,
      taking_over: name => `正在 ${name} 上设置…`
    },
    cancel: '取消移动',
    cancelling: '正在取消…',
    cancelFailed: '已来不及取消，移动即将完成。',
    issues: {
      no_local_home: '那台 Mac 还没有设置此助手。请先在那台 Mac 上打开一次 Atum，然后重试。',
      no_local_agent: '那台 Mac 还没有设置此助手。请先在那台 Mac 上打开一次 Atum，然后重试。',
      runtime_unavailable: 'Atum 在那台 Mac 上尚未就绪。',
      platform_unsupported: '暂不支持在 Mac 之间移动。',
      platform_unavailable: '目前无法连接 Atum。连接恢复后会继续移动。',
      placement_stale: '助理在云端，但 Atum 需要先修复已保存的位置才能更改。请稍后重试。',
      placement_unavailable: '助理在云端，但 Atum 暂时无法刷新该位置。请稍后重试。',
      platform_unauthorized: '请重新登录 Atum 以继续移动。',
      lease_term_unavailable: '这台 Mac 目前没有在为助手回复，因此无法移交。助手仍留在这里。',
      drain_timed_out: '助手仍在忙碌，因此已取消移动。助手仍留在这里。',
      target_unavailable: '另一台 Mac 未能及时接手，因此已取消移动。助手仍留在这里。'
    },
    issueFallback: '移动尚未完成，Atum 会继续尝试。',
    endedFallback: '上一次移动未完成，助手仍留在原来的位置。',
    refusals: {
      unsupported: '暂不支持在 Mac 之间移动。',
      not_enrolled: '请先将这台 Mac 设置为可运行助手，然后重试。',
      cloud_source: '此助手位于云端。',
      already_there: '它已经在那里了。',
      busy: '另一次移动仍在进行。',
      stale: '情况有变化，请重试。',
      forbidden: '这台 Mac 无法移动它。',
      unavailable: '目前无法连接 Atum，请稍后重试。',
      invalid: '请选择你的某一台 Mac。',
      unauthorized: '请重新登录 Atum，然后再试一次。',
      conflict: '情况有变化，请重试。',
      another_move_in_progress: '另一次移动仍在进行。',
      not_eligible: '目前无法移动到那里。',
      preflight_required: '请重新查看移动内容，然后再试一次。',
      preflight_expired: '查看的内容已过期。请重新查看移动内容。',
      feature_losses_changed: '不会随之移动的内容已有变化。请重新查看移动内容。',
      cloud_controller_version_unsupported: '移动到云端或从云端移出之前，需要先更新。',
      catalog_stale: '那台 Mac 上的模型列表已过期。请先在那台 Mac 上打开 Atum，然后重试。',
      idempotency_conflict: '这个请求已用于其他内容。请重新查看移动内容。',
      committed_epoch_preserved: '已来不及取消，移动即将完成。',
      surface_mismatch: '这个窗口无法进行该更改。',
      checkpoint_loss_not_accepted: '请勾选同意丢失这些更改，然后再移动。',
      unknown_export_class: '部分数据暂时无法安全移动。',
      target_unavailable: '那个位置目前不可用。',
      connection_unavailable: '该模型的连接目前不可用。',
      stale_home: '助手所在的位置已发生变化，请重试。',
      active_move_changed: '有一次移动刚开始或刚结束，请重试。',
      stale_choice_revision: '模型刚在别处被更改，请重试。',
      model_unavailable: '该模型目前在那里不可用。',
      destination_not_current: '该模型属于其他位置。请先将助手移动到那里。',
      setup_busy: 'Atum 正在这台 Mac 上处理这个助手。请稍后再试。',
      not_ready: 'Atum 在这台 Mac 上尚未就绪。请一分钟后再试。',
      target_not_prepared: '那台 Mac 尚未为这个助手设置。请先完成设置，然后重试。',
      connect_model: '这台 Mac 上还没有连接模型。请先连接一个模型，然后重试。',
      current_home_unreachable: '助手所在的 Mac 目前没有响应。请等待它，或将助手移动到云端。'
    },
    livesOn: '所在位置',
    model: '模型',
    reviewMove: '查看移动内容',
    move: '移动',
    moving: '正在移动…',
    saveModel: '使用此模型',
    savingModel: '正在保存…',
    ready: '已就绪',
    readinessChecking: '正在检查…',
    readinessAsleep: '已休眠',
    readinessUnavailable: '暂时无法连接',
    actualLosses: '部分本地访问不会移动。',
    noLosses: '所有受支持的内容都会移动。',
    lastCheckpoint: time => `上次检查点：${time}`,
    acceptCheckpointLoss: '我接受丢失此检查点之后的更改',
    noModels: name => `${name || '那台 Mac'} 上还没有连接模型。`,
    waitingForMac: name => `正在等待 ${name || '你的 Mac'}`,
    thisMac: '这台 Mac',
    preparing: name => `正在设置 ${name || '这台 Mac'}…`,
    waitingForCurrentMac: mac => `${mac} 已离线；等待或移到云端。`,
    summary: (place, provider, model) => `所在位置：${place} · 模型：${provider} · ${model}`,
    progress: {
      finishing_current_work: () => '正在完成当前工作',
      moving: () => '正在移动',
      waiting_for_destination: name => `正在等待 ${name || '你的 Mac'}`,
      reconciling: () => '正在核对移动结果',
      ready: name => `已在 ${name} 上就绪`,
      failed: () => '移动未完成'
    },
    losses: {
      google_protected_route: '当前位置受保护的 Google 访问',
      protected_private_skill: '无法导出的私有技能',
      cloud_browser_session: '云端浏览器会话',
      cloud_computer: '云电脑访问',
      drive_publication: '从当前位置发布到 Drive',
      routine_execution: '仅在当前位置运行的例行任务',
      push_delivery: '从当前位置发送的推送',
      changes_since_last_checkpoint_lost: '上次检查点之后的更改',
      model_source_changes_to_atum: '当前 Mac 连接；云端将使用 Atum 模型',
      local_tools_unavailable: '仅安装在这台 Mac 上的工具',
      local_files_unavailable: '仅存储在这台 Mac 上的文件',
      local_browser_sessions_unavailable: '仅存储在这台 Mac 上的浏览器会话',
      conversation_overrides_cleared: '各个对话单独选择的模型'
    }
  },
  'zh-hant': {
    rowTitle: '所在位置',
    livesWhere: '目前位置',
    canUse: '可使用',
    noMac: '還沒有 Mac',
    title: '助理所在的位置',
    finding: '正在確認所在位置…',
    unknownPlace: '暫時無法確認所在位置。',
    retryRead: '再試一次',
    anotherMac: '另一部 Mac',
    cloud: '雲端',
    cloudPlace: '雲端',
    homeLine: '主要位置 · 手動移動',
    macHomeNote: '助理現在在雲端執行。',
    place: name => name || '另一部 Mac',
    placeHere: name => (name ? `${name} · 這部 Mac` : '這部 Mac'),
    moveHeading: '移動到…',
    moveSection: '移動到',
    unavailableReasons: {
      offline: '離線',
      not_enrolled: '未設定',
      version_unsupported: '需要更新',
      home_conflict: '忙碌中',
      catalog_unavailable: '暫無模型'
    },
    unavailableFallback: '暫時無法使用',
    moveToCloud: '移到雲端',
    moveTo: name => `移動到 ${name || '另一部 Mac'}`,
    moveHere: name => `移動到這部 Mac${name ? `（${name}）` : ''}`,
    noOtherMac: '在另一部 Mac 上登入 Atum，即可將助理移動到那裡。',
    steps: {
      asking: name => `正在開始移動到 ${name}…`,
      saving: () => '正在完成目前的工作並儲存記憶…',
      handing_over: name => `正在移交給 ${name}…`,
      taking_over: name => `正在 ${name} 上設定…`
    },
    cancel: '取消移動',
    cancelling: '正在取消…',
    cancelFailed: '已來不及取消，移動即將完成。',
    issues: {
      no_local_home: '那部 Mac 尚未設定此助理。請先在那部 Mac 上開啟一次 Atum，然後再試一次。',
      no_local_agent: '那部 Mac 尚未設定此助理。請先在那部 Mac 上開啟一次 Atum，然後再試一次。',
      runtime_unavailable: 'Atum 在那部 Mac 上尚未就緒。',
      platform_unsupported: '目前尚不支援在 Mac 之間移動。',
      platform_unavailable: '目前無法連線到 Atum。連線恢復後會繼續移動。',
      placement_stale: '助理在雲端，但 Atum 需要先修復已儲存的位置才能變更。請稍後再試。',
      placement_unavailable: '助理在雲端，但 Atum 暫時無法重新整理該位置。請稍後再試。',
      platform_unauthorized: '請重新登入 Atum 以繼續移動。',
      lease_term_unavailable: '這部 Mac 目前沒有在為助理回覆，因此無法移交。助理仍留在這裡。',
      drain_timed_out: '助理仍在忙碌，因此已取消移動。助理仍留在這裡。',
      target_unavailable: '另一部 Mac 未能及時接手，因此已取消移動。助理仍留在這裡。'
    },
    issueFallback: '移動尚未完成，Atum 會繼續嘗試。',
    endedFallback: '上一次移動未完成，助理仍留在原本的位置。',
    refusals: {
      unsupported: '目前尚不支援在 Mac 之間移動。',
      not_enrolled: '請先將這部 Mac 設定為可執行助理，然後再試一次。',
      cloud_source: '此助理位於雲端。',
      already_there: '它已經在那裡了。',
      busy: '另一次移動仍在進行。',
      stale: '情況有變動，請再試一次。',
      forbidden: '這部 Mac 無法移動它。',
      unavailable: '目前無法連線到 Atum，請稍後再試。',
      invalid: '請選擇你的其中一部 Mac。',
      unauthorized: '請重新登入 Atum，然後再試一次。',
      conflict: '情況有變動，請再試一次。',
      another_move_in_progress: '另一次移動仍在進行。',
      not_eligible: '目前無法移動到那裡。',
      preflight_required: '請重新檢視移動內容，然後再試一次。',
      preflight_expired: '檢視的內容已過期。請重新檢視移動內容。',
      feature_losses_changed: '不會隨之移動的內容已有變動。請重新檢視移動內容。',
      cloud_controller_version_unsupported: '移動到雲端或從雲端移出之前，需要先更新。',
      catalog_stale: '那部 Mac 上的模型清單已過期。請先在那部 Mac 上開啟 Atum，然後再試一次。',
      idempotency_conflict: '這個請求已用於其他內容。請重新檢視移動內容。',
      committed_epoch_preserved: '已來不及取消，移動即將完成。',
      surface_mismatch: '這個視窗無法進行該變更。',
      checkpoint_loss_not_accepted: '請勾選同意遺失這些變更，然後再移動。',
      unknown_export_class: '部分資料暫時無法安全移動。',
      target_unavailable: '那個位置目前無法使用。',
      connection_unavailable: '該模型的連線目前無法使用。',
      stale_home: '助理所在的位置已有變動，請再試一次。',
      active_move_changed: '有一次移動剛開始或剛結束，請再試一次。',
      stale_choice_revision: '模型剛在別處被更改，請再試一次。',
      model_unavailable: '該模型目前在那裡無法使用。',
      destination_not_current: '該模型屬於其他位置。請先將助理移動到那裡。',
      setup_busy: 'Atum 正在這部 Mac 上處理這個助理。請稍後再試。',
      not_ready: 'Atum 在這部 Mac 上尚未就緒。請一分鐘後再試。',
      target_not_prepared: '那部 Mac 尚未為這個助理設定。請先完成設定，然後再試一次。',
      connect_model: '這部 Mac 上尚未連接模型。請先連接一個模型，然後再試一次。',
      current_home_unreachable: '助理所在的 Mac 目前沒有回應。請等待它，或將助理移動到雲端。'
    },
    livesOn: '所在位置',
    model: '模型',
    reviewMove: '檢視移動內容',
    move: '移動',
    moving: '正在移動…',
    saveModel: '使用此模型',
    savingModel: '正在儲存…',
    ready: '已就緒',
    readinessChecking: '正在檢查…',
    readinessAsleep: '已休眠',
    readinessUnavailable: '暫時無法連線',
    actualLosses: '部分本機存取不會移動。',
    noLosses: '所有支援的內容都會移動。',
    lastCheckpoint: time => `上次檢查點：${time}`,
    acceptCheckpointLoss: '我接受遺失此檢查點之後的變更',
    noModels: name => `${name || '那部 Mac'} 上尚未連接模型。`,
    waitingForMac: name => `正在等待 ${name || '你的 Mac'}`,
    thisMac: '這部 Mac',
    preparing: name => `正在設定 ${name || '這部 Mac'}…`,
    waitingForCurrentMac: mac => `${mac} 已離線；等待或移到雲端。`,
    summary: (place, provider, model) => `所在位置：${place} · 模型：${provider} · ${model}`,
    progress: {
      finishing_current_work: () => '正在完成目前的工作',
      moving: () => '正在移動',
      waiting_for_destination: name => `正在等待 ${name || '你的 Mac'}`,
      reconciling: () => '正在核對移動結果',
      ready: name => `已在 ${name} 上就緒`,
      failed: () => '移動未完成'
    },
    losses: {
      google_protected_route: '目前位置受保護的 Google 存取',
      protected_private_skill: '無法匯出的私人技能',
      cloud_browser_session: '雲端瀏覽器工作階段',
      cloud_computer: '雲端電腦存取',
      drive_publication: '從目前位置發佈到 Drive',
      routine_execution: '只在目前位置執行的例行工作',
      push_delivery: '從目前位置傳送的推播',
      changes_since_last_checkpoint_lost: '上次檢查點之後的變更',
      model_source_changes_to_atum: '目前的 Mac 連線；雲端將使用 Atum 模型',
      local_tools_unavailable: '只安裝在這部 Mac 上的工具',
      local_files_unavailable: '只儲存在這部 Mac 上的檔案',
      local_browser_sessions_unavailable: '只儲存在這部 Mac 上的瀏覽器工作階段',
      conversation_overrides_cleared: '各個對話單獨選擇的模型'
    }
  }
}

export function agentHomeCopy(locale: string): AgentHomeWords {
  return Object.hasOwn(words, locale) ? words[locale as AgentHomeLocale] : words.en
}

/** A place in the owner's words: the Mac's name (and "this Mac"), or the cloud. Stands alone as a value. */
export function agentHomePlace(copy: AgentHomeWords, place: Place | Move['to']): string {
  if (place.kind === 'cloud') {
    return copy.cloudPlace
  }

  return place.thisMac ? copy.placeHere(place.name) : copy.place(place.name)
}

/** The place a move is going to, short enough for a status line. */
function destinationName(copy: AgentHomeWords, move: Move): string {
  return move.to.kind === 'cloud' ? copy.cloud : move.to.name || copy.anotherMac
}

/** The status line for a move, in the owner's steps. */
export function agentHomeStatus(copy: AgentHomeWords, move: Move): string {
  return copy.steps[move.step](destinationName(copy, move))
}

/** Why a move has not finished (or was called off), as one sentence; an unknown code is never shown. */
export function agentHomeIssue(copy: AgentHomeWords, issue: string, moving = true): string {
  if (Object.hasOwn(copy.issues, issue)) {
    return copy.issues[issue]!
  }

  return moving ? copy.issueFallback : copy.endedFallback
}
