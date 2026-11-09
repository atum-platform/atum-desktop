import { describe, expect, it } from 'vitest'

import { deletesDriveInBulk, type DriveDeleteContext } from './drive-delete'
import { classifyCommand, classifyExecute } from './policy'

const context: DriveDeleteContext = {
  home: '/Users/fixture',
  roots: ['/Users/fixture/Atum/Drive', '/Volumes/Old Disk/Drive'],
  realpath: value => value
}

const bulk = (command: string) => deletesDriveInBulk(command, context)

describe('Drive-aware mass-delete detection', () => {
  it.each([
    'rm -rf ~/Atum/Drive',
    'rm -rf "$HOME/Atum/Drive"',
    'rm -rf ${HOME}/Atum/Drive/',
    'rm -rf /Users/fixture/Atum/Drive',
    'rm -Rf /Users/fixture/Atum/Drive/',
    'rm -r --force /Users/fixture/Atum/Drive',
    'rm -rf /users/fixture/atum/drive',
    'rm -rf ~/Atum/Drive/*',
    'rm -rf ~/Atum/Drive/.*',
    'rm -f ~/Atum/Drive/*',
    'rm ~/Atum/Drive/*',
    'rm -rf ~/Atum/Dr*',
    'rm -rf ~/Atum',
    'rm -rf ~/Atum/*',
    'rm -rf ~/At*/Drive',
    'rm -rf /Users/fixture',
    'rm -rf "/Volumes/Old Disk/Drive"',
    'rm -rf /Volumes/Old\\ Disk/Drive/*',
    'cd ~/Atum/Drive && rm -rf .',
    'cd ~/Atum/Drive && rm -rf ./*',
    'cd ~/Atum/Drive; rm -rf *',
    '(cd ~/Atum && rm -rf Drive)',
    'cd ~/Atum/Drive/.. && rm -rf Drive',
    'pushd ~/Atum/Drive && rm -rf -- *',
    'rm -rf ../../../Atum/Drive',
    'rm -rf ../../..',
    'D=~/Atum/Drive; rm -rf "$D"',
    'D=$HOME/Atum; rm -rf $D/Drive',
    'sudo rm -rf ~/Atum/Drive',
    'find ~/Atum/Drive -delete',
    'find ~/Atum/Drive -type f -delete',
    'find ~/Atum/Drive -name "*" -exec rm {} +',
    'find ~/Atum/Drive -type f | xargs rm',
    'find ~/Atum -delete',
    'mv ~/Atum/Drive/* /tmp/elsewhere',
    'mv ~/Atum/Drive /tmp/elsewhere',
    'rsync -a --delete /tmp/empty/ ~/Atum/Drive/',
    'rsync -a --remove-source-files ~/Atum/Drive/ /tmp/elsewhere/',
    'rsync -a --del /tmp/empty/ ~/Atum/Drive/',
    'rsync -a --delete-after /tmp/empty/ ~/Atum/Drive/',
    'rsync -a --remove-source ~/Atum/Drive/ /tmp/elsewhere/',
    'echo ok && rm -rf ~/Atum/Drive',
    'trash ~/Atum/Drive/*'
  ])('gates: %s', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    'rm ~/Atum/Drive/Q3/old.md',
    'rm -f ~/Atum/Drive/Q3/*.tmp',
    'rm -rf ~/Atum/Drive/Q3',
    'rm -rf ~/Atum/Drive/Q3/*',
    'rm -rf ~/Atum/Drive/Q3/drafts/',
    'rm -rf node_modules dist',
    'rm -rf ./build/*',
    'rm -rf ~/Atum/Other',
    'rm -rf ~/Documents/Atum',
    'rm -rf /tmp/work',
    'cd ~/Atum/Drive/Q3 && rm -rf .',
    'cd ~/Atum/Drive/Q3 && rm -rf *',
    'find ~/Atum/Drive/Q3 -name "*.tmp" -delete',
    'find ~/Atum/Drive -name "*.tmp"',
    'mv ~/Atum/Drive/a.md ~/Atum/Drive/b.md',
    'mv ~/Atum/Drive/Q3/* ~/Atum/Drive/Q4/',
    'rsync -a ~/Atum/Drive/ /tmp/backup/',
    'rsync -a --delete ~/Atum/Drive/ /tmp/backup/',
    'cp -r ~/Atum/Drive/Q3 /tmp/q3',
    'ls ~/Atum/Drive',
    'echo rm -rf ~/Atum/Drive/Q3',
    'cat ~/Atum/Drive/notes.md > /tmp/n && rm /tmp/n'
  ])('stays silent: %s', command => {
    expect(bulk(command)).toBe(false)
  })

  it('treats every learned root as the Drive, current or past', () => {
    expect(bulk('rm -rf "/Volumes/Old Disk/Drive"')).toBe(true)
    expect(deletesDriveInBulk('rm -rf /Volumes/X/Drive', { ...context, roots: ['/Volumes/X/Drive'] })).toBe(true)
    expect(deletesDriveInBulk('rm -rf /Volumes/X/Drive', { ...context, roots: [] })).toBe(false)
  })

  it('judges a relative path from where commands start (the working copy, three levels under ~/Atum Tasks)', () => {
    expect(bulk('rm -rf ../../../*')).toBe(true)
    expect(bulk('rm -rf ../sibling')).toBe(false)
    expect(deletesDriveInBulk('rm -rf .', { ...context, cwd: '/Users/fixture/Atum/Drive' })).toBe(true)
    expect(deletesDriveInBulk('rm -rf .', { ...context, cwd: '/Users/fixture/Atum/Drive/Q3' })).toBe(false)
  })

  it('feeds the same capability the home-folder gate uses, without a Drive context changing anything else', () => {
    expect(classifyCommand('true & rm -rf ~/Atum/Drive/{*,.*}', context).has('bulk_destructive')).toBe(true)
    expect(classifyCommand('true & rm -rf ~/Atum/Drive/Q3/{a,b}', context).size).toBe(0)
    expect(classifyCommand('find ~/Atum/Drive -name "*.tmp" -delete', context).size).toBe(0)
    expect(classifyCommand('find ~/Atum/Drive -delete', context).has('bulk_destructive')).toBe(true)
    expect(classifyCommand('rm -rf ~/Atum/Drive', context).has('bulk_destructive')).toBe(true)
    expect(classifyCommand('rm -rf ~/Atum/Drive').has('bulk_destructive'), 'no context, no Drive knowledge').toBe(false)
    expect(classifyCommand('rm -rf ~/Atum/Drive/Q3', context).size).toBe(0)

    const args = { command: 'rm -rf ~/Atum/Drive/*' }
    expect([...classifyExecute({ tool: 'terminal', args }, context)]).toEqual(['bulk_destructive'])
    expect(classifyExecute({ tool: 'terminal', args }).size, 'no Drive context, no Drive knowledge').toBe(0)
  })
})

