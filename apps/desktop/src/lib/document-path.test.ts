import { describe, expect, it } from 'vitest'

import {
  documentIdentity,
  fsPathFromSource,
  isInsideWorkspace,
  isTextDocumentPath,
  joinWorkspacePath,
  nextDocumentName,
  normalizeFsPath,
  workspaceRelativePath
} from './document-path'

describe('normalizeFsPath', () => {
  it('collapses separators and resolves dot segments', () => {
    expect(normalizeFsPath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(normalizeFsPath('C:\\Users\\fixture-user-09\\..\\x\\doc.md')).toBe('C:/Users/x/doc.md')
    expect(normalizeFsPath('c:/x')).toBe('C:/x')
  })

  it('keeps relative paths relative and does not climb above root', () => {
    expect(normalizeFsPath('../x/y')).toBe('../x/y')
    expect(normalizeFsPath('/../x')).toBe('/x')
  })
})

describe('workspace containment', () => {
  const root = '/home/example/ws'

  it('returns a posix relative path for files inside the workspace', () => {
    expect(workspaceRelativePath('/home/example/ws/Tài liệu 1.md', root)).toBe('Tài liệu 1.md')
    expect(workspaceRelativePath('/home/example/ws/sub/./a.md', `${root}/`)).toBe('sub/a.md')
  })

  it('rejects siblings, parents, traversal, the root itself, and relative inputs', () => {
    expect(workspaceRelativePath('/home/example/ws2/a.md', root)).toBeNull()
    expect(workspaceRelativePath('/home/example/a.md', root)).toBeNull()
    expect(workspaceRelativePath('/home/example/ws/../a.md', root)).toBeNull()
    expect(workspaceRelativePath('/home/example/ws', root)).toBeNull()
    expect(workspaceRelativePath('a.md', root)).toBeNull()
    expect(isInsideWorkspace('/home/example/ws/a.md', null)).toBe(false)
  })

  it('compares Windows drive letters case-insensitively', () => {
    expect(workspaceRelativePath('c:\\ws\\Docs\\a.md', 'C:/ws')).toBe('Docs/a.md')
  })
})

describe('fsPathFromSource', () => {
  it('decodes file URLs', () => {
    expect(fsPathFromSource('file:///home/example/ws/T%C3%A0i%20li%E1%BB%87u%201.md')).toBe('/home/example/ws/Tài liệu 1.md')
    expect(fsPathFromSource('file:///C:/ws/a.md')).toBe('C:/ws/a.md')
    expect(fsPathFromSource('/plain/path.md')).toBe('/plain/path.md')
  })
})

describe('documentIdentity / isTextDocumentPath', () => {
  it('builds one identity record', () => {
    expect(documentIdentity('/ws/notes/a.MD', '/ws')).toEqual({
      inWorkspace: true,
      name: 'a.MD',
      path: '/ws/notes/a.MD',
      relativePath: 'notes/a.MD'
    })
    expect(isTextDocumentPath('/ws/a.MD')).toBe(true)
    expect(isTextDocumentPath('/ws/a.txt')).toBe(true)
    expect(isTextDocumentPath('/ws/a.docx')).toBe(false)
    expect(isTextDocumentPath('/ws/README')).toBe(false)
  })
})

describe('nextDocumentName', () => {
  it('picks the first free Vietnamese default name, case-insensitively', () => {
    expect(nextDocumentName([])).toBe('Tài liệu 1.md')
    expect(nextDocumentName(['Tài liệu 1.md', 'tài liệu 2.MD', '/x/Tài liệu 4.md'])).toBe('Tài liệu 3.md')
  })

  it('joins into the workspace', () => {
    expect(joinWorkspacePath('/ws/', 'Tài liệu 1.md')).toBe('/ws/Tài liệu 1.md')
  })
})
