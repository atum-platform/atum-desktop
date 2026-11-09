import { CompanyStoreBridgeRequestSchema } from '../../shared/matrix-company-store'

import type { CompanyStoreJournal, CompanyStoreResource } from './company-store'
import { MatrixCompanyStoreController } from './company-store'
import type { StoreScope } from './store'

/** Main-owned registry; no renderer identity, principal, bearer or URL. */
export class MatrixCompanyStoreBridgeController {
  private owner: StoreScope | null = null
  private controllers = new Map<string, MatrixCompanyStoreController>()
  constructor(
    private readonly options: {
      journal: CompanyStoreJournal
      request(companyId: string, endpoint: CompanyStoreResource, signal: AbortSignal, input?: unknown): Promise<unknown>
    }
  ) {}
  activate(owner: StoreScope | null) {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {
      return
    }

    for (const controller of this.controllers.values()) {
      controller.activate(null)
    }

    this.controllers.clear()
    this.owner = owner
  }
  async request(value: unknown) {
    const input = CompanyStoreBridgeRequestSchema.parse(value)

    if (!this.owner) {
      throw new Error('company_store_unavailable')
    }

    let controller = this.controllers.get(input.companyId)

    if (!controller) {
      controller = new MatrixCompanyStoreController(input.companyId, {
        journal: this.options.journal,
        request: (endpoint, signal, body) => this.options.request(input.companyId, endpoint, signal, body)
      })
      controller.activate(this.owner)
      this.controllers.set(input.companyId, controller)
    }

    switch (input.action) {
      case 'refresh':
        return controller.refresh()

      case 'purchase':
        return controller.purchase(input.input)

      case 'resume':
        return controller.resume(input.idempotencyKey)

      case 'cancel':
        return controller.cancel(input.entitlementId)
    }
  }
}