// Review round 2 (2026-10-24, P1): the command text is read the way a shell reads it, so a delete
// is judged wherever it sits, and braces are expanded before the path is matched.
describe('where a delete can hide', () => {
  it.each([
    // every separator (a single `&` is one), and the same command on its own line
    'true & rm -rf ~/Atum/Drive',
    'x &rm -rf ~/Atum/Drive',
    'true&rm -rf ~/Atum/Drive',
    'true &\nrm -rf ~/Atum/Drive',
    'echo ok\nrm -rf ~/Atum/Drive',
    'echo ok\n  rm -rf ~/Atum/Drive\necho done',
    'echo ok\r\nrm -rf ~/Atum/Drive',
    'ls || rm -rf ~/Atum/Drive',
    'ls | rm -rf ~/Atum/Drive',
    'true; rm -rf ~/Atum/Drive',
    'ls;;rm -rf ~/Atum/Drive',
    // redirections are not arguments and `&` in them is not a separator
    'rm -rf ~/Atum/Drive 2>&1',
    'rm -rf ~/Atum/Drive &> /dev/null',
    'rm -rf ~/Atum/Drive >/dev/null 2>&1 &',
    'rm -rf ~/Atum/Drive > /tmp/out',
    // subshells, groups, compound commands, substitutions, process substitution
    '(rm -rf ~/Atum/Drive)',
    '( cd ~/Atum/Drive && rm -rf * )',
    'true && { rm -rf ~/Atum/Drive; }',
    'if true; then rm -rf ~/Atum/Drive; fi',
    'while true; do rm -rf ~/Atum/Drive; done',
    '! rm -rf ~/Atum/Drive',
    'echo $(rm -rf ~/Atum/Drive)',
    '$(rm -rf ~/Atum/Drive)',
    'echo `rm -rf ~/Atum/Drive`',
    'echo "$(rm -rf ~/Atum/Drive)"',
    'echo $(echo $(rm -rf ~/Atum/Drive))',
    'diff <(rm -rf ~/Atum/Drive) /dev/null',
    // loops bind their variable to the item that reaches the Drive
    'for d in ~/Atum/Drive; do rm -rf "$d"; done',
    'for d in a ~/Atum/Drive/*; do rm -rf "$d"; done',
    'cd ~/Atum/Drive; for f in *; do rm -rf -- "$f"; done',
    // a shell given the script, or eval
    'bash -c "rm -rf ~/Atum/Drive"',
    "sh -c 'cd ~/Atum/Drive && rm -rf *'",
    'zsh -lc "rm -rf ~/Atum/Drive"',
    'sudo bash -c "rm -rf ~/Atum/Drive"',
    'eval "rm -rf ~/Atum/Drive"',
    'eval rm -rf ~/Atum/Drive',
    'bash <<EOF\nrm -rf ~/Atum/Drive\nEOF',
    "bash <<< 'rm -rf ~/Atum/Drive'",
    // comments and heredoc prose with an apostrophe do not swallow what follows
    "# don't\nrm -rf ~/Atum/Drive",
    "cat > notes.md <<'EOF'\ndon't forget\nEOF\nrm -rf ~/Atum/Drive",
    // variables, `$PWD`, and a subshell's `cd` that does not leak out
    'export D=~/Atum/Drive; rm -rf "$D"',
    'cd ~/Atum/Drive && rm -rf "$PWD"',
    'cd ~/Atum/Drive && (cd /tmp) && rm -rf *',
    'cd ~/Atum/Drive && cd /tmp && cd - && rm -rf *',
    'cd ~/Atum/Drive && pushd /tmp > /dev/null && popd > /dev/null && rm -rf *',
    'cd ~/Atum/Drive; echo $(cd /tmp); rm -rf *',
    // wrappers and spellings of the program
    'timeout 5 rm -rf ~/Atum/Drive',
    'sudo -u root rm -rf ~/Atum/Drive',
    'nice -n 5 rm -rf ~/Atum/Drive',
    'env -i FOO=1 rm -rf ~/Atum/Drive',
    'command rm -rf ~/Atum/Drive',
    '\\rm -rf ~/Atum/Drive',
    '/bin/rm -rf ~/Atum/Drive',
    '"rm" -rf ~/Atum/Drive',
    // the volume is case-insensitive, so the program may be spelled any way; and busybox runs an applet
    'RM -rf ~/Atum/Drive',
    'Rm -Rf ~/Atum/Drive',
    'FIND ~/Atum/Drive -delete',
    'busybox rm -rf ~/Atum/Drive',
    'setsid rm -rf ~/Atum/Drive',
    'stdbuf -oL rm -rf ~/Atum/Drive',
    'arch -arm64 rm -rf ~/Atum/Drive',
    'ionice -c 3 rm -rf ~/Atum/Drive',
    // a script's positional parameters, and the one substitution that can be read
    "bash -c 'rm -rf \"$1\"' _ ~/Atum/Drive",
    "sh -c 'rm -rf \"$0\"' ~/Atum/Drive",
    'cd ~/Atum/Drive && rm -rf "$(pwd)"/*',
    'cd ~/Atum/Drive && rm -rf `pwd`/*',
    // xargs handed the path by echo / printf
    'echo ~/Atum/Drive | xargs rm -rf',
    'printf "%s\\n" ~/Atum/Drive | xargs -n1 rm -r',
    'ls -A ~/Atum/Drive | xargs -I{} rm -rf ~/Atum/Drive/{}'
  ])('gates: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    'true & rm -rf /tmp/work',
    'ls; rm -rf ~/Atum/Drive/Q3',
    'ls || rm -rf ~/Atum/Drive/Q3',
    'true&rm -rf ~/Atum/Drive/Q3',
    '(cd ~/Atum/Drive/Q3 && rm -rf *)',
    'if true; then rm -rf node_modules; fi',
    'for f in a b; do rm -rf "$f"; done',
    'echo $(date) > /tmp/n',
    // text that only mentions a delete
    'echo "x && rm -rf ~/Atum/Drive" > /tmp/n',
    "echo 'rm -rf ~/Atum/Drive; rm -rf ~/Atum/Drive/*'",
    'git commit -m "clean up; rm -rf ~/Atum/Drive"',
    'rm -rf node_modules # rm -rf ~/Atum/Drive',
    "rm -rf dist # don't touch ~/Atum/Drive\nls",
    "cat > notes.md <<'EOF'\nrun it\nEOF\nrm -rf ~/Atum/Drive/Q3",
    // ordinary work around the Drive, including text that talks about the dangerous command
    "cat <<'EOF' > ~/Atum/Drive/Q3/readme.md\n# Notes\nDon't run rm -rf ~/Atum/Drive here.\nEOF\nls",
    "cat > ~/Atum/Drive/Q3/run.sh <<'EOF'\n#!/bin/sh\nrm -rf /tmp/work\nEOF\nchmod +x ~/Atum/Drive/Q3/run.sh",
    'for f in ~/Atum/Drive/*.md; do wc -l "$f"; done',
    'for f in ~/Atum/Drive/*; do wc -l "$f"; done',
    'for f in ~/Atum/Drive/*.tmp; do rm "$f"; done',
    'for d in ~/Atum/Drive/*/; do rm -rf "$d/tmp"; done',
    "find ~/Atum/Drive -name '*.md' | xargs wc -l",
    'sed -i "" "s/a/b/" ~/Atum/Drive/notes.md && ls ~/Atum/Drive',
    'rm -f ~/Atum/Drive/Q3/*.tmp ~/Atum/Drive/Q3/*.bak',
    'bash script.sh',
    'bash -c "rm -rf ~/Atum/Drive/Q3"',
    "bash -c 'rm -rf \"$1\"' _ ~/Atum/Drive/Q3",
    "bash -c 'rm -rf \"$1\"' _",
    'cd ~/Atum/Drive/Q3 && rm -rf "$(pwd)"/*',
    // directories are scoped to the subshell they were changed in
    'cd ~/Atum/Drive/Q3 && (cd .. && ls) && rm -rf *',
    'cd /tmp; (cd ~/Atum/Drive && ls); rm -rf *',
    'cd /tmp; echo $(cd ~/Atum/Drive); rm -rf *',
    'cd ~/Atum/Drive && cd /tmp && rm -rf *',
    'cd /tmp && cd ~/Atum/Drive && cd - && rm -rf *',
    'pushd ~/Atum/Drive > /dev/null && popd > /dev/null && rm -rf *',
    'echo ~/Atum/Drive/Q3 | xargs rm -rf',
    'ls ~/Atum/Drive/Q3 | xargs -I{} rm -rf ~/Atum/Drive/Q3/{}',
    'echo ~/Atum/Drive | xargs ls'
  ])('stays silent: %j', command => {
    expect(bulk(command)).toBe(false)
  })

  it('does not split a path on a quoted `&` or parenthesis (a volume called "R&D (2)")', () => {
    const odd: DriveDeleteContext = { ...context, roots: ['/Volumes/R&D (2)/Drive'] }

    expect(deletesDriveInBulk('rm -rf "/Volumes/R&D (2)/Drive"', odd)).toBe(true)
    expect(deletesDriveInBulk('rm -rf /Volumes/R\\&D\\ \\(2\\)/Drive/*', odd)).toBe(true)
    expect(deletesDriveInBulk('rm -rf "/Volumes/R&D (2)/Drive/Q3"', odd)).toBe(false)
  })
})

