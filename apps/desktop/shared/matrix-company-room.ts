/** Immutable Matrix metadata. Domain room registration remains the authority. */
export const MATRIX_COMPANY_PROJECT_TYPE = 'io.atum.company_project.v1'
export const MATRIX_COMPANY_PROJECT_BINDING = 'io.atum.company_project'
export const MATRIX_COMPANY_ROOM_VERSION = '11'

export interface MatrixCompanyRoomBinding {
  companyId: string
  projectId: string
  servicePrincipal: string
  serviceUserId: string
  managerUserId: string
}

export interface MatrixCompanyRoomTarget extends MatrixCompanyRoomBinding {
  roomId: string
  /** Exact current C1 roster resolved through MAS by the trusted provider. */
  memberUserIds: string[]
}

export type MatrixCompanyRoomCommand =
  | ({ kind: 'createCompanyProjectRoom'; name: string } & MatrixCompanyRoomBinding)
  | ({ kind: 'findCompanyProjectRoom' } & MatrixCompanyRoomBinding)
  | ({ kind: 'reconcileCompanyProjectRoom' } & MatrixCompanyRoomTarget)
  | ({ kind: 'readCompanyProjectRoom'; allowServiceInvite?: boolean } & MatrixCompanyRoomTarget)
  | ({ kind: 'joinCompanyProjectRoom' } & MatrixCompanyRoomTarget)
  | ({ kind: 'rotateCompanyProjectSession' } & MatrixCompanyRoomTarget)

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const USER = /^@[^\s:]{1,255}:[^\s]{1,255}$/

export function validCompanyRoomBinding(value: MatrixCompanyRoomBinding): boolean {
  return [value.companyId, value.projectId, value.servicePrincipal].every(id => UUID.test(id)) &&
    USER.test(value.managerUserId) && USER.test(value.serviceUserId) && value.managerUserId !== value.serviceUserId
}

export function companyRoomBinding(content: Record<string, unknown>, sender?: string): MatrixCompanyRoomBinding | undefined {
  const raw = content[MATRIX_COMPANY_PROJECT_BINDING]

  if (content.type !== MATRIX_COMPANY_PROJECT_TYPE || content.room_version !== MATRIX_COMPANY_ROOM_VERSION ||
      !sender || !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== 'companyId,projectId,servicePrincipal,serviceUserId') {return undefined}

  const result: MatrixCompanyRoomBinding = {
    companyId: Reflect.get(raw, 'companyId'),
    projectId: Reflect.get(raw, 'projectId'),
    servicePrincipal: Reflect.get(raw, 'servicePrincipal'),
    serviceUserId: Reflect.get(raw, 'serviceUserId'),
    managerUserId: sender
  }

  return validCompanyRoomBinding(result) ? result : undefined
}
