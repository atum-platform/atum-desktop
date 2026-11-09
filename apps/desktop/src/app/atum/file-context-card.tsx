import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { FileText } from '@/lib/icons'
import type { PreviewTarget } from '@/store/preview'

export function FileContextCard({ target }: { target: PreviewTarget }) {
  const { t } = useI18n()
  const [failed, setFailed] = useState(false)

  const open = async () => {
    const result = await window.hermesDesktop?.consumerFiles?.openNative(target.source).catch(() => null)
    setFailed(!result?.ok)
  }

  return <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
    <FileText className="size-10 text-(--atum-ink-muted)" />
    <h2 className="max-w-full truncate font-medium">{target.label}</h2>
    {target.byteSize !== undefined && <p className="text-xs text-(--atum-ink-muted)">{Math.ceil(target.byteSize / 1024).toLocaleString()} KB</p>}
    <p className="max-w-sm text-sm text-(--atum-ink-muted)">{t.composer.fileContextHint}</p>
    <Button onClick={() => void open()}>{t.composer.openExternal}</Button>
    {failed && <p role="alert">{t.composer.fileOpenFailed}</p>}
  </div>
}
