/**
 * The status notices carried by a cloud assistant's chat (atum.agent-home/1 status outbox: every
 * outcome publishes something, so a turn never ends in silence). The cloud controller writes a
 * safe fallback into the message body and puts the code under `io.atum.result.status`, so an app
 * can present localized system status instead of treating the fallback as the assistant's words.
 *
 * Product copy: system failures are neutral; other assistant-authored outcomes use one plain
 * notice where one will do. The app is Atum, files are in Atum Drive; no raw IDs, no runtime
 * names. Vietnamese is the default; every locale changes together.
 */
import type { DesktopLocale } from './desktop-locale'
import { matrixDeviceWaitCopy } from './matrix-status-line-copy'

export const MATRIX_AGENT_STATUS_CODES = [
  'stopped', 'failed', 'deadline', 'couldnt_confirm', 'unfunded', 'trial_expired', 'queue_full',
  'memory_not_saved', 'couldnt_verify_mac', 'resuming_on_device', 'attachment_unsupported', 'thread_unsupported',
  'saved_to_drive', 'saved_as_copy', 'save_unconfirmed', 'reply_unreadable',
  'turn_limit', 'reminder_missed', 'stuck', 'access_final', 'daily_cap', 'daily_cap_warning',
  // agent-turns/1.5 A14: the persistent notice that a chosen Mac is off or locked.
  'device_unreachable'
] as const
export type MatrixAgentStatusCode = (typeof MATRIX_AGENT_STATUS_CODES)[number]

export function isMatrixAgentStatusCode(value: unknown): value is MatrixAgentStatusCode {
  return (MATRIX_AGENT_STATUS_CODES as readonly unknown[]).includes(value)
}

/** The codes that ride beside a real answer's text as an appended warning (agent-turns/1.5 A14). */
export const MATRIX_AGENT_ANSWER_WARNING_CODES = [
  'memory_not_saved', 'saved_to_drive', 'saved_as_copy', 'save_unconfirmed'
] as const satisfies readonly MatrixAgentStatusCode[]
export type MatrixAgentAnswerWarningCode = (typeof MATRIX_AGENT_ANSWER_WARNING_CODES)[number]

/** What a status sentence interpolates (agent-turns/1.5 `result_details`): nothing else, ever. */
export interface MatrixAgentStatusDetails {
  /** Owner-visible Mac names: the Macs that may have run it, the one a turn resumes on or the one that is away. */
  devices?: string[]
  /** The owner's own name for a scheduled routine that did not finish. */
  routine_title?: string
  attachment?: 'unsupported' | 'unreadable'
  /** The agent carries on when the Mac is back. */
  resume?: boolean
}

/**
 * The codes of a notice that closes a message without an answer: the turn failed, was stopped, ran
 * out of time or allowance, or was refused. Such a line is the agent speaking about a message, not
 * a turn, so a reader of the room can read past it. The rest of the list is not that: the answer
 * codes ride beside a real answer's text (`saved_to_drive`, `saved_as_copy`, `save_unconfirmed`,
 * `memory_not_saved`: the cloud controller's ANSWER_STATUS_CODES) and `resuming_on_device` only
 * says an answer is coming. Reading past those would drop an answer or progress from the room.
 */
export const MATRIX_AGENT_CLOSED_STATUS_CODES = [
  'stopped', 'failed', 'deadline', 'couldnt_confirm', 'unfunded', 'trial_expired', 'queue_full',
  'couldnt_verify_mac', 'attachment_unsupported', 'thread_unsupported', 'reply_unreadable', 'daily_cap'
] as const satisfies readonly MatrixAgentStatusCode[]
export type MatrixAgentClosedStatusCode = (typeof MATRIX_AGENT_CLOSED_STATUS_CODES)[number]

export function isMatrixAgentClosedStatusCode(value: unknown): value is MatrixAgentClosedStatusCode {
  return (MATRIX_AGENT_CLOSED_STATUS_CODES as readonly unknown[]).includes(value)
}

