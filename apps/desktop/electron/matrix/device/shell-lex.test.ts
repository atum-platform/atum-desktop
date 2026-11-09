import { describe, expect, it } from 'vitest'

import { BRACE_LIMIT, expandBraces, lexShell, markLiteral, matchBrace, ShellDepthError, unmark } from './shell-lex'

/** Commands as word lists, with the scope edges of subshells and substitutions as 'enter' / 'leave'. */
const lex = (text: string) => lexShell(text).map(item => (typeof item === 'string' ? item : item.words))

/** The first word of every command lexed, in order. */
const programs = (text: string) => lexShell(text).flatMap(item => (typeof item === 'string' ? [] : [item.words[0]]))

/** The marked words of the command the text ends with (substitutions come before it), each literal character shown behind a backslash (`'~/x'` → `\~/x`). */
const marked = (text: string) => {
  const last = lexShell(text).findLast(item => typeof item !== 'string')

  if (typeof last === 'string' || !last) {
    return []
  }

  return last.marked.map((word, at) => {
    const original = [...last.words[at]!]

    return [...word].map((character, index) => (character === original[index] ? character : `\\${original[index]}`)).join('')
  })
}

describe('lexShell: where one command ends and the next begins', () => {
  it.each([
    ['a;b', [['a'], ['b']]],
    ['a\nb', [['a'], ['b']]],
    ['a && b || c', [['a'], ['b'], ['c']]],
    ['a | b |& c', [['a'], ['b'], ['c']]],
    ['true & rm x', [['true'], ['rm', 'x']]],
    ['x &rm x', [['x'], ['rm', 'x']]],
    ['a& b', [['a'], ['b']]],
    ['a;;b', [['a'], ['b']]],
    ['  a   b  ', [['a', 'b']]],
    ['a \\\n b', [['a', 'b']]],
    ['rm -rf \\\n  x', [['rm', '-rf', 'x']]]
  ])('splits %j', (text, expected) => {
    expect(lex(text)).toEqual(expected)
  })

  it('marks what is piped into the next command', () => {
    const items = lexShell('a | b || c & d |& e')

    expect(items.map(item => (typeof item === 'string' ? item : `${item.words[0]}:${item.piped}`))).toEqual(['a:true', 'b:false', 'c:false', 'd:true', 'e:false'])
  })

  it('reads (…), $(…), backticks and <(…) as commands of their own inside a scope', () => {
    expect(lex('(cd x && rm y)')).toEqual(['enter', ['cd', 'x'], ['rm', 'y'], 'leave'])
    expect(lex('echo $(rm -rf x) tail')).toEqual(['enter', ['rm', '-rf', 'x'], 'leave', ['echo', '$(rm -rf x)', 'tail']])
    expect(lex('echo `rm -rf x`')).toEqual(['enter', ['rm', '-rf', 'x'], 'leave', ['echo', '`rm -rf x`']])
    expect(lex('diff <(ls a) >(cat) b')).toEqual(['enter', ['ls', 'a'], 'leave', 'enter', ['cat'], 'leave', ['diff', '<(ls a)', '>(cat)', 'b']])
    expect(lex('echo "$(rm x) and `rm y`"')).toEqual(['enter', ['rm', 'x'], 'leave', 'enter', ['rm', 'y'], 'leave', ['echo', '$(rm x) and `rm y`']])
    expect(lex('echo $(echo $(rm x))')).toEqual(['enter', 'enter', ['rm', 'x'], 'leave', ['echo', '$(rm x)'], 'leave', ['echo', '$(echo $(rm x))']])
  })

  it('does not run arithmetic, and keeps ${…} whole', () => {
    expect(lex('echo $((1+2)) x')).toEqual([['echo', '$((1+2))', 'x']])
    expect(lex('echo ${A:-a b;c} z')).toEqual([['echo', '${A:-a b;c}', 'z']])
    expect(lex('echo ${#A} $# a#b')).toEqual([['echo', '${#A}', '$#', 'a#b']])
  })

  it('reads a substitution inside ${…} as a command of its own: it runs when the expansion needs its default', () => {
    expect(lex('echo ${A:-$(sudo id)} z')).toEqual(['enter', ['sudo', 'id'], 'leave', ['echo', '${A:-$(sudo id)}', 'z']])
    expect(lex('echo "${A:-`rm x`}"')).toEqual(['enter', ['rm', 'x'], 'leave', ['echo', '${A:-`rm x`}']])
    expect(lex('echo ${A:-${B:-$(rm x)}}')).toEqual(['enter', ['rm', 'x'], 'leave', ['echo', '${A:-${B:-$(rm x)}}']])
    expect(lex('echo ${A:-$(rm x) $(rm y)}')).toEqual(['enter', ['rm', 'x'], 'leave', 'enter', ['rm', 'y'], 'leave', ['echo', '${A:-$(rm x) $(rm y)}']])
    expect(lex('echo ${A:-\\$(rm x)}'), 'an escaped $ runs nothing').toEqual([['echo', '${A:-\\$(rm x)}']])
  })

  it('follows a ${…} only up to a window; past it the text is read as shell, so a command in it is still seen', () => {
    const lexed = lex(`echo \${A:-${'x'.repeat(600)}; sudo id}`)

    expect(lexed.some(item => Array.isArray(item) && item[0] === 'sudo')).toBe(true)
    expect(lex(`echo \${A:-${'x'.repeat(100)}}`), 'a short one is kept whole').toEqual([['echo', `\${A:-${'x'.repeat(100)}}`]])
  })

  it('reads a text of a hundred thousand unmatched ${ without rescanning to its end at each', () => {
    const started = Date.now()

    expect(() => lexShell('${'.repeat(100_000))).not.toThrow()
    expect(() => lexShell('"${'.repeat(100_000))).not.toThrow()
    expect(Date.now() - started, 'two 200-300 KB texts').toBeLessThan(5000)
  })
})

