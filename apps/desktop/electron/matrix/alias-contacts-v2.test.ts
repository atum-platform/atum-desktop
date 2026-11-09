import {describe,expect,it} from 'vitest'

import {parseMatrixAliasRequest,parseMatrixAliasResponse} from './aliases'
const id='@app-moon:atumplatform.com'
const input={action:'contacts' as const,matrixUsers:[id],schemaVersion:2 as const}
describe('contacts/2 boundary',()=>{
 it('preserves explicit status, alias generation and directory revision',()=>{
  expect(parseMatrixAliasRequest(input)).toEqual(input)
  const response={schemaVersion:2,revision:42,contacts:[{matrixUser:id,status:'resolved',handle:'moon_bot',generation:2}]}
  expect(parseMatrixAliasResponse(response,input)).toEqual({kind:'contacts',...response})
  expect(()=>parseMatrixAliasResponse({...response,contacts:[{...response.contacts[0],handle:null}]},input)).toThrow()
  expect(()=>parseMatrixAliasResponse({...response,contacts:[{...response.contacts[0],generation:0}]},input)).toThrow()
 })
 it('rejects ambiguous nulls and invalid visibility payloads',()=>{
  expect(()=>parseMatrixAliasResponse({contacts:[{matrixUser:id,handle:null}]},input)).toThrow()
  expect(()=>parseMatrixAliasResponse({schemaVersion:2,revision:1,contacts:[{matrixUser:id,status:'not_visible',handle:'moon_bot',generation:2}]},input)).toThrow()
  expect(parseMatrixAliasResponse({schemaVersion:2,revision:1,contacts:[{matrixUser:id,status:'unknown',handle:null,generation:null}]},input))
    .toMatchObject({contacts:[{status:'unknown'}]})
 })
})