interface StatusCopy {
  stopped: string
  failed: string
  deadline: string
  couldntConfirm: string
  /** Appended to `couldntConfirm` when the controller knows which computers may have been used. */
  mayHaveRun: (devices: string) => string
  unfunded: string
  trialExpired: string
  /** One consumer-owned truthful remedy, appended to every access reason. */
  accessRemedy: string
  turnLimit: string
  reminderMissed: string
  stuck: string
  accessFinal: string
  queueFull: string
  memoryNotSaved: string
  couldntVerifyMac: string
  /** The turn moved from the cloud to a Mac: the cloud work stopped and it carries on there. */
  resumingOnDevice: (device: string) => string
  attachmentUnsupported: string
  /** The attachment was refused on a controller that does read attachments (too large, too many, upload failed). */
  attachmentUnreadable: string
  replyUnreadable: string
  threadUnsupported: string
  savedToDrive: string
  savedAsCopy: string
  saveUnconfirmed: string
  /** The 100% daily-cap refusal: plain state, never a spend, balance or cap number. */
  dailyCap: string
  /** The one quiet 80% line, in the agent's main conversation: plain state, no numbers. */
  dailyCapWarning: string
  /** A scheduled routine that did not finish because the server had trouble; quotes the owner's own name for it. */
  routineFailed: (title: string) => string
  /** The chosen Mac is off or locked and the agent carries on when it is back. */
  deviceAway: (name: string) => string
  /** The chosen Mac is off or locked; the person opens it or asks for the cloud. */
  deviceAwayNow: (name: string) => string
}