describe('lexShell: what is not a separator or a command', () => {
  it('keeps quoted and escaped separators in their word', () => {
    expect(lex('echo "a;b" \'c|d\' e\\ f \\; "g&h"')).toEqual([['echo', 'a;b', 'c|d', 'e f', ';', 'g&h']])
    expect(lex('rm -rf "/Volumes/R&D (2)/Drive"')).toEqual([['rm', '-rf', '/Volumes/R&D (2)/Drive']])
    expect(lex('echo "it\'s" \'say "hi"\' "q\\"q"')).toEqual([['echo', "it's", 'say "hi"', 'q"q']])
    expect(lex('r""m x')).toEqual([['rm', 'x']])
  })

  it('drops redirections with their target, but not a here-string', () => {
    expect(lex('cat <in >out 2>err')).toEqual([['cat']])
    expect(lex('cmd 2>&1 >&2 &>both &>>more')).toEqual([['cmd']])
    expect(lex('echo hi > "a b" && ls')).toEqual([['echo', 'hi'], ['ls']])
    expect(lex('echo 2 >f 3> g')).toEqual([['echo', '2']])
    expect(lex('bash <<< "rm -rf x"')).toEqual([['bash', '<<<', 'rm -rf x']])
    expect(lex('echo $(mktemp) > $(mktemp)')).toEqual(['enter', ['mktemp'], 'leave', 'enter', ['mktemp'], 'leave', ['echo', '$(mktemp)']])
  })

  it('ignores a comment, and an apostrophe in it', () => {
    expect(lex("rm a # don't\nrm b")).toEqual([['rm', 'a'], ['rm', 'b']])
    expect(lex('# only a comment')).toEqual([])
    expect(lex('echo a#b "#c"')).toEqual([['echo', 'a#b', '#c']])
  })

  it('reads the heredoc body of a shell line by line as commands in a scope, so prose cannot swallow what follows', () => {
    expect(lex("bash <<EOF > f\ndon't\nrm -rf x\nEOF\nrm y")).toEqual([['bash'], 'enter', ['dont'], ['rm', '-rf', 'x'], 'leave', ['rm', 'y']])
    expect(lex("sh <<'EOF'\nit's\nEOF\nls")).toEqual([['sh'], 'enter', ['its'], 'leave', ['ls']])
    expect(lex('bash <<-EOF\n\tbody\n\tEOF\nls')).toEqual([['bash'], 'enter', ['body'], 'leave', ['ls']])
    expect(lex('bash <<EOF\nrm -rf x\nEOF')).toEqual([['bash'], 'enter', ['rm', '-rf', 'x'], 'leave'])
    expect(lex('bash <<A <<B\none\nA\ntwo\nB\nls')).toEqual([['bash'], 'enter', ['one'], 'leave', 'enter', ['two'], 'leave', ['ls']])
    expect(lex('bash <<EOF\nunfinished')).toEqual([['bash'], 'enter', ['unfinished'], 'leave'])
  })

  // Review round 4 (2026-10-24, P1): a heredoc body is data unless a shell runs it. `cat > notes.md <<'EOF'` with
  // `sudo id` inside asked for the administrator's Touch ID, and so did inert `rm -rf ~` prose.
  it('reads the heredoc body of any other command as data: the commands after it are still read', () => {
    expect(lex("cat <<EOF > f\ndon't\nrm -rf x\nEOF\nrm y")).toEqual([['cat'], ['rm', 'y']])
    expect(lex("cat <<'EOF'\nit's\nEOF\nls")).toEqual([['cat'], ['ls']])
    expect(lex('cat <<-EOF\n\tbody\n\tEOF\nls')).toEqual([['cat'], ['ls']])
    expect(lex('cat <<A <<B\none\nA\ntwo\nB\nls')).toEqual([['cat'], ['ls']])
    expect(lex('cat <<EOF\nunfinished')).toEqual([['cat']])
    expect(lex("cat > notes.md <<'EOF'\nsudo id\nrm -rf ~\nEOF")).toEqual([['cat']])
  })

  it('runs an unterminated quote or substitution to the end rather than throwing', () => {
    expect(lex('echo "abc')).toEqual([['echo', 'abc']])
    expect(lex("echo 'abc")).toEqual([['echo', 'abc']])
    expect(lex('echo $(rm x')).toEqual(['enter', ['rm', 'x'], 'leave', ['echo', '$(rm x']])
    expect(lex('echo `rm x')).toEqual(['enter', ['rm', 'x'], 'leave', ['echo', '`rm x']])
  })

  it('stops following nesting past its limit', () => {
    expect(() => lexShell('$('.repeat(12) + 'rm x' + ')'.repeat(12))).toThrow(ShellDepthError)
    expect(() => lexShell('$('.repeat(4) + 'rm x' + ')'.repeat(4))).not.toThrow()
  })
})

