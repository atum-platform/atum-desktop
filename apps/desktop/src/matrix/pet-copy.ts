import type { Locale } from '@/i18n'

import type { MatrixPetHatchProgress } from '../../shared/matrix-pet'

export const petCopy: Record<
  Locale,
  {
    title: string
    actions: string
    chatWith(name: string): string
    wave: string
    sit: string
    lounge: string
    change: string
    hide: string
    show: string
    hidden: string
    asleep: string
    settings: string
    chatInput(name: string): string
    send: string
    sendFailed: string
    thinking(name: string): string
    busy(name: string): string
    noProtons: string
    topUp: string
    missingPet: string
    closeChat: string
    /** The empty pet chat's one muted line. */
    listening(name: string): string
    /** Under a message the pet did not get. */
    notSent: string
    /** Sends a message that did not go through again. */
    tryAgain: string
    choose: string
    none: string
    visible: string
    size: string
    loading: string
    unavailable: string
    offline: string
    asset: string
    retry: string
    conflict: string
    save: string
    saved: string
    cache: string
    visit: string
    store: string
    acquire: string
    priceChanged: string
    refused: string
    uncertain: string
    recovering: string
    create: string
    describe: string
    choosePhoto: string
    photoChosen: string
    /** Under the photo control: what the photo is used for, and that it is not kept. */
    photoHint: string
    generate: string
    hatch: string
    draftFailed: string
    limit: string
    roundsLeft: (count: number) => string
    noRounds: (resetAt: string) => string
    visiting: string
    owned: string
    available: string
    cancel: string
    hatchPhase: Record<MatrixPetHatchProgress['phase'], string>
    empty: string
    protons: string
    hatchPrice: string
    hatchCredit: string
    recoveryQuarantined: string
    discardRecovery: string
    retryRecovery: string
  }