describe('brace expansion', () => {
  it.each([
    'rm -rf ~/Atum/Drive/{*,.*}',
    'rm -f ~/Atum/Drive/{*,.*}',
    'rm ~/Atum/Drive/{a,*}',
    'rm -rf ~/Atum/Drive/{a,{b,.*}}',
    'rm -rf ~/Atum/{Drive,Other}',
    'rm -rf ~/{Atum,x}/Drive',
    'rm -rf ~/Atum/Dr{i,x}ve',
    'rm -rf ~/{Atum/Drive,x}',
    'rm -rf ~/Atum/{Drive/Q3,Drive}',
    'rm -rf "$HOME"/Atum/Drive/{*,.*}',
    'cd ~/Atum/Drive && rm -rf {*,.*}',
    'mv ~/Atum/Drive/{*,.*} /tmp/x',
    'find ~/Atum/{Drive,Other} -delete',
    'rm -rf ~/Atum/Drive/{,}{*,.*}'
  ])('expands before matching: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    'rm -rf ~/Atum/Drive/Q3/{a,b}',
    'rm -rf ~/Atum/Drive/{Q3,Q4}',
    'rm ~/Atum/Drive/{a,b,c}.md',
    'rm -rf ~/Atum/Drive/Q3/file{1..5}.md',
    'rm -rf ~/Atum/Other/{1..100}',
    'rm -rf /tmp/{1..100}',
    'rm -rf ./build/{a,b}',
    'rm -rf ~/Atum/Drive/Q3/{x,{y,z}}',
    'rm -rf ${HOME}/Atum/Drive/Q3',
    // a partial wildcard does not empty the folder, braces or not
    'rm -rf ~/Atum/Drive/{a,b}{*,.*}'
  ])('leaves an ordinary delete alone: %j', command => {
    expect(bulk(command)).toBe(false)
  })

  it.each([
    // more alternatives than are expanded, or a sequence that cannot be read: a recursive delete under a Drive root asks
    'rm -rf ~/Atum/Drive/Q3/{1..100}',
    'rm -rf ~/Atum/Drive/Q3/{a..zz}',
    'rm -rf ~/Atum/Drive/Q3/{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}',
    'rm -rf ~/Atum/Drive/{1..100}',
    'rm -rf ~/{1..100}/x',
    // and a group that big at the Drive's top level is a wildcard there, even without -r
    'rm ~/Atum/Drive/{1..100}'
  ])('fails toward asking when it cannot expand: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it('does not ask for the same overflow elsewhere, and stays quick on a pathological one', () => {
    expect(bulk('rm -rf /tmp/{1..100}')).toBe(false)
    expect(bulk('rm ~/Atum/Drive/Q3/{1..100}'), 'not recursive, not the top level').toBe(false)

    const started = Date.now()
    expect(bulk(`rm -rf ~/Atum/Drive/Q3/${'{a,b}'.repeat(40)}`)).toBe(true)
    expect(bulk(`rm -rf /tmp/${'{a,b}'.repeat(40)}`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('find: an ordinary edit is not a mass delete', () => {
  it.each([
    'find ~/Atum/Drive -delete',
    'find ~/Atum/Drive -type f -delete',
    'find -L ~/Atum/Drive -delete',
    'find -H ~/Atum/Drive -type f -delete',
    'cd ~/Atum/Drive && find -delete',
    'cd ~/Atum/Drive && find . -delete',
    'find ~/Atum/Drive -mindepth 1 -delete',
    'find ~/Atum/Drive -maxdepth 1 -type f -delete',
    "find ~/Atum/Drive -name '*' -delete",
    "find ~/Atum/Drive -name '**' -delete",
    'find ~/Atum/Drive -iname "*" -exec rm -rf {} ";"',
    "find ~/Atum/Drive -regex '.*' -delete",
    "find ~/Atum/Drive -path '*' -delete",
    // an action runs as find walks: a test AFTER it narrows nothing
    "find ~/Atum/Drive -delete -name '*.tmp'",
    // a negated test removes everything else
    'find ~/Atum/Drive ! -name keep.md -delete',
    'find ~/Atum/Drive -not -newer ref.txt -delete',
    // one alternative with no filter is enough
    "find ~/Atum/Drive -name '*.tmp' -o -type f -delete",
    // exec forms that remove or move
    "find ~/Atum/Drive -type f -exec sh -c 'rm \"$1\"' _ {} \\;",
    'find ~/Atum/Drive -type f -exec mv {} /tmp/out ";"',
    // listing into xargs
    'find ~/Atum/Drive -type f | xargs -0 rm',
    'find ~/Atum/Drive -type f -print0 | xargs -0 rm -f',
    'find ~/Atum/Drive | xargs rm -rf',
    'find ~/Atum/Drive/* -type f -delete'
  ])('gates: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    'find ~/Atum/Drive -name "*.tmp" -delete',
    "find ~/Atum/Drive -name '*.tmp' -delete",
    "find -L ~/Atum/Drive -name '*.tmp' -delete",
    'find ~/Atum/Drive -type f -name "*.log" -delete',
    'find ~/Atum/Drive -name .DS_Store -delete',
    'find ~/Atum/Drive -iname "*.bak" -exec rm {} +',
    "find ~/Atum/Drive -name '*.tmp' -exec rm {} ';'",
    "find ~/Atum/Drive -name '*.tmp' -exec sh -c 'rm \"$1\"' _ {} \\;",
    "find ~/Atum/Drive \\( -name '*.tmp' -o -name '*.bak' \\) -delete",
    'find ~/Atum/Drive -path "*/node_modules/*" -delete',
    "find ~/Atum/Drive -regex '.*\\.tmp' -delete",
    'find ~/Atum/Drive -mtime +30 -delete',
    'find ~/Atum/Drive -newer ref.txt -delete',
    'find ~/Atum/Drive -size +100M -delete',
    'find ~/Atum/Drive -empty -delete',
    'find ~/Atum/Drive -maxdepth 1 -name "*.tmp" -delete',
    'find ~/Atum/Drive -name "*.tmp" | xargs rm',
    'find ~/Atum/Drive -name "*.tmp" -print0 | xargs -0 rm',
    // a subfolder is an ordinary edit, as `rm -rf <Drive>/Q3` is
    'find ~/Atum/Drive/Q3 -delete',
    'find ~/Atum/Drive/Q3 -type f -delete',
    'cd ~/Atum/Drive/Q3 && find . -delete',
    // nothing is removed
    'find ~/Atum/Drive -type f -print',
    'find ~/Atum/Drive -type f -exec ls {} +',
    'find ~/Atum/Drive -name "*.tmp"'
  ])('stays silent: %j', command => {
    expect(bulk(command)).toBe(false)
  })
})

describe('text that cannot be read', () => {
  it('asks when it names a delete and the Drive, and only then', () => {
    const nested = (inner: string) => '$('.repeat(10) + inner + ')'.repeat(10)

    expect(bulk(nested('rm -rf ~/Atum/Drive'))).toBe(true)
    expect(bulk(nested('echo hi'))).toBe(false)
    expect(bulk(nested('rm -rf /tmp/x'))).toBe(false)
  })
})

// Review round 4 (2026-10-24, two P1s). Re-review of the round-3 head: the reviewer's seven assertions, each as written.
describe('review round 4: the reviewer’s assertions', () => {
  const caps = (command: string) => classifyCommand(command, context)

  it('1. `rm -rf "${HOME:?}/Atum/Drive"` is gated: only `$NAME` and `${NAME}` were read', () => {
    expect(bulk('rm -rf "${HOME:?}/Atum/Drive"')).toBe(true)
    expect(caps('rm -rf "${HOME:?}/Atum/Drive"').has('bulk_destructive')).toBe(true)
  })

  it('2. `D=~/Atum/Drive; rm -rf "${D:-/tmp}"` is gated: D is set, so its default is not used', () => {
    expect(bulk('D=~/Atum/Drive; rm -rf "${D:-/tmp}"')).toBe(true)
    expect(caps('D=~/Atum/Drive; rm -rf "${D:-/tmp}"').has('bulk_destructive')).toBe(true)
    expect(bulk('rm -rf "${D:-/tmp}"'), 'D is not set: the default is the target').toBe(false)
  })

  it("3. `cat > notes.md <<'EOF'` with `sudo id` inside is silent", () => {
    const command = "cat > notes.md <<'EOF'\nsudo id\nEOF"

    expect([...caps(command)]).toEqual([])
    expect([...classifyCommand(command)]).toEqual([])
  })

  it('4. inert `rm -rf ~` prose in a heredoc is silent, with the Drive named in it or not', () => {
    for (const command of ["cat > notes.md <<'EOF'\nrm -rf ~\nEOF", 'cat > notes.md <<EOF\nrm -rf ~/Atum/Drive\nEOF', "cat <<'EOF' > README.md\n# Cleanup\nrm -rf ~ && rm -rf ~/Atum/Drive/*\nEOF\nls"]) {
      expect([...caps(command)], JSON.stringify(command)).toEqual([])
      expect([...classifyCommand(command)], JSON.stringify(command)).toEqual([])
    }
  })

  it('5. `bash <<EOF` with `sudo id` inside is gated', () => {
    expect(caps('bash <<EOF\nsudo id\nEOF').has('sudo')).toBe(true)
    expect(classifyCommand('bash <<EOF\nsudo id\nEOF').has('sudo')).toBe(true)
    expect(bulk('bash <<EOF\nrm -rf ~/Atum/Drive\nEOF')).toBe(true)
  })

  it("6. `rm -rf '~/Atum/Drive'` is a path named `~/Atum/Drive` below the working directory: not the Drive", () => {
    expect(bulk("rm -rf '~/Atum/Drive'")).toBe(false)
    expect(deletesDriveInBulk("rm -rf '~/Atum/Drive'", { ...context, cwd: '/Users/fixture' }), 'not even from the home folder: `~` is a folder there').toBe(false)
    expect(deletesDriveInBulk("rm -rf '~/Atum/Drive'", { ...context, cwd: '/Users/fixture', realpath: value => value.replace('/Users/fixture/~', '/Users/fixture') }), 'unless that `~` is a link to it').toBe(true)
    expect(bulk('rm -rf ~/Atum/Drive'), 'unquoted, the shell expands it').toBe(true)
  })

  it('7. `rm -rf "$HOME/Atum/Drive/{*,.*}"` names a file called `{*,.*}`: not bulk', () => {
    expect(bulk('rm -rf "$HOME/Atum/Drive/{*,.*}"')).toBe(false)
    expect(caps('rm -rf "$HOME/Atum/Drive/{*,.*}"').has('bulk_destructive')).toBe(false)
    expect(bulk('rm -rf "$HOME"/Atum/Drive/{*,.*}'), 'the braces outside the quotes are expanded').toBe(true)
    expect(bulk('rm -rf $HOME/Atum/Drive/{*,.*}')).toBe(true)
  })
})

describe('review round 4: parameter expansion', () => {
  it.each([
    // `${NAME:?msg}`, `${NAME?}`: NAME
    'rm -rf "${HOME:?}/Atum/Drive"',
    'rm -rf "${HOME?}/Atum/Drive"',
    'rm -rf "${HOME:?no home}/Atum/Drive"',
    'rm -rf ${HOME:?}/Atum/Drive/',
    'D=~/Atum/Drive; rm -rf "${D:?}"',
    'D=~/Atum/Drive; rm -rf "${D?unset}"',
    // `${NAME:-w}`, `${NAME-w}`: NAME when it is known and not empty
    'rm -rf "${HOME:-/tmp}/Atum/Drive"',
    'rm -rf "${HOME-/tmp}/Atum/Drive"',
    'D=~/Atum/Drive; rm -rf "${D:-/tmp}"',
    'D=~/Atum/Drive; rm -rf "${D-/tmp}"',
    'D=~/Atum/Drive; rm -rf "${D:-}"',
    // otherwise `w`, read like any word: variables, a tilde, nested defaults, quotes
    'rm -rf "${UNSET:-$HOME/Atum/Drive}"',
    'rm -rf ${UNSET-~/Atum/Drive}',
    'rm -rf "${UNSET:-/Users/fixture/Atum/Drive}"',
    'E=; rm -rf ${E:-~/Atum/Drive}',
    'rm -rf "${UNSET:-${HOME}/Atum/Drive}"',
    'rm -rf "${UNSET:-${ALSO:-$HOME/Atum/Drive}}"',
    'rm -rf "${UNSET:-"$HOME/Atum/Drive"}"',
    "rm -rf \"${UNSET:-'/Users/fixture/Atum/Drive'}\"",
    'D=/tmp; rm -rf "${E:-$D}" "${E:-$HOME/Atum/Drive}"',
    // `${NAME:=w}`: the same, and it assigns, so the next use sees it
    'rm -rf ${D:=~/Atum/Drive}',
    'rm -rf "${D:=$HOME/Atum/Drive}"',
    'rm -rf ${D=~/Atum/Drive}',
    ': "${D:=$HOME/Atum/Drive}"; rm -rf "$D"',
    ': ${D:=~/Atum/Drive}; rm -rf "$D"',
    'echo "${D:=$HOME/Atum/Drive}"; rm -rf "$D"',
    'echo ${D=~/Atum/Drive}; rm -rf $D',
    'true "${D:=~/Atum}"; rm -rf "$D/Drive"',
    // `${NAME:+w}`: w when NAME is set
    'D=x; rm -rf "${D:+$HOME/Atum/Drive}"',
    'D=x; rm -rf ${D+~/Atum/Drive}',
    'D=~/Atum/Drive; rm -rf "${D:+$D}"',
    // wildcards, braces and directories after it
    'rm -rf "${HOME:?}"/Atum/Drive/*',
    'rm -rf "${HOME:?}/Atum/Drive"/{*,.*}',
    'rm -f "${HOME:?}"/Atum/Drive/*',
    'rm -rf "${HOME:?}/Atum"',
    'cd "${HOME:?}/Atum/Drive" && rm -rf *',
    'cd "${HOME:-/tmp}/Atum/Drive" && rm -rf .',
    'D=~/Atum; cd "${D:?}/Drive" && rm -rf ./*',
    // every program that removes
    'find "${HOME:?}/Atum/Drive" -delete',
    'mv "${HOME:?}/Atum/Drive"/* /tmp/x',
    'rsync -a --delete /tmp/empty/ "${HOME:?}/Atum/Drive/"',
    'echo "${HOME:?}/Atum/Drive" | xargs rm -rf',
    'trash "${HOME:?}/Atum/Drive"/*',
    'for d in "${HOME:?}/Atum/Drive"; do rm -rf "$d"; done',
    // run by a shell
    "bash -c 'rm -rf \"${HOME:?}/Atum/Drive\"'",
    "eval 'rm -rf \"${HOME:?}/Atum/Drive\"'",
    "bash -c 'rm -rf \"${1:?}\"' _ ~/Atum/Drive",
    "bash -c 'rm -rf \"${1:-/tmp}\"' _ ~/Atum/Drive",
    "bash -c 'rm -rf ${1:-~/Atum/Drive}' _"
  ])('gates: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    // any other `${…}`: it may be the Drive, so a RECURSIVE delete of it asks
    'rm -rf "${HOME%/}/Atum/Drive"',
    'rm -rf "${HOME#/}"',
    'rm -rf "${HOME:0:11}/Atum/Drive"',
    'D=~/Atum/Drive; rm -rf "${D%/}"',
    'D=~/Atum/Drive; rm -rf "${D%%/}"',
    'D=~/Atum/Drive; rm -rf "${D##*/}"',
    'D=~/Atum/Drive; rm -rf "${D/Drive/Drive}"',
    'D=~/Atum/Drive; rm -rf "${D//x/y}"',
    'D=~/Atum/Drive; rm -rf "${#D}"',
    'D=~/Atum/Drive; rm -rf "${D:0:100}"',
    'D=~/Atum/Drive; rm -rf "${D^^}"',
    'D=~/Atum/Drive; rm -rf "${D,,}"',
    'D=~/Atum/Drive; rm -rf "${D@Q}"',
    'ref=D; D=~/Atum/Drive; rm -rf "${!ref}"',
    'arr=(~/Atum/Drive); rm -rf "${arr[@]}"',
    'rm -rf "${arr[0]}"',
    'rm -rf "${@}"',
    'rm -rf ${(P)ref}',
    'rm -rf ${~ref}',
    // it does not matter what the subject is, or what else the word holds
    'rm -rf "${X%/}"',
    'rm -rf /tmp/"${X%/}"',
    'rm -rf "${X%/}/build"',
    'rm -rf "$UNSET/${X%/}"',
    // every spelling of a recursive delete
    'rm -r "${D%/}"',
    'rm -fr "${D%/}"',
    'rm -Rf "${D%/}"',
    'rm --recursive "${D%/}"',
    'trash "${D%/}"',
    'sudo rm -rf "${D%/}"',
    'find "${D%/}" -delete',
    'find "${D%/}" -type f -exec rm {} +',
    'echo "${D%/}" | xargs rm -rf',
    'rsync -a --delete /tmp/empty/ "${D%/}/"',
    'rsync -a --delete-after /tmp/empty/ "${D%/}"',
    'rsync -a --remove-source-files "${D%/}/" /tmp/x/',
    // never closed, or too long for a `${…}` to be followed (the lexer reads 512 characters of one): unreadable, whatever padding it holds
    'rm -rf ${HOME/Atum/Drive',
    'rm -rf "${HOME:-/Atum/Drive"',
    'D=~/Atum/Drive; rm -rf "${D:-' + 'x'.repeat(600) + '}"',
    'rm -rf "${UNSET:-/Users/fixture/Atum/Drive/' + './'.repeat(300) + '}"',
    'rm -rf "${UNSET:-' + 'x'.repeat(600) + '}"',
    // the positional parameters are any number of words, and are not followed
    "bash -c 'rm -rf \"$@\"' _ ~/Atum/Drive",
    "bash -c 'rm -rf $*' _ ~/Atum/Drive",
    'f() { rm -rf "$@"; }; f ~/Atum/Drive',
    // an array's first word is `$arr`; its words are not followed
    'arr=(~/Atum/Drive); rm -rf "$arr"',
    'arr=(a ~/Atum/Drive); rm -rf "${arr}"',
    'declare -a arr=(~/Atum/Drive); rm -rf $arr',
    'arr=(); arr+=(~/Atum/Drive); rm -rf "$arr"',
    'for f in "${files[@]}"; do rm -rf "$f"; done',
    // the value is carried to where it is used
    'D=~/Atum/Drive; E="${D%/}"; rm -rf "$E"',
    'E="${D%/}"; F=$E; rm -rf "$F"',
    'for f in "${D%/}"; do rm -rf "$f"; done',
    "bash -c 'rm -rf \"$1\"' _ \"${D%/}\"",
    'cd "${D%/}" && rm -rf *',
    'cd "${D%/}" && cd .. && rm -rf *',
    'rm -rf "${UNSET:-${D%/}}"',
    "bash -c 'rm -rf \"${D%/}\"'",
    'eval \'rm -rf "${D%/}"\''
  ])('asks when it cannot read the path of a recursive delete: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    // the same forms outside a recursive delete are ordinary work
    'rm "${D%/}/a.md"',
    'rm -f "${f%.txt}.bak"',
    'unlink "${f%/}"',
    'echo "${D%/}"',
    'ls -la "${D%/}"',
    'cat "${D%/}/notes.md" | wc -l',
    'cp "${f%.txt}.md" /tmp',
    'cp -r "${SRC%/}" "${DST%/}"',
    'mv "${f%.txt}.md" new.md',
    'rsync -a "${SRC%/}/" /tmp/x/',
    'rsync -a --delete "${SRC%/}/" /tmp/backup/',
    'rsync -a --remove-source-files /tmp/x/ "${D%/}/"',
    'find "${D%/}" -type f -print',
    'find "${D%/}" -name "*.tmp" -delete',
    'for f in *.md; do mv "${f%.md}.txt" /tmp; done',
    'for f in *.tmp; do rm -f "${f%.tmp}.log"; done',
    'git commit -m "${MSG%.}"',
    'echo "${#files[@]} files" > /tmp/n',
    'rm "${D:-' + 'x'.repeat(600) + '}"',
    'files=(a b); ls "$files"',
    'files=(a b); echo "$files"; rm -rf /tmp/x',
    'files=(a b); for f in "${files[@]}"; do rm -f "$f"; done'
  ])('leaves it alone when nothing is removed recursively: %j', command => {
    expect(bulk(command)).toBe(false)
  })

  it.each([
    // a variable nothing set cannot be judged, as before; a default or an alternative gives it a value
    'rm -rf "${BUILD_DIR}/out"',
    'rm -rf "$BUILD_DIR/out"',
    'rm -rf "${BUILD_DIR:?}"',
    'rm -rf "${BUILD_DIR?}/out"',
    'rm -rf "${BUILD_DIR:-build}/out"',
    'rm -rf "${BUILD_DIR-build}/out"',
    'rm -rf "${TMPDIR:-/tmp}/x"',
    'rm -rf node_modules "${CACHE:-.cache}"',
    'rm -rf "${UNSET:-/tmp/x}"',
    'rm -rf "${UNSET:=/tmp/x}"',
    'rm -rf "${UNSET:+/Users/fixture/Atum/Drive}"',
    'rm -rf "${UNSET+/Users/fixture/Atum/Drive}"',
    // a set variable, or HOME, with an ordinary folder under the Drive
    'rm -rf "${HOME:?}/Atum/Drive/Q3"',
    'rm -rf "${HOME}/Atum/Drive/Q3/${NAME:-old}"',
    'D=~/Atum/Drive/Q3; rm -rf "${D:-/tmp}"',
    'D=~/Atum/Drive/Q3; rm -rf "${D:?}"/*',
    'rm -rf "${UNSET:-$HOME/Atum/Drive/Q3}"',
    'D=/tmp/x; rm -rf "${D:+$HOME/Atum/Drive/Q3}"',
    'cat "${HOME:?}/Atum/Drive/notes.md"',
    'ls "${D:-.}"',
    'cd "${HOME:?}/Atum/Drive/Q3" && rm -rf *',
    'E=; rm -rf "${E:-/tmp/x}"',
    // a default that is not taken is not read
    'D=/tmp/x; rm -rf "${D:-$HOME/Atum/Drive}"',
    'D=/tmp/x; rm -rf "${D:?$HOME/Atum/Drive}"',
    // `:=` assigns what it uses
    ': "${D:=/tmp/x}"; rm -rf "$D"',
    ': "${D:=~/Atum/Drive/Q3}"; rm -rf "$D"'
  ])('stays silent: %j', command => {
    expect(bulk(command)).toBe(false)
  })

  it.each([
    // the working directories, spelled with a tilde or a variable
    'cd ~/Atum/Drive && rm -rf ~+',
    'cd ~/Atum/Drive && rm -rf ~+/*',
    'cd ~/Atum/Drive && rm -rf "$PWD"',
    'cd ~/Atum/Drive && cd /tmp && rm -rf ~-/*',
    'cd ~/Atum/Drive && cd /tmp && rm -rf "$OLDPWD"',
    'cd ~/Atum/Drive; cd /tmp; rm -rf ${OLDPWD:?}',
    'pushd ~/Atum/Drive > /dev/null; pushd /tmp > /dev/null; rm -rf ~-',
    // the home folder by the owner's name, and a path built on it
    'rm -rf ~fixture/Atum/Drive',
    'rm -rf ~fixture/Atum/Drive/*',
    'rm -rf /Users/$USER/Atum/Drive',
    'rm -rf "/Users/${USER}/Atum/Drive"',
    'rm -rf /Users/$LOGNAME/Atum/Drive/*',
    'rm -rf "/Users/${USER:?}/Atum"',
    'USER=other; USER=fixture; rm -rf /Users/$USER/Atum/Drive',
    'rm -rf ${UNSET:-~fixture}/Atum/Drive'
  ])('reads where the shell is and who it is: gates %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it.each([
    // another user's home, or a directory that is nowhere near the Drive
    'rm -rf ~other/Atum/Drive',
    'rm -rf ~root/Atum/Drive',
    'rm -rf ~+/build',
    'rm -rf ~+/*',
    'cd /tmp && rm -rf ~+/*',
    'rm -rf ~-/x',
    'cd /tmp && cd /var && rm -rf ~-/x',
    'USER=other; rm -rf /Users/$USER/Atum/Drive',
    'rm -rf /Users/$USER/Atum/Drive/Q3',
    'rm -rf "/Users/$USER/Atum Tasks/x"',
    'rm -rf /Users/${LOGNAME:-nobody}/Atum/Drive/Q3',
    "rm -rf '~+/x' '~fixture/Atum/Drive' '$USER'",
    'cd /tmp; rm -rf "$OLDPWD"'
  ])('leaves it alone: %j', command => {
    expect(bulk(command)).toBe(false)
  })

  it('keeps an assignment made in a subshell or a substitution to that scope', () => {
    expect(bulk('(: ${D:=~/Atum/Drive}); rm -rf "$D"')).toBe(false)
    expect(bulk('echo $(: ${D:=~/Atum/Drive}); rm -rf "$D"')).toBe(false)
    expect(bulk('(: ${D:=~/Atum/Drive}; rm -rf "$D")')).toBe(true)
  })

  it('does not read a default twice, or a value as text it is not', () => {
    // The value of a variable is characters: a `$` in it is not expanded again.
    expect(bulk("D='$HOME/Atum/Drive'; rm -rf $D")).toBe(false)
    expect(bulk("D='~/Atum/Drive'; rm -rf $D")).toBe(false)
    expect(bulk('D=\'$HOME\'; rm -rf "${D}/Atum/Drive"')).toBe(false)
  })

  it('follows a default only so far, and stays quick on a text built to make it slow', () => {
    const started = Date.now()

    expect(bulk(`rm -rf "${'${A:-'.repeat(30)}x${'}'.repeat(30)}"`), 'defaults nested beyond what is followed ask').toBe(true)
    expect(bulk(`rm -rf "${'${A:-'.repeat(5)}/tmp/x${'}'.repeat(5)}"`)).toBe(false)
    expect(bulk(`rm -rf ${'${'.repeat(50_000)}`), 'never closed: not read').toBe(true)
    expect(bulk(`rm -rf ${'${A:-'.repeat(20_000)}`)).toBe(true)
    expect(bulk(`rm -rf ${'${X%/}'.repeat(15_000)}`)).toBe(true)
    expect(bulk(`rm -rf ${'$A'.repeat(40_000)}`)).toBe(false)
    expect(Date.now() - started, 'five 100-300 KB texts').toBeLessThan(5000)
  })
})

