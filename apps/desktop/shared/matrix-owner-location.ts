/**
 * The owner's own coarse location (0333, `atum.owner-location/1`): one Settings row and its one
 * switch. The value is the platform's stored city/region/country, never a coordinate, and it is
 * read only by the owner's own signed-in Mac. No bridge is exposed when the platform does not
 * configure the route, so an older host simply shows no row.
 */
export interface MatrixOwnerLocationView {
  enabled: boolean
  city?: string
  region?: string
  country?: string
}

export interface MatrixOwnerLocationBridge {
  read(): Promise<MatrixOwnerLocationView>
  setEnabled(enabled: boolean): Promise<MatrixOwnerLocationView>
}