> = {
  en: {
    actions: 'Actions',
    chatWith: name => `Chat with ${name}`,
    wave: 'Wave',
    sit: 'Sit',
    lounge: 'Lounge',
    change: 'Change companion',
    hide: 'Hide',
    show: 'Show',
    hidden: 'Hidden',
    asleep: 'Asleep',
    settings: 'Settings',
    chatInput: name => `Say hi to ${name}`,
    send: 'Send',
    sendFailed: 'Message was not sent. Try again.',
    thinking: name => `${name} is thinking…`,
    busy: name => `${name} is dozing. Try again in a moment.`,
    noProtons: 'Out of Protons.',
    topUp: 'Top up',
    missingPet: 'This pet isn’t here anymore.',
    closeChat: 'Close',
    listening: name => `${name} is listening.`,
    notSent: 'Not sent.',
    tryAgain: 'Try again',
    title: 'Companion',
    choose: 'Choose for this agent',
    none: 'No companion',
    visible: 'Show companion',
    size: 'Size',
    loading: 'Loading companion…',
    unavailable: 'Companion settings were not saved. Refresh, then try again.',
    offline: 'Offline · showing your last saved choice.',
    asset: 'This companion is not available on this Mac yet. Your choice is saved.',
    retry: 'Refresh',
    conflict: 'The saved settings changed. Refresh before choosing again.',
    save: 'Save',
    saved: 'Saved for this agent',
    cache: 'Saved online, but unavailable offline on this Mac.',
    visit: 'Gigi’s visit needs a current connection.',
    store: 'Pet Store',
    acquire: 'Adopt',
    priceChanged: 'The price changed. Review the current offer before adopting.',
    refused: 'This purchase is not available for this account.',
    uncertain: 'Purchase is still being confirmed. Keep this window open and refresh.',
    recovering: 'Recovering your pet purchase…',
    create: 'Create a pet',
    describe: 'Describe your pet',
    choosePhoto: 'Use a photo of your pet',
    photoChosen: 'Photo selected',
    photoHint:
      'Atum copies your pet’s colours and markings from the photo. The photo goes only to Atum’s AI to draw the drafts. Atum doesn’t keep it, and it isn’t part of your pet.',
    generate: 'Generate drafts',
    hatch: 'Hatch selected draft',
    draftFailed: 'Pet drafts could not be generated. Try again.',
    limit: 'No hatch credit is available right now.',
    roundsLeft: count => (count === 1 ? '1 free design left today' : `${count} free designs left today`),
    noRounds: resetAt =>
      `Free pet designs are unavailable right now. Daily designs reset at ${resetAt}. You have not been charged.`,
    visiting: 'Visiting',
    owned: 'Owned',
    available: 'Available',
    cancel: 'Cancel',
    hatchPhase: {
      designing: 'Designing your pet…',
      rendering_previews: 'Drawing previews…',
      ready: 'Drafts ready',
      rendering: 'Drawing your pet…',
      validating: 'Checking your pet…',
      publishing: 'Saving your pet…',
      failed: 'Could not finish your pet'
    },
    empty: 'No pets available yet. Visit the Pet Store to adopt one.',
    protons: 'Protons',
    hatchPrice: 'Hatch price',
    hatchCredit: 'Hatch credit ready',
    recoveryQuarantined: 'Your saved pet recovery needs attention. Your companion choice is unchanged.',
    discardRecovery: 'Discard saved draft',
    retryRecovery: 'Resume pet recovery'
  },
  vi: {
    actions: 'Hành động',
    chatWith: name => `Trò chuyện với ${name}`,
    wave: 'Vẫy tay',
    sit: 'Ngồi',
    lounge: 'Nằm nghỉ',
    change: 'Đổi thú cưng',
    hide: 'Ẩn',
    show: 'Hiện',
    hidden: 'Đang ẩn',
    asleep: 'Đang ngủ',
    settings: 'Cài đặt',
    chatInput: name => `Chào ${name} nhé`,
    send: 'Gửi',
    sendFailed: 'Chưa gửi được tin nhắn. Thử lại.',
    thinking: name => `${name} đang nghĩ…`,
    busy: name => `${name} đang ngủ gật. Thử lại sau nhé.`,
    noProtons: 'Hết Proton rồi.',
    topUp: 'Nạp Proton',
    missingPet: 'Thú cưng này không còn ở đây nữa.',
    closeChat: 'Đóng',
    listening: name => `${name} đang lắng nghe.`,
    notSent: 'Chưa gửi được.',
    tryAgain: 'Thử lại',
    title: 'Thú cưng',
    choose: 'Chọn cho trợ lý này',
    none: 'Không dùng thú cưng',
    visible: 'Hiện thú cưng',
    size: 'Kích thước',
    loading: 'Đang tải thú cưng…',
    unavailable: 'Chưa lưu được cài đặt thú cưng. Hãy làm mới rồi thử lại.',
    offline: 'Ngoại tuyến · hiển thị lựa chọn đã lưu gần nhất.',
    asset: 'Thú cưng này chưa dùng được trên máy Mac này. Lựa chọn của bạn vẫn được lưu.',
    retry: 'Làm mới',
    conflict: 'Cài đặt đã thay đổi. Hãy làm mới trước khi chọn lại.',
    save: 'Lưu',
    saved: 'Đã lưu cho trợ lý này',
    cache: 'Đã lưu trực tuyến nhưng chưa dùng được ngoại tuyến trên máy Mac này.',
    visit: 'Chuyến thăm của Gigi cần kết nối hiện tại.',
    store: 'Cửa hàng thú cưng',
    acquire: 'Nhận nuôi',
    priceChanged: 'Giá đã thay đổi. Hãy xem lại ưu đãi hiện tại trước khi nhận nuôi.',
    refused: 'Không thể mua cho tài khoản này.',
    uncertain: 'Giao dịch vẫn đang được xác nhận. Hãy giữ cửa sổ này mở và làm mới.',
    recovering: 'Đang khôi phục giao dịch thú cưng…',
    create: 'Tạo thú cưng',
    describe: 'Mô tả thú cưng',
    choosePhoto: 'Dùng ảnh thú cưng của bạn',
    photoChosen: 'Đã chọn ảnh',
    photoHint:
      'Atum lấy màu lông và hoa văn của bé từ ảnh. Ảnh chỉ được gửi tới AI của Atum để vẽ bản nháp. Atum không giữ ảnh, và ảnh không nằm trong thú cưng của bạn.',
    generate: 'Tạo bản nháp',
    hatch: 'Ấp bản đã chọn',
    draftFailed: 'Không tạo được bản nháp thú cưng. Hãy thử lại.',
    limit: 'Hiện chưa có lượt ấp nào.',
    roundsLeft: count => `Còn ${count} lượt thiết kế miễn phí hôm nay`,
    noRounds: resetAt =>
      `Hiện chưa thể thiết kế thú cưng miễn phí. Lượt thiết kế mỗi ngày được làm mới lúc ${resetAt}. Bạn chưa bị trừ Proton nào.`,
    visiting: 'Đang ghé thăm',
    owned: 'Đã có',
    available: 'Có thể nhận nuôi',
    cancel: 'Hủy',
    hatchPhase: {
      designing: 'Đang thiết kế thú cưng…',
      rendering_previews: 'Đang vẽ bản xem trước…',
      ready: 'Bản nháp đã sẵn sàng',
      rendering: 'Đang vẽ thú cưng…',
      validating: 'Đang kiểm tra thú cưng…',
      publishing: 'Đang lưu thú cưng…',
      failed: 'Chưa hoàn thành được thú cưng'
    },
    empty: 'Chưa có thú cưng. Hãy vào Cửa hàng thú cưng để nhận nuôi.',
    protons: 'Proton',
    hatchPrice: 'Giá ấp',
    hatchCredit: 'Đã có lượt ấp',
    recoveryQuarantined: 'Bản khôi phục thú cưng đã lưu cần được chú ý. Lựa chọn thú cưng của bạn không thay đổi.',
    discardRecovery: 'Bỏ bản nháp đã lưu',
    retryRecovery: 'Tiếp tục khôi phục thú cưng'
  },
  ja: {
    actions: 'アクション',
    chatWith: name => `${name}とチャット`,
    wave: '手を振る',
    sit: '座る',
    lounge: 'くつろぐ',
    change: 'ペットを変更',
    hide: '非表示',
    show: '表示',
    hidden: '非表示中',
    asleep: '睡眠中',
    settings: '設定',
    chatInput: name => `${name}に話しかけてみて`,
    send: '送信',
    sendFailed: '送信できませんでした。再試行してください。',
    thinking: name => `${name}が考え中…`,
    busy: name => `${name}はうとうとしています。少ししてからもう一度。`,
    noProtons: 'Proton が足りません。',
    topUp: 'チャージ',
    missingPet: 'このペットはもういません。',
    closeChat: '閉じる',
    listening: name => `${name}が聞いています。`,
    notSent: '送信できませんでした。',
    tryAgain: 'もう一度',
    title: 'ペット',
    choose: 'このエージェントのペット',
    none: 'ペットなし',
    visible: 'ペットを表示',
    size: 'サイズ',
    loading: 'ペットを読み込み中…',
    unavailable: 'ペットの設定は保存されませんでした。更新してから、もう一度お試しください。',
    offline: 'オフライン · 最後に保存した選択を表示しています。',
    asset: 'このペットはこの Mac ではまだ利用できません。選択は保存されています。',
    retry: '更新',
    conflict: '保存済みの設定が変更されました。更新してから選択してください。',
    save: '保存',
    saved: 'このエージェント用に保存しました',
    cache: 'オンラインで保存しましたが、この Mac ではオフラインで利用できません。',
    visit: 'Gigi の訪問には現在の接続が必要です。',
    store: 'ペットストア',
    acquire: '迎える',
    priceChanged: '価格が変わりました。迎える前に現在のオファーを確認してください。',
    refused: 'このアカウントでは購入できません。',
    uncertain: '購入を確認中です。このウィンドウを開いたまま更新してください。',
    recovering: 'ペットの購入を復元中です…',
    create: 'ペットを作る',
    describe: 'ペットを説明',
    choosePhoto: 'ペットの写真を使う',
    photoChosen: '写真を選択しました',
    photoHint:
      'Atum は写真からペットの毛色と模様を写し取ります。写真は下書きを描くために Atum の AI に送られるだけです。Atum は写真を保存せず、ペットにも含まれません。',
    generate: '下書きを作る',
    hatch: '選んだ下書きを孵化',
    draftFailed: 'ペットの下書きを作成できませんでした。もう一度試してください。',
    limit: '現在利用できる孵化クレジットはありません。',
    roundsLeft: count => `本日の無料デザインは残り${count}回`,
    noRounds: resetAt =>
      `現在、無料のペットデザインは利用できません。1日の回数は${resetAt}にリセットされます。料金は発生していません。`,
    visiting: '訪問中',
    owned: 'お迎え済み',
    available: 'お迎えできます',
    cancel: 'キャンセル',
    hatchPhase: {
      designing: 'ペットをデザイン中…',
      rendering_previews: 'プレビューを描画中…',
      ready: '下書きの準備ができました',
      rendering: 'ペットを描画中…',
      validating: 'ペットを確認中…',
      publishing: 'ペットを保存中…',
      failed: 'ペットを完成できませんでした'
    },
    empty: 'まだペットはいません。ペットストアで迎えてください。',
    protons: 'Proton',
    hatchPrice: '孵化価格',
    hatchCredit: '孵化クレジットを利用できます',
    recoveryQuarantined: '保存済みのペット復元には対応が必要です。現在の選択は変わりません。',
    discardRecovery: '保存済みの下書きを破棄',
    retryRecovery: 'ペットの復元を再開'
  },
  zh: {
    actions: '操作',
    chatWith: name => `与 ${name}聊天`,
    wave: '挥手',
    sit: '坐下',
    lounge: '休息',
    change: '更换宠物',
    hide: '隐藏',
    show: '显示',
    hidden: '已隐藏',
    asleep: '睡眠中',
    settings: '设置',
    chatInput: name => `跟${name}打个招呼`,
    send: '发送',
    sendFailed: '消息未发送，请重试。',
    thinking: name => `${name}正在想…`,
    busy: name => `${name}在打盹，稍后再试。`,
    noProtons: 'Proton 不足。',
    topUp: '充值',
    missingPet: '这只宠物已经不在了。',
    closeChat: '关闭',
    listening: name => `${name}在听呢。`,
    notSent: '未发送。',
    tryAgain: '重试',
    title: '宠物',
    choose: '为此智能体选择',
    none: '不使用宠物',
    visible: '显示宠物',
    size: '大小',
    loading: '正在加载宠物…',
    unavailable: '宠物设置未保存。请刷新后重试。',
    offline: '离线 · 显示最近保存的选择。',
    asset: '此宠物暂时无法在这台 Mac 上使用，您的选择已保存。',
    retry: '刷新',
    conflict: '已保存的设置有变化，请刷新后重新选择。',
    save: '保存',
    saved: '已为此智能体保存',
    cache: '已在线保存，但这台 Mac 暂时无法离线使用。',
    visit: 'Gigi 的访问需要当前连接。',
    store: '宠物商店',
    acquire: '领养',
    priceChanged: '价格已变更。领养前请查看当前报价。',
    refused: '此账户无法购买。',
    uncertain: '正在确认购买，请保持此窗口开启并刷新。',
    recovering: '正在恢复宠物购买…',
    create: '创建宠物',
    describe: '描述宠物',
    choosePhoto: '使用你的宠物照片',
    photoChosen: '已选择照片',
    photoHint:
      'Atum 会照着照片里宠物的毛色和花纹来画。照片只会发送给 Atum 的 AI 用来画草稿。Atum 不会保存照片，照片也不会成为你宠物的一部分。',
    generate: '生成草稿',
    hatch: '孵化所选草稿',
    draftFailed: '无法生成宠物草稿，请重试。',
    limit: '目前没有可用孵化额度。',
    roundsLeft: count => `今天还剩 ${count} 次免费设计`,
    noRounds: resetAt => `暂时无法免费设计宠物。每日次数将在 ${resetAt} 重置。未产生任何费用。`,
    visiting: '访问中',
    owned: '已拥有',
    available: '可以领养',
    cancel: '取消',
    hatchPhase: {
      designing: '正在设计宠物…',
      rendering_previews: '正在绘制预览…',
      ready: '草稿已就绪',
      rendering: '正在绘制宠物…',
      validating: '正在检查宠物…',
      publishing: '正在保存宠物…',
      failed: '未能完成宠物'
    },
    empty: '还没有宠物。请前往宠物商店领养。',
    protons: 'Proton',
    hatchPrice: '孵化价格',
    hatchCredit: '孵化额度已就绪',
    recoveryQuarantined: '已保存的宠物恢复需要处理。当前宠物选择不会改变。',
    discardRecovery: '丢弃已保存的草稿',
    retryRecovery: '继续恢复宠物'
  },
  'zh-hant': {
    actions: '操作',
    chatWith: name => `與 ${name}聊天`,
    wave: '揮手',
    sit: '坐下',
    lounge: '休息',
    change: '更換寵物',
    hide: '隱藏',
    show: '顯示',
    hidden: '已隱藏',
    asleep: '睡眠中',
    settings: '設定',
    chatInput: name => `跟${name}打個招呼`,
    send: '傳送',
    sendFailed: '訊息未傳送，請重試。',
    thinking: name => `${name}正在想…`,
    busy: name => `${name}在打盹，稍後再試。`,
    noProtons: 'Proton 不足。',
    topUp: '儲值',
    missingPet: '這隻寵物已經不在了。',
    closeChat: '關閉',
    listening: name => `${name}在聽呢。`,
    notSent: '未傳送。',
    tryAgain: '重試',
    title: '寵物',
    choose: '為此智慧代理選擇',
    none: '不使用寵物',
    visible: '顯示寵物',
    size: '大小',
    loading: '正在載入寵物…',
    unavailable: '寵物設定未儲存。請重新整理後再試一次。',
    offline: '離線 · 顯示最近儲存的選擇。',
    asset: '此寵物暫時無法在這台 Mac 上使用，您的選擇已儲存。',
    retry: '重新整理',
    conflict: '已儲存的設定有變更，請重新整理後再選擇。',
    save: '儲存',
    saved: '已為此智慧代理儲存',
    cache: '已在線上儲存，但這台 Mac 暫時無法離線使用。',
    visit: 'Gigi 的造訪需要目前的連線。',
    store: '寵物商店',
    acquire: '領養',
    priceChanged: '價格已變更。領養前請查看目前的方案。',
    refused: '此帳戶無法購買。',
    uncertain: '正在確認購買，請保持此視窗開啟並重新整理。',
    recovering: '正在復原寵物購買…',
    create: '建立寵物',
    describe: '描述寵物',
    choosePhoto: '使用你的寵物照片',
    photoChosen: '已選擇照片',
    photoHint:
      'Atum 會照著照片裡寵物的毛色和花紋來畫。照片只會傳送給 Atum 的 AI 用來畫草稿。Atum 不會儲存照片，照片也不會成為你寵物的一部分。',
    generate: '產生草稿',
    hatch: '孵化選取草稿',
    draftFailed: '無法產生寵物草稿，請再試一次。',
    limit: '目前沒有可用的孵化額度。',
    roundsLeft: count => `今天還剩 ${count} 次免費設計`,
    noRounds: resetAt => `暫時無法免費設計寵物。每日次數將於 ${resetAt} 重設。未產生任何費用。`,
    visiting: '造訪中',
    owned: '已擁有',
    available: '可以領養',
    cancel: '取消',
    hatchPhase: {
      designing: '正在設計寵物…',
      rendering_previews: '正在繪製預覽…',
      ready: '草稿已就緒',
      rendering: '正在繪製寵物…',
      validating: '正在檢查寵物…',
      publishing: '正在儲存寵物…',
      failed: '未能完成寵物'
    },
    empty: '尚無寵物。請前往寵物商店領養。',
    protons: 'Proton',
    hatchPrice: '孵化價格',
    hatchCredit: '孵化額度已就緒',
    recoveryQuarantined: '已儲存的寵物復原需要處理。目前的寵物選擇不會變更。',
    discardRecovery: '捨棄已儲存的草稿',
    retryRecovery: '繼續復原寵物'
  }
}