// A shell expands `~`, a glob and a brace only in unquoted text, and `$VAR` / `${…}` also inside double quotes.
describe('review round 4: quote provenance', () => {
  it.each([
    // single quotes expand nothing: a path that starts with a folder called `~`, or `$HOME`
    "rm -rf '~/Atum/Drive'",
    "rm -rf '$HOME/Atum/Drive'",
    "rm -rf '${HOME}/Atum/Drive'",
    "rm -rf $'~/Atum/Drive'",
    "rm -rf $'$HOME/Atum/Drive'",
    // double quotes expand `$` and nothing else
    'rm -rf "~/Atum/Drive"',
    'rm -rf "\\$HOME/Atum/Drive"',
    'rm -rf "$HOME/Atum/Drive/{*,.*}"',
    'rm -rf "$HOME/Atum/Drive/*"',
    'rm -rf "$HOME/Atum/Drive/.*"',
    'rm -rf "$HOME/Atum/Dr*"',
    'rm -rf "$HOME/At*/Drive"',
    'rm -f "$HOME/Atum/Drive/*"',
    'rm "$HOME/Atum/Drive/*"',
    'rm -rf "/Users/fixture/Atum/Drive/{*,.*}"',
    'rm -rf "/Users/fixture/Atum/Drive/*"',
    'rm -rf "/Users/fixture/Atum/Drive/?"',
    'rm -rf "/Users/fixture/Atum/Drive/[a-z]*"',
    // a backslash expands nothing
    'rm -rf \\~/Atum/Drive',
    'rm -rf /Users/fixture/Atum/Drive/\\*',
    'rm -rf /Users/fixture/Atum/Drive/\\{*,.*\\}',
    'rm -rf /Users/fixture/Atum/Dr\\*',
    // single quotes around the wildcard itself
    "rm -rf '/Users/fixture/Atum/Drive/*'",
    "rm -rf '/Users/fixture/Atum/Drive/{*,.*}'",
    "rm -rf ~/Atum/Drive/'*'",
    "rm -rf ~/Atum/Drive/'.'\\*",
    "rm -rf '/Users/fixture/Atum/Dr*'",
    "rm -rf ~/'At*'",
    'rm -rf "$HOME"/"At*"',
    'rm -rf "$HOME/Atum/Drive"/"*"',
    // a variable that holds a path with a literal tilde
    "D='~/Atum/Drive'; rm -rf $D",
    "D='~/Atum/Drive'; rm -rf \"$D\"",
    'D=\\~/Atum/Drive; rm -rf $D',
    // the quotes of a script protect it from the shell that runs it
    "bash -c \"rm -rf '~/Atum/Drive'\"",
    "bash -c 'rm -rf \"$HOME/Atum/Drive/*\"'",
    "eval \"rm -rf '/Users/fixture/Atum/Drive/*'\"",
    // the same quoted forms of the other programs
    "mv '~/Atum/Drive' /tmp/x",
    "mv '/Users/fixture/Atum/Drive/*' /tmp/x",
    'find "~/Atum/Drive" -delete',
    "rsync -a --delete /tmp/empty/ '~/Atum/Drive/'",
    "echo '~/Atum/Drive' | xargs rm -rf",
    "cd '~/Atum/Drive' && rm -rf *",
    "cd '~' && rm -rf Atum/Drive"
  ])('is not the Drive: %j', command => {
    expect(bulk(command)).toBe(false)
  })

  it.each([
    // text outside the quotes is expanded: a tilde, a glob, a brace, whatever surrounds the quoted part
    'rm -rf ~/"Atum/Drive"',
    'rm -rf ~/"Atum"/"Drive"',
    "rm -rf ~/'Atum'/'Drive'",
    'rm -rf "$HOME/Atum/Drive"/*',
    'rm -rf "$HOME/Atum/Drive"/.*',
    'rm -rf "$HOME/Atum/Drive"/{*,.*}',
    'rm -rf "$HOME/Atum/Drive/"*',
    'rm -rf "$HOME/Atum/Drive/".*',
    'rm -rf "$HOME/Atum/Drive/"{*,.*}',
    'rm -rf "$HOME/Atum/"Dr*',
    'rm -rf "$HOME"/At*/Drive',
    'rm -rf "/Users/fixture/Atum/Drive"/*',
    "rm -rf '/Users/fixture/Atum/Drive'/*",
    "rm -rf '/Users/fixture/Atum/Drive'/{*,.*}",
    "rm -rf '/Users/fixture/Atum/Drive'/'.'*",
    'rm -rf "/Volumes/Old Disk/Drive"/*',
    'rm -rf /Users/fixture/Atum/Dr"i"ve',
    "rm -rf /Users/fixture/Atum/Dr'i'*",
    // a variable's value is expanded where it is used unquoted: a glob in it is a glob
    "D='/Users/fixture/Atum/Drive/*'; rm -rf $D",
    "D='/Users/fixture/Atum/Dr*'; rm -rf $D",
    'D=/Users/fixture/Atum/Drive; rm -rf "$D"/*',
    // eval and a shell's script are read again from the start: what the first shell's quotes protected is not protected there
    'eval rm -rf "~/Atum/Drive"',
    "eval rm -rf '/Users/fixture/Atum/Drive/*'",
    'eval rm -rf \\~/Atum/Drive',
    "bash -c 'rm -rf ~/Atum/Drive'",
    "bash -c 'rm -rf \"$HOME\"/Atum/Drive/*'",
    "bash -c 'rm -rf \"$1\"' _ '/Users/fixture/Atum/Drive'",
    // a find pattern is find's, not the shell's
    "find ~/Atum/Drive -name '*' -delete",
    'find ~/Atum/Drive -name "*" -delete',
    'find ~/Atum/Drive -iname \'*\' -exec rm {} +',
    // xargs replaces its placeholder however it was quoted
    'ls -A ~/Atum/Drive | xargs -I{} rm -rf "$HOME/Atum/Drive/{}"',
    "ls -A ~/Atum/Drive | xargs -I{} rm -rf '/Users/fixture/Atum/Drive/{}'",
    // a loop variable stands for the names in its list, however it is quoted
    'cd ~/Atum/Drive; for f in *; do rm -rf -- "$f"; done',
    "cd ~/Atum/Drive; for f in '*'; do rm -rf $f; done"
  ])('is still the Drive: %j', command => {
    expect(bulk(command)).toBe(true)
  })

  it('matches a root whose name holds a glob character, now that quoting says it is literal', () => {
    const odd: DriveDeleteContext = { ...context, roots: ['/Volumes/Disk [1]/Drive', '/Volumes/a*b/Drive'] }

    expect(deletesDriveInBulk('rm -rf "/Volumes/Disk [1]/Drive"', odd)).toBe(true)
    expect(deletesDriveInBulk('rm -rf "/Volumes/Disk [1]/Drive"/*', odd)).toBe(true)
    expect(deletesDriveInBulk('rm -rf "/Volumes/a*b/Drive"', odd)).toBe(true)
    expect(deletesDriveInBulk("rm -rf '/Volumes/a*b/Drive/Q3'", odd)).toBe(false)
    expect(deletesDriveInBulk('rm -rf "/Volumes/Disk [1]/Drive/Q3"', odd)).toBe(false)
  })

  it('tells a quoted wildcard from a real one in the same word, whichever way they are mixed', () => {
    const word = (quoted: string, plain: string) => `rm -rf ${quoted}${plain}`

    expect(bulk(word('"/Users/fixture/Atum/Drive/"', '*'))).toBe(true)
    expect(bulk(word('"/Users/fixture/Atum/Drive/*"', ''))).toBe(false)
    expect(bulk(word("'/Users/fixture/Atum/Drive/'", '.*'))).toBe(true)
    expect(bulk(word("'/Users/fixture/Atum/Drive/.*'", ''))).toBe(false)
    expect(bulk(word('/Users/fixture/Atum/Drive/\\*', '*'))).toBe(false)
    expect(bulk(word('/Users/fixture/Atum/Drive/', '\\**'))).toBe(false)
  })
})