// Review round 4 (2026-10-24, P1): a heredoc body is data unless the command that reads it is a shell.
describe('lexShell: which heredoc bodies a shell reads', () => {
  /** `<consumer> <<EOF`, a body that names a program no consumer here runs, and the delimiter. */
  const heredoc = (consumer: string) => `${consumer} <<EOF\nzzbody id\nEOF`

  it.each([
    // the interpreters, in every spelling of the invocation that reads the script from the standard input
    'bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', '/bin/bash', 'BASH', 'bash -s', 'bash -s -- a b', 'bash -', 'bash -x', 'bash -l', 'bash -o errexit', 'bash +o history', 'sh -e -u',
    // through a wrapper
    'sudo bash', 'sudo -u root bash -s', 'env bash', 'env A=1 sh', 'nohup bash', 'time bash', 'timeout 5 bash', 'nice -n 5 sh', 'command bash', 'exec bash',
    // eval and source
    'eval', 'eval "$(cat)"', 'source /dev/stdin', '. /dev/stdin', 'source /dev/fd/0', 'builtin source /dev/stdin',
    // a program that runs one
    'ssh host', 'ssh -p 22 host', 'ssh -o StrictHostKeyChecking=no user@host', 'ssh host bash', "ssh host 'bash -s'", 'ssh -t host sudo bash', 'ssh host sh -s',
    'ssh host -tt', 'ssh host -o BatchMode=yes', 'ssh host -- bash', 'ssh -tt host -p 22 bash',
    // a shell with no program word: an administrator's or another user's login shell
    'sudo -s', 'sudo -i', 'sudo -u root -i', 'sudo -is', 'sudo --shell', 'sudo --login', 'doas -s', 'su', 'su -', 'su - root', 'su root',
    'xargs sh', 'xargs -n1 bash', 'xargs -I{} sh',
    'docker exec -i c sh', 'docker run -i --rm alpine sh', 'kubectl exec -i pod -- bash', 'podman exec -i c bash',
    'at now'
  ])('runs a heredoc given to %j as commands', consumer => {
    expect(programs(heredoc(consumer)), JSON.stringify(heredoc(consumer))).toContain('zzbody')
  })

  it.each([
    'cat', 'cat > notes.md', 'tee notes.md', 'sudo tee /etc/hosts', 'python3 -', 'node -', 'psql', 'sqlite3 db', 'git commit -F -', 'gh pr create --body-file -', 'mysql', 'grep x', 'wc -l', 'sort',
    'crontab -', 'osascript',
    // a shell that is given something else to run: a script file, a `-c` text
    'bash script.sh', 'bash ./deploy.sh --flag', 'bash -x script.sh', 'sh -- script.sh', 'bash -c cat', "bash -c 'cat'", 'zsh -lc cat',
    // source of a file, not of the standard input
    'source ./env.sh', '. ./env.sh',
    // a program that runs something that is not a shell
    'ssh host cat', 'ssh host tee x', 'docker exec -i db psql', 'xargs echo', 'xargs -n1 wc -l', 'ssh host -tt cat',
    // a privilege prefix with something else to do, or nothing that starts a shell
    'sudo -v', 'sudo -l', 'sudo -k', 'su -c cat', 'su root -c cat', 'su -lc cat', 'su --command=cat', 'sudo tee x'
  ])('reads a heredoc given to %j as data', consumer => {
    expect(programs(heredoc(consumer)), JSON.stringify(heredoc(consumer))).not.toContain('zzbody')
  })

  it.each([
    'cat <<EOF | bash',
    'cat <<EOF | sh -s',
    'cat <<EOF | sudo bash',
    'cat <<EOF | tee script.sh | sh',
    'cat <<EOF | ssh host',
    'cat <<EOF | ssh host bash',
    'cat <<EOF |& zsh',
    'cat <<EOF | xargs sh',
    'cat <<EOF | env A=1 bash',
    'cat <<EOF|bash',
    'cat <<EOF | bash # comment'
  ])('runs a heredoc piped on to a shell: %j', line => {
    expect(programs(`${line}\nzzbody id\nEOF`)).toContain('zzbody')
  })

  it.each([
    'cat <<EOF | tee out.txt',
    'cat <<EOF | grep x',
    'cat <<EOF | wc -l',
    'cat <<EOF | sort | uniq',
    'cat <<EOF > out.sh; bash out.sh',
    'cat <<EOF && bash out.sh',
    'cat <<EOF | tee out.sh && bash out.sh'
  ])('reads a heredoc as data when no shell is in its pipeline: %j', line => {
    expect(programs(`${line}\nzzbody id\nEOF`)).not.toContain('zzbody')
  })

  it('knows which command of a line a heredoc belongs to', () => {
    // The heredoc is cat's; bash is on the same line but not fed by it.
    expect(programs('cat <<EOF; bash\nsudo id\nEOF')).not.toContain('sudo')
    expect(programs('bash <<EOF; cat\nsudo id\nEOF')).toContain('sudo')
    expect(programs('cat <<A | bash <<B\nsudo id\nA\nrm x\nB')).toEqual(['cat', 'bash', 'sudo', 'rm'])
    expect(programs('cat <<A; bash <<B\nsudo id\nA\nrm x\nB')).toEqual(['cat', 'bash', 'rm'])
    // a body that follows another heredoc's, on the same line
    expect(programs('bash <<A <<B\nsudo id\nA\nsudo -v\nB')).toEqual(['bash', 'sudo', 'sudo'])
  })

  it('runs the heredoc in a substitution that a shell, eval or source is handed, and not in any other', () => {
    const inside = (outer: (substitution: string) => string) => outer("$(cat <<'EOF'\nsudo id\nEOF\n)")

    for (const outer of [
      (s: string) => `bash -c "${s}"`,
      (s: string) => `sh -c "${s}"`,
      (s: string) => `eval "${s}"`,
      (s: string) => `eval ${s}`,
      (s: string) => `sudo bash -c "${s}"`,
      (s: string) => `ssh host "${s}"`,
      (s: string) => `docker exec c sh -c "${s}"`,
      (s: string) => `source <(${s.slice(2, -1)})`,
      (s: string) => `. <(${s.slice(2, -1)})`
    ]) {
      expect(programs(inside(outer)), JSON.stringify(inside(outer))).toContain('sudo')
    }

    for (const outer of [
      (s: string) => `git commit -m "${s}"`,
      (s: string) => `gh pr create --body "${s}"`,
      (s: string) => `echo "${s}"`,
      (s: string) => `cat <(${s.slice(2, -1)})`,
      (s: string) => `NOTE="${s}"`
    ]) {
      expect(programs(inside(outer)), JSON.stringify(inside(outer))).not.toContain('sudo')
    }
  })

  it('keeps the commands after a data heredoc, and the one that closes it on a line of its own', () => {
    expect(programs("cat <<'EOF'\nrm -rf ~\nEOF\nls")).toEqual(['cat', 'ls'])
    expect(programs("cat <<-'EOF'\n\trm -rf ~\n\tEOF\nls")).toEqual(['cat', 'ls'])
    expect(programs("cat <<'EOF'\nEOF\nrm -rf x")).toEqual(['cat', 'rm'])
    expect(programs("cat <<'EOF'\nrm -rf ~\nEOF extra\nEOF\nls")).toEqual(['cat', 'ls'])
  })

  it('still runs what the body of an unquoted delimiter expands itself: $(…) and backticks', () => {
    expect(programs('cat <<EOF\nhello $(sudo id)\nEOF')).toContain('sudo')
    expect(programs('cat <<EOF\nhello `sudo id`\nEOF')).toContain('sudo')
    expect(programs('cat <<EOF\n${X:-$(sudo id)}\nEOF')).toContain('sudo')
    expect(programs('cat <<-EOF\n\t$(sudo id)\n\tEOF')).toContain('sudo')
    expect(programs('cat <<EOF\none\nrun $(\nsudo id\n)\nEOF')).toContain('sudo')
    // Prose around it is still prose.
    expect(programs('cat <<EOF\nrm -rf ~ and sudo id, then $(date)\nEOF')).toEqual(['cat', 'date'])

    // Nothing runs when the delimiter is quoted or escaped (however much of it is), or the `$` is escaped.
    for (const delimiter of ["'EOF'", '"EOF"', '\\EOF', 'E"O"F', "E'O'F"]) {
      expect(programs(`cat <<${delimiter}\n$(sudo id) \`sudo id\`\nEOF`), delimiter).toEqual(['cat'])
    }

    expect(programs('cat <<EOF\nprice \\$(sudo id) and \\`sudo id\\`\nEOF')).toEqual(['cat'])
  })
})