export const matrixAgentStatusCopy: Record<DesktopLocale, StatusCopy> = {
  vi: {
    stopped: 'Đã dừng.',
    failed: 'Atum chưa hoàn tất yêu cầu này. Hãy thử lại.',
    deadline: 'Việc này mất quá lâu nên mình đã dừng. Bạn thử chia nhỏ yêu cầu nhé.',
    couldntConfirm: 'Việc này bị ngắt giữa chừng nên có thể mới làm được một phần. Mình không tự làm lại để khỏi làm hai lần. Bạn nhắn “kiểm tra lại” để mình xem đã xong đến đâu nhé.',
    mayHaveRun: devices => ` Phần đã làm có thể nằm trên ${devices}.`,
    unfunded: 'Mình chưa trả lời được vì tài khoản hiện không còn lượt dùng Atum. Các việc định kỳ cũng tạm dừng.',
    trialExpired: 'Mình chưa trả lời được vì thời gian dùng thử Atum đã hết. Các việc định kỳ cũng tạm dừng.',
    accessRemedy: 'Nhắn đội ngũ Atum để được gia hạn hoặc mở lại nhé.',
    turnLimit: 'Câu trả lời này hơi dài nên mình tạm dừng ở đây. Nhắn “tiếp tục” để mình viết tiếp nhé.',
    reminderMissed: 'Mình bị lỡ nhắc hẹn này vì lúc đó chưa phản hồi được. Bạn có muốn mình làm ngay bây giờ không?',
    stuck: 'Mình đang gặp chút trục trặc nên chưa trả lời được. Tin nhắn của bạn vẫn còn đây, mình sẽ trả lời ngay khi khắc phục xong. Nếu chờ lâu quá, bạn nhắn đội ngũ Atum nhé.',
    accessFinal: 'Mình tạm thời chưa trả lời được trong cuộc trò chuyện này cho đến khi tài khoản được mở lại.',
    queueFull: 'Đang có quá nhiều yêu cầu chờ nên mình chưa nhận thêm. Bạn thử lại sau ít phút nhé.',
    memoryNotSaved: '(Mình chưa lưu được điều vừa học từ lần này.)',
    couldntVerifyMac: 'Mình không xác minh được máy Mac đã gửi tin này nên chưa làm gì cả.',
    resumingOnDevice: device => `Mình đã dừng việc trên đám mây và đang làm tiếp trên ${device}.`,
    attachmentUnsupported: 'Mình chưa mở được tệp đính kèm trong chat. Bạn dán nội dung hoặc lưu vào Atum Drive nhé.',
    attachmentUnreadable: 'Mình chưa mở được tệp đính kèm này. Có thể tệp quá lớn, lần tải lên chưa xong, hoặc có quá nhiều tệp trong một lượt. Bạn thử lại với tối đa hai tệp, mỗi tệp không quá 20 MB nhé.',
    replyUnreadable: 'Mình không đọc được tin nhắn bạn đang trả lời. Bạn gửi lại nội dung đó nhé.',
    threadUnsupported: 'Mình không trả lời trong chuỗi tin nhắn. Bạn gửi thành tin nhắn mới nhé.',
    savedToDrive: 'Đã lưu vào Atum Drive.',
    savedAsCopy: 'Tệp đã thay đổi trong lúc mình làm, nên mình lưu thêm một bản bên cạnh.',
    saveUnconfirmed: 'Việc lưu tệp bị gián đoạn nên chưa rõ tệp đã vào Atum Drive chưa. Mình không lưu lại lần nữa để khỏi trùng; bạn mở Atum Drive xem giúp mình nhé.',
    dailyCap: 'Hôm nay mình đã chạm hạn mức sử dụng nên chưa trả lời tiếp được. Mai mình sẽ trả lời tiếp, hoặc bạn mở thẻ trợ lý để nâng hạn mức nhé.',
    dailyCapWarning: 'Hôm nay mình đã dùng gần hết hạn mức. Mình vẫn chạy bình thường, chỉ báo bạn biết thôi.',
    routineFailed: title => `Việc “${title}” lần này chưa làm xong vì Atum gặp trục trặc ở phía máy chủ, không phải do bạn. Nếu việc này lặp lại theo lịch, lần tới mình sẽ chạy lại như bình thường. Bạn muốn mình làm ngay thì cứ nhắn nhé.`,
    deviceAway: name => `${name} đang tắt hoặc đã khoá. Mình sẽ làm tiếp khi máy mở lại, hoặc bạn nhắn “làm trên đám mây” để mình làm luôn.`,
    deviceAwayNow: name => `${name} đang tắt hoặc đã khoá. Bạn mở máy lên, hoặc nhắn “làm trên đám mây” để mình làm luôn.`
  },
  en: {
    stopped: 'Stopped.',
    failed: 'Atum couldn’t complete this request. Please try again.',
    deadline: 'This took too long, so I stopped. Try asking for a smaller piece.',
    couldntConfirm: 'This was cut off partway, so only part of it may be done. I won’t redo it on my own, so it doesn’t happen twice. Say “check again” and I’ll look at how far it got.',
    mayHaveRun: devices => ` What was done may be on ${devices}.`,
    unfunded: 'I can’t answer because your account has no Atum allowance left right now. Scheduled tasks are paused too.',
    trialExpired: 'I can’t answer because your Atum trial has ended. Scheduled tasks are paused too.',
    accessRemedy: 'Message the Atum team to extend it.',
    turnLimit: 'I used the full limit for one answer. Send “continue” and I’ll pick up where I stopped.',
    reminderMissed: 'I missed this reminder because I couldn’t run then. Would you like me to do it now?',
    stuck: 'Something is preventing me from answering right now. Your message is still saved, and I’ll answer when this is fixed. If it takes too long, message the Atum team.',
    accessFinal: 'I won’t answer in this chat until the account is reopened.',
    queueFull: 'Too many requests are waiting, so I didn’t take this one. Try again in a few minutes.',
    memoryNotSaved: '(I couldn’t save what I learned this time.)',
    couldntVerifyMac: 'I couldn’t verify which Mac sent this, so I didn’t do anything.',
    resumingOnDevice: device => `I’ve stopped working in the cloud and I’m continuing on ${device}.`,
    attachmentUnsupported: 'I can’t open attachments in chat yet. Paste the text, or save the file to Atum Drive.',
    attachmentUnreadable: 'I couldn’t open that attachment. It may be too large, the upload didn’t finish, or there were too many files at once. Try again with up to two files of 20 MB each.',
    replyUnreadable: 'I can’t read the message you replied to. Please send its text again.',
    threadUnsupported: 'I don’t answer inside threads. Send it as a new message.',
    savedToDrive: 'Saved to Atum Drive.',
    savedAsCopy: 'The file changed while I worked, so I saved a copy next to it.',
    saveUnconfirmed: 'The save was interrupted, so it’s unclear whether the file reached Atum Drive. I won’t save it again so there’s no duplicate; please take a look in Atum Drive.',
    dailyCap: 'I’ve reached today’s usage limit, so I can’t answer this one right now. I’ll pick it up again tomorrow, or you can raise the limit from the assistant card.',
    dailyCapWarning: 'I’m close to today’s usage limit. I’ll keep going as usual; this is just a heads-up.',
    routineFailed: title => `Your routine “${title}” didn’t finish this time because Atum had a problem on its servers. It wasn’t anything you did. If it repeats on a schedule, I’ll run it as usual next time. Message me if you’d like me to do it now.`,
    deviceAway: name => `${name} is off or locked. I’ll carry on when it’s back, or tell me “do it in the cloud” and I’ll do it right away.`,
    deviceAwayNow: name => `${name} is off or locked. Open it, or tell me “do it in the cloud” and I’ll do it right away.`
  },
  ja: {
    stopped: '停止しました。',
    failed: 'Atum はこのリクエストを完了できませんでした。もう一度お試しください。',
    deadline: '時間がかかりすぎたため停止しました。依頼を小さく分けてお試しください。',
    couldntConfirm: '途中で中断されたため、一部しか終わっていない可能性があります。二重に実行しないよう、自動ではやり直しません。「もう一度確認して」と送っていただければ、どこまで進んだか確認します。',
    mayHaveRun: devices => `実行済みの分は ${devices} にある可能性があります。`,
    unfunded: 'このアカウントには現在 Atum の利用枠が残っていないため、返信できません。定期タスクも停止しています。',
    trialExpired: 'Atum の無料体験が終了したため、返信できません。定期タスクも停止しています。',
    accessRemedy: '延長するには Atum チームにご連絡ください。',
    turnLimit: '1 回の回答で使える上限に達しました。「続けて」と送ると、止まったところから再開します。',
    reminderMissed: 'その時に実行できなかったため、このリマインダーの時刻を過ぎました。今すぐ実行しますか？',
    stuck: '問題が発生しているため、今は返信できません。メッセージは保持され、修復後に返信します。長引く場合は Atum チームにご連絡ください。',
    accessFinal: 'アカウントが再開されるまで、このチャットには返信しません。',
    queueFull: '待機中の依頼が多すぎるため、受け付けませんでした。数分後にもう一度お試しください。',
    memoryNotSaved: '（今回覚えたことは保存できませんでした。）',
    couldntVerifyMac: 'この依頼を送った Mac を確認できなかったため、何も実行していません。',
    resumingOnDevice: device => `クラウドでの作業を止めて、${device} で続けています。`,
    attachmentUnsupported: 'チャットの添付ファイルはまだ開けません。内容を貼り付けるか、Atum Drive に保存してください。',
    attachmentUnreadable: 'この添付ファイルを開けませんでした。ファイルが大きすぎるか、アップロードが完了していないか、一度に多すぎる可能性があります。20 MB 以下のファイルを 2 件まででもう一度お試しください。',
    replyUnreadable: '返信先のメッセージを読めません。内容をもう一度送ってください。',
    threadUnsupported: 'スレッド内には返信しません。新しいメッセージとして送ってください。',
    savedToDrive: 'Atum Drive に保存しました。',
    savedAsCopy: '作業中にファイルが変更されたため、隣にコピーを保存しました。',
    saveUnconfirmed: '保存が中断されたため、ファイルが Atum Drive に入ったかどうか分かりません。重複しないよう再保存はしないので、Atum Drive をご確認ください。',
    dailyCap: '今日の利用上限に達したため、今回は返信できません。明日また続きを返信します。上限はアシスタントカードから引き上げられます。',
    dailyCapWarning: '今日の利用上限に近づいています。いつもどおり続けます。これはお知らせだけです。',
    routineFailed: title => `「${title}」は、Atum のサーバー側で問題が起きたため、今回は完了できませんでした。あなたの操作が原因ではありません。繰り返し予定のタスクなら、次回は通常どおり実行します。今すぐ実行する場合はメッセージを送ってください。`,
    deviceAway: name => `${name} は電源が切れているか、ロックされています。戻り次第続けます。すぐに進めたいときは「クラウドでやって」と送ってください。`,
    deviceAwayNow: name => `${name} は電源が切れているか、ロックされています。開くか、「クラウドでやって」と送ってください。すぐに進めます。`
  },
  zh: {
    stopped: '已停止。',
    failed: 'Atum 未能完成此请求。请再试一次。',
    deadline: '这件事用时太长，我已停止。可以把请求拆小一些再试。',
    couldntConfirm: '这件事中途被打断，可能只完成了一部分。为避免重复执行，我不会自动重做。发送“再检查一下”，我会看看做到哪一步了。',
    mayHaveRun: devices => `已完成的部分可能在 ${devices} 上。`,
    unfunded: '你的账户目前没有可用的 Atum 额度，我暂时无法回复，定时任务也已暂停。',
    trialExpired: '你的 Atum 试用已结束，我暂时无法回复，定时任务也已暂停。',
    accessRemedy: '请联系 Atum 团队延长。',
    turnLimit: '这次回答已用完单次限额。发送“继续”，我会从中断处接着处理。',
    reminderMissed: '当时无法运行，所以错过了这条提醒。需要我现在处理吗？',
    stuck: '目前出现故障，我暂时无法回复。你的消息仍会保留，修复后我会回复。如果等待太久，请联系 Atum 团队。',
    accessFinal: '在账户重新开通前，我不会在这个聊天中回复。',
    queueFull: '等待中的请求太多，这次没有接收。请几分钟后再试。',
    memoryNotSaved: '（这次学到的内容没能保存。）',
    couldntVerifyMac: '无法确认是哪台 Mac 发送了这条消息，所以没有执行任何操作。',
    resumingOnDevice: device => `我已停止云端的工作，正在 ${device} 上继续。`,
    attachmentUnsupported: '暂时还不能打开聊天里的附件。请粘贴文字内容，或把文件存到 Atum Drive。',
    attachmentUnreadable: '没能打开这个附件。文件可能太大、上传没有完成，或者一次放了太多文件。请用不超过 20 MB 的文件、最多两个再试一次。',
    replyUnreadable: '回复的消息无法读取。请重新发送消息内容。',
    threadUnsupported: '我不在话题串里回复。请作为新消息发送。',
    savedToDrive: '已保存到 Atum Drive。',
    savedAsCopy: '我处理期间文件有变动，所以在旁边另存了一份。',
    saveUnconfirmed: '保存被中断了，不清楚文件是否已进入 Atum Drive。为避免重复，我不会再保存一次，请到 Atum Drive 里看看。',
    dailyCap: '今天的用量已达上限，这次无法继续回复。明天我会接着回复，你也可以在助手卡片中提高上限。',
    dailyCapWarning: '今天的用量已接近上限。我会照常继续，这只是提醒。',
    routineFailed: title => `“${title}”这次没有完成，是因为 Atum 的服务器出了问题，不是你的原因。如果它按计划重复，下次我会照常运行。想现在就做的话，直接告诉我。`,
    deviceAway: name => `${name} 已关机或已锁定。它恢复后我会接着做；也可以发送“在云端做”，我马上处理。`,
    deviceAwayNow: name => `${name} 已关机或已锁定。请打开它，或发送“在云端做”，我马上处理。`
  },
  'zh-hant': {
    stopped: '已停止。',
    failed: 'Atum 未能完成此要求。請再試一次。',
    deadline: '這件事花太久了，我已停止。可以把請求拆小一些再試。',
    couldntConfirm: '這件事中途被打斷，可能只完成了一部分。為避免重複執行，我不會自動重做。傳送「再檢查一下」，我會看看做到哪一步了。',
    mayHaveRun: devices => `已完成的部分可能在 ${devices} 上。`,
    unfunded: '你的帳號目前沒有可用的 Atum 額度，我暫時無法回覆，排程工作也已暫停。',
    trialExpired: '你的 Atum 試用已結束，我暫時無法回覆，排程工作也已暫停。',
    accessRemedy: '請聯絡 Atum 團隊延長。',
    turnLimit: '這次回答已用完單次限額。傳送「繼續」，我會從中斷處接著處理。',
    reminderMissed: '當時無法執行，所以錯過了這則提醒。需要我現在處理嗎？',
    stuck: '目前發生故障，我暫時無法回覆。你的訊息仍會保留，修復後我會回覆。如果等候太久，請聯絡 Atum 團隊。',
    accessFinal: '在帳號重新開通前，我不會在這個聊天中回覆。',
    queueFull: '等待中的請求太多，這次沒有接收。請幾分鐘後再試。',
    memoryNotSaved: '（這次學到的內容沒能儲存。）',
    couldntVerifyMac: '無法確認是哪台 Mac 傳送了這則訊息，所以沒有執行任何操作。',
    resumingOnDevice: device => `我已停止雲端的工作，正在 ${device} 上繼續。`,
    attachmentUnsupported: '暫時還不能開啟聊天裡的附件。請貼上文字內容，或把檔案存到 Atum Drive。',
    attachmentUnreadable: '沒能開啟這個附件。檔案可能太大、上傳沒有完成，或者一次放了太多檔案。請用不超過 20 MB 的檔案、最多兩個再試一次。',
    replyUnreadable: '回覆的訊息無法讀取。請重新傳送訊息內容。',
    threadUnsupported: '我不在討論串裡回覆。請以新訊息傳送。',
    savedToDrive: '已儲存到 Atum Drive。',
    savedAsCopy: '我處理期間檔案有變動，所以在旁邊另存了一份。',
    saveUnconfirmed: '儲存被中斷了，不清楚檔案是否已進入 Atum Drive。為避免重複，我不會再儲存一次，請到 Atum Drive 裡看看。',
    dailyCap: '今天的用量已達上限，這次無法繼續回覆。明天我會接著回覆，你也可以在助手卡片中提高上限。',
    dailyCapWarning: '今天的用量已接近上限。我會照常繼續，這只是提醒。',
    routineFailed: title => `「${title}」這次沒有完成，是因為 Atum 的伺服器發生問題，不是你的原因。如果它依排程重複，下次我會照常執行。想現在就做的話，直接告訴我。`,
    deviceAway: name => `${name} 已關機或已鎖定。它恢復後我會接著做；也可以傳送「在雲端做」，我馬上處理。`,
    deviceAwayNow: name => `${name} 已關機或已鎖定。請打開它，或傳送「在雲端做」，我馬上處理。`
  }
}