describe('review round 4: heredoc bodies are data unless a shell runs them', () => {
  /** `<consumer> <<'EOF'`, a delete of the Drive as the body, and the delimiter. */
  const heredoc = (consumer: string, body = 'rm -rf ~/Atum/Drive') => `${consumer} <<'EOF'\n${body}\nEOF`

  it.each([
    'cat',
    'cat > notes.md',
    'tee notes.md',
    'sudo tee /etc/hosts',
    'python3 -',
    'node -',
    'psql',
    'git commit -F -',
    'bash script.sh',
    'bash -c cat',
    'source ./env.sh',
    'ssh host cat',
    'docker exec -i db psql',
    'xargs echo'
  ])('is data for %j', consumer => {
    expect(bulk(heredoc(consumer))).toBe(false)
    expect(bulk(heredoc(consumer, 'rm -rf ~/Atum/Drive/*')), 'a wildcard of it too').toBe(false)
  })

  it.each([
    'bash',
    'sh',
    'zsh',
    'dash',
    'ksh',
    'bash -s',
    'bash -x',
    'bash -o errexit',
    'sudo bash',
    'sudo -u root sh -s',
    'env A=1 bash',
    'nohup sh',
    'eval',
    'source /dev/stdin',
    '. /dev/stdin',
    'ssh host',
    'ssh host bash',
    "ssh host 'bash -s'",
    'xargs sh',
    'docker exec -i c sh',
    'kubectl exec -i pod -- bash'
  ])('is a script for %j', consumer => {
    expect(bulk(heredoc(consumer))).toBe(true)
    expect(bulk(`${consumer} <<EOF\nrm -rf ~/Atum/Drive\nEOF`), 'whether or not the delimiter is quoted').toBe(true)
  })

  it('is a script when it is piped on to a shell, or handed to one as text', () => {
    for (const command of [
      "cat <<'EOF' | bash\nrm -rf ~/Atum/Drive\nEOF",
      "cat <<'EOF' | sh -s\nrm -rf ~/Atum/Drive\nEOF",
      "cat <<'EOF' | sudo bash\nrm -rf ~/Atum/Drive\nEOF",
      "cat <<'EOF' | tee x.sh | sh\nrm -rf ~/Atum/Drive\nEOF",
      "cat <<'EOF' | ssh host\nrm -rf ~/Atum/Drive\nEOF",
      "bash -c \"$(cat <<'EOF'\nrm -rf ~/Atum/Drive\nEOF\n)\"",
      "sh -c \"$(cat <<'EOF'\nrm -rf ~/Atum/Drive\nEOF\n)\"",
      "eval \"$(cat <<'EOF'\nrm -rf ~/Atum/Drive\nEOF\n)\"",
      "source <(cat <<'EOF'\nrm -rf ~/Atum/Drive\nEOF\n)",
      "ssh host \"$(cat <<'EOF'\nrm -rf ~/Atum/Drive\nEOF\n)\""
    ]) {
      expect(bulk(command), JSON.stringify(command)).toBe(true)
    }

    for (const command of [
      "cat <<'EOF' | tee notes.md\nrm -rf ~/Atum/Drive\nEOF",
      "cat <<'EOF' | grep rm\nrm -rf ~/Atum/Drive\nEOF",
      "cat <<'EOF' > run.sh; bash run.sh\nrm -rf ~/Atum/Drive\nEOF",
      "git commit -m \"$(cat <<'EOF'\nrun rm -rf ~/Atum/Drive\nEOF\n)\"",
      "gh pr create --body \"$(cat <<'EOF'\nrm -rf ~/Atum/Drive/*\nEOF\n)\""
    ]) {
      expect(bulk(command), JSON.stringify(command)).toBe(false)
    }
  })

  it('still reads the commands around a data heredoc, and the substitutions an unquoted delimiter runs', () => {
    expect(bulk("cat > notes.md <<'EOF'\ndon't forget\nEOF\nrm -rf ~/Atum/Drive")).toBe(true)
    expect(bulk("rm -rf ~/Atum/Drive/Q3 <<'EOF'\nrm -rf ~/Atum/Drive\nEOF\nls")).toBe(false)
    expect(bulk('cat <<EOF\n$(rm -rf ~/Atum/Drive)\nEOF')).toBe(true)
    expect(bulk('cat <<EOF\nrun `rm -rf ~/Atum/Drive`\nEOF')).toBe(true)
    expect(bulk("cat <<'EOF'\n$(rm -rf ~/Atum/Drive)\nEOF")).toBe(false)
    expect(bulk('cat <<EOF\nprose: rm -rf ~/Atum/Drive\nEOF')).toBe(false)
  })
})