// Review round 4: the shell expands `~`, `$`, a glob and a brace only where they are not quoted. The lexer keeps the
// words as it did, and says in `marked` which characters the shell did not expand.
describe('lexShell: what the shell would not expand is marked literal', () => {
  it.each([
    // a tilde
    ['echo \'~/x\' "~/y" ~/z \\~/w "~"/v ~/"u"', ['echo', '\\~/x', '\\~/y', '~/z', '\\~/w', '\\~/v', '~/u']],
    // a dollar: double quotes keep it, single quotes, a backslash and $'…' do not
    ['echo "$HOME/x" \'$HOME/x\' "\\$HOME/x" $\'$HOME/x\' \\$HOME/x $HOME/x', ['echo', '$HOME/x', '\\$HOME/x', '\\$HOME/x', '\\$HOME/x', '\\$HOME/x', '$HOME/x']],
    // a glob: only unquoted text has one
    ['echo "a/*" \'a/*\' a/* a/\\* "a/"* a/"*" "x?" [a] "[a]"', ['echo', 'a/\\*', 'a/\\*', 'a/*', 'a/\\*', 'a/*', 'a/\\*', 'x\\?', '[a]', '\\[a]']],
    // a brace group
    ['echo "{a,b}" \'{a,b}\' {a,b} \\{a,b} "x{1..3}" y{1..3}', ['echo', '\\{a,b}', '\\{a,b}', '{a,b}', '\\{a,b}', 'x\\{1..3}', 'y{1..3}']],
    // `${…}` and substitutions are the shell's own syntax: kept as written, wherever they are
    ['echo "${HOME:-/x}" ${A:-"b c"} \'${A}\'', ['echo', '${HOME:-/x}', '${A:-"b c"}', '\\$\\{A}']],
    ['echo "$(pwd)/*" $(pwd)/* "`pwd`/{a,b}"', ['echo', '$(pwd)/\\*', '$(pwd)/*', '`pwd`/\\{a,b}']],
    // an escaped character in double quotes, and a lone backslash
    ['echo "a\\$b" "a\\\\b" "a\\qb"', ['echo', 'a\\$b', 'a\\b', 'a\\qb']],
    // a `${` that is never closed keeps its `{` as syntax in double quotes, and is literal in single quotes
    ['echo "${A" \'${A\' ${A', ['echo', '${A', '\\$\\{A', '${A']]
  ])('marks %j', (text, expected) => {
    expect(marked(text)).toEqual(expected)
  })

  it('marks every word of a command the way it keeps it: same count, same words', () => {
    const TEXTS = [
      'rm -rf "$HOME"/Atum/Drive/{*,.*}',
      "bash <<< 'rm -rf ~/Atum/Drive'",
      'cat <in >out 2>err',
      'cmd 2>&1 >&2 &>both &>>more',
      'echo $(mktemp) > $(mktemp)',
      'echo "$(rm x) and `rm y`"',
      'diff <(ls a) >(cat) b',
      'echo ${A:-$(sudo id)} z',
      "r''m x$'y'\"z\"",
      'FOO="a b" BAR=\'c d\' env sudo -u x id',
      'a;b\nc && d || e | f',
      'for d in ~/Atum/Drive/*/; do rm -rf "$d/tmp"; done',
      'echo \\\n a',
      'echo "unterminated',
      "echo 'unterminated",
      'echo $(unterminated',
      '2>f echo a',
      'a=1 b=\'$x\' c="~" d=\\* e'
    ]

    for (const text of TEXTS) {
      for (const item of lexShell(text)) {
        if (typeof item !== 'string') {
          expect(item.marked, JSON.stringify(text)).toHaveLength(item.words.length)
          expect(item.marked.map(unmark), JSON.stringify(text)).toEqual(item.words)
        }
      }
    }
  })

  it('gives back the characters of a marked text exactly, and leaves any other text alone', () => {
    for (const text of ['', 'plain', '~/x', '$HOME/*', '{a,b}?[c]', 'a b\n', '\\*', '$(x)']) {
      expect(unmark(markLiteral(text)), JSON.stringify(text)).toBe(text)
      expect(unmark(text), 'no stand-in in it').toBe(text)
    }

    expect(markLiteral('~$*?[{')).toHaveLength(6)
    expect(markLiteral('~$*?[{')).not.toMatch(/[~$*?[{]/)
    expect(markLiteral('~$*', true), 'double quotes keep the dollar').toMatch(/^[^~]\$[^*]$/)
    expect(markLiteral('a/b.c')).toBe('a/b.c')
  })
})

describe('matchBrace', () => {
  it('finds the end of a ${…} that holds braces, quotes and escapes, and gives up on an unmatched one', () => {
    expect(matchBrace('${a}', 1)).toBe(3)
    expect(matchBrace('${a:-${b}}x', 1)).toBe(9)
    expect(matchBrace('${a:-"}"}x', 1)).toBe(8)
    expect(matchBrace("${a:-'}'}x", 1)).toBe(8)
    expect(matchBrace('${a:-\\}}x', 1)).toBe(7)
    expect(matchBrace('${a', 1)).toBe(-1)
    expect(matchBrace(`\${${'x'.repeat(600)}}`, 1), 'beyond its window').toBe(-1)
  })
})

describe('expandBraces', () => {
  it.each([
    ['a{b,c}d', ['abd', 'acd']],
    ['{*,.*}', ['*', '.*']],
    ['~/Atum/Drive/{*,.*}', ['~/Atum/Drive/*', '~/Atum/Drive/.*']],
    ['{a,{b,c}}', ['a', 'b', 'c']],
    ['x{a,b{1,2}}y', ['xay', 'xb1y', 'xb2y']],
    ['{a,b}{1,2}', ['a1', 'a2', 'b1', 'b2']],
    ['{,a}', ['', 'a']],
    ['~/Atum/{Drive,Other}/x', ['~/Atum/Drive/x', '~/Atum/Other/x']],
    ['{1..3}', ['1', '2', '3']],
    ['{3..1}', ['3', '2', '1']],
    ['{c..a}', ['c', 'b', 'a']],
    ['{01..03}', ['01', '02', '03']],
    ['{1..10..4}', ['1', '5', '9']],
    ['f{1..2}.md', ['f1.md', 'f2.md']]
  ])('expands %j', (word, expected) => {
    expect(expandBraces(word)).toEqual(expected)
  })

  it.each(['plain', '{a}', '{}', 'a{b', 'a}b', '${A,b}', '${A:-x,y}/z', '{x}y', '{{a}}'])('leaves %j alone, as bash does', word => {
    expect(expandBraces(word)).toEqual([word])
  })

  it('treats the nested single-part group inside a group as literal braces', () => {
    expect(expandBraces('{{a,b}}')).toEqual(['{a}', '{b}'])
  })

  it('gives up on a long word with a brace in it, and not on a long word without one', () => {
    expect(expandBraces('{'.repeat(5000))).toBeNull()
    expect(expandBraces(`${'a'.repeat(5000)}{b,c}`)).toBeNull()
    expect(expandBraces('a'.repeat(5000))).toEqual(['a'.repeat(5000)])
  })

  it('gives up past its limit or on a sequence it cannot read', () => {
    expect(expandBraces('x{1..100}')).toBeNull()
    expect(expandBraces('{a,b}'.repeat(7))).toBeNull()
    expect(expandBraces('{a,b}'.repeat(6))).toHaveLength(BRACE_LIMIT)
    expect(expandBraces('{a..zz}')).toBeNull()
    expect(expandBraces('{1..3..}')).toBeNull()
    expect(expandBraces('{ab..cd}/z')).toBeNull()
    expect(expandBraces('{x..y}/z'), 'a letter range is readable').toEqual(['x/z', 'y/z'])
  })
})
