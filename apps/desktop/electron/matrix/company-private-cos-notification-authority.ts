import { MatrixCompanyPrivateCosViewSchema } from '../../shared/matrix-company-private-cos'

export interface MatrixCompanyPrivateCosNotificationScope {
  accountKey: string
  generation: number
}

const scopeKey = (scope: MatrixCompanyPrivateCosNotificationScope | null | undefined) =>
  scope ? `${scope.accountKey}\n${scope.generation}` : undefined

/**
 * Main-owned notification quarantine learned only from an authenticated platform view.
 * It is session/account scoped, never inferred from renderer state or a room's self-claim.
 */
export class MatrixCompanyPrivateCosNotificationAuthority {
  private scope?: string
  private readonly roomsByCompany = new Map<string, string>()

  private activate(scope: MatrixCompanyPrivateCosNotificationScope | null | undefined): boolean {
    const next = scopeKey(scope)

    if (next === this.scope) {
      return false
    }

    this.scope = next
    this.roomsByCompany.clear()

    return true
  }

  observe(scope: MatrixCompanyPrivateCosNotificationScope | null | undefined, value: unknown): boolean {
    const scopeChanged = this.activate(scope)

    if (!scope) {
      return scopeChanged
    }

    const parsed = MatrixCompanyPrivateCosViewSchema.safeParse(value)

    if (!parsed.success) {
      return scopeChanged
    }

    const companyId = parsed.data.pair.companyPrincipal
    const roomId = 'binding' in parsed.data ? parsed.data.binding.roomId : undefined

    if (roomId) {
      this.roomsByCompany.set(companyId, roomId)
    } else {
      this.roomsByCompany.delete(companyId)
    }

    // Re-publish even when unchanged: a replacement SDK host may have missed the prior command.
    return true
  }

  roomIds(scope: MatrixCompanyPrivateCosNotificationScope | null | undefined): string[] {
    this.activate(scope)

    return [...new Set(this.roomsByCompany.values())].sort()
  }

  has(scope: MatrixCompanyPrivateCosNotificationScope | null | undefined, roomId: string): boolean {
    this.activate(scope)

    return [...this.roomsByCompany.values()].includes(roomId)
  }
}