/** Internal list formatting; exported copy formatters accept scalar native placeholders. */
function deviceList(names: string[], locale: DesktopLocale): string {
  if (locale === 'ja' || locale === 'zh' || locale === 'zh-hant') {
    return names.join('、')
  }

  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ${locale === 'en' ? 'and' : 'và'} ${names.at(-1)}`
}

/**
 * The one line said when a turn that may have acted was cut off and the assistant goes to look at what
 * it did (the check turn, `matrix-turn-effects.ts`). Plain chat text, not a status code: the answer that
 * follows is the real message. Said at most once per interrupted message.
 */
const checkingLine: Record<DesktopLocale, string> = {
  vi: 'Mình bị ngắt giữa chừng, để mình xem lại đã làm tới đâu…',
  en: 'I got cut off partway. Let me check how far I got…',
  ja: '途中で中断されました。どこまで進んだか確認します…',
  zh: '中途被打断了，我来看看做到哪一步了…',
  'zh-hant': '中途被打斷了，我來看看做到哪一步了…'
}

export function matrixCheckingLine(locale: DesktopLocale): string {
  return checkingLine[locale] ?? checkingLine.vi
}

/** The one consumer-owned access remedy, shared by chat notices and the later desktop band. */
export function matrixAgentAccessRemedy(locale: DesktopLocale): string {
  return (matrixAgentStatusCopy[locale] ?? matrixAgentStatusCopy.vi).accessRemedy
}

/** The sentence for one status notice. */
export function matrixAgentStatusText(
  code: MatrixAgentStatusCode,
  locale: DesktopLocale,
  details: MatrixAgentStatusDetails = {}
): string {
  const copy = matrixAgentStatusCopy[locale] ?? matrixAgentStatusCopy.vi
  const devices = (details.devices ?? []).filter(name => name.trim()).slice(0, 8)
  const routine = details.routine_title?.trim()
  const mac = devices[0] ?? (matrixDeviceWaitCopy[locale] ?? matrixDeviceWaitCopy.vi).yourMac

  switch (code) {
    case 'stopped':
      return copy.stopped

    case 'failed':
      return routine ? copy.routineFailed(routine) : copy.failed

    case 'deadline':
      return copy.deadline

    case 'couldnt_confirm':
      return devices.length ? copy.couldntConfirm + copy.mayHaveRun(deviceList(devices, locale)) : copy.couldntConfirm

    case 'unfunded':
      return `${copy.unfunded} ${copy.accessRemedy}`

    case 'trial_expired':
      return `${copy.trialExpired} ${copy.accessRemedy}`

    case 'turn_limit':
      return copy.turnLimit

    case 'reminder_missed':
      return copy.reminderMissed

    case 'stuck':
      return copy.stuck

    case 'access_final':
      return `${copy.accessFinal} ${copy.accessRemedy}`

    case 'queue_full':
      return copy.queueFull

    case 'memory_not_saved':
      return copy.memoryNotSaved

    case 'couldnt_verify_mac':
      return copy.couldntVerifyMac

    case 'resuming_on_device':
      return copy.resumingOnDevice(mac)

    case 'attachment_unsupported':
      return details.attachment === 'unsupported' ? copy.attachmentUnsupported : copy.attachmentUnreadable

    case 'reply_unreadable':
      return copy.replyUnreadable

    case 'thread_unsupported':
      return copy.threadUnsupported

    case 'saved_to_drive':
      return copy.savedToDrive

    case 'saved_as_copy':
      return copy.savedAsCopy

    case 'save_unconfirmed':
      return copy.saveUnconfirmed

    case 'daily_cap':
      return copy.dailyCap

    case 'daily_cap_warning':
      return copy.dailyCapWarning

    case 'device_unreachable':
      return details.resume ? copy.deviceAway(mac) : copy.deviceAwayNow(mac)
  }
}