describe('review round 4: ordinary work stays quiet', () => {
  // Strings that were silent before this round, and must still be: every kind of quote, expansion and heredoc around the Drive.
  it.each([
    'rm -rf node_modules dist',
    'rm -rf "$HOME/Atum/Drive/Q3"',
    "rm -rf '/Users/fixture/Atum/Drive/Q3'",
    'rm -rf ~/Atum/Drive/Q3/"old files"',
    'rm -rf ~/Atum/Drive/Q3/old\\ files',
    'rm -rf "${HOME}/Atum/Drive/Q3/drafts/"',
    'rm -f ~/Atum/Drive/Q3/*.tmp',
    'rm -f "$HOME/Atum/Drive/Q3/"*.tmp',
    'rm -rf ./build/* ./dist/*',
    'ls "$HOME/Atum/Drive"',
    'ls -la ~/Atum/Drive/* | head',
    'cat "$HOME/Atum/Drive/notes.md"',
    'cp -r "$HOME/Atum/Drive/Q3" /tmp/q3',
    'mv "$HOME/Atum/Drive/a.md" "$HOME/Atum/Drive/b.md"',
    'mv ~/Atum/Drive/Q3/* ~/Atum/Drive/Q4/',
    'find "$HOME/Atum/Drive" -name "*.tmp" -delete',
    "find ~/Atum/Drive -name '*.bak' -exec rm {} +",
    'rsync -a "$HOME/Atum/Drive/" /tmp/backup/',
    "grep -rn 'rm -rf ~/Atum/Drive' docs/",
    'echo "rm -rf ~/Atum/Drive"',
    'git commit -m "docs: never rm -rf ~/Atum/Drive"',
    "cat > notes.md <<'EOF'\nrm -rf ~/Atum/Drive\nEOF",
    "cat <<'EOF' > ~/Atum/Drive/Q3/readme.md\nDon't run rm -rf ~/Atum/Drive here.\nEOF\nls",
    'cat <<EOF > ~/Atum/Drive/Q3/runbook.md\nTo reset: rm -rf ~/Atum/Drive\nEOF',
    "python3 - <<'PY'\nimport shutil\nshutil.rmtree('/Users/fixture/Atum/Drive')\nPY",
    "git commit -F - <<'EOF'\nrm -rf ~/Atum/Drive\nEOF",
    'for f in ~/Atum/Drive/*.md; do wc -l "$f"; done',
    'for f in ~/Atum/Drive/Q3/*; do rm -f "$f"; done',
    'sed -i "" "s/a/b/" ~/Atum/Drive/notes.md',
    'D=~/Atum/Drive/Q3; rm -rf "$D"',
    'D=~/Atum/Drive; ls "$D"; rm -rf "$D/Q3"',
    'rm -rf "${BUILD:-build}" "${OUT:-out}.tmp"'
  ])('stays silent: %j', command => {
    expect(bulk(command)).toBe(false)
  })
})
