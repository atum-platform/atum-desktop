import { describe, expect, it } from 'vitest'

import type { DeviceProtectedCapability } from './contracts'
import { classifyCommand, classifyExecute, toolScope } from './policy'

/** A Drive root, so the Drive-aware detector reads every string a second time: what is ordinary stays ordinary with a Drive on the Mac. */
const DRIVE = { home: '/Users/fixture', roots: ['/Users/fixture/Atum/Drive'] }

describe('toolScope maps each tool to its base capability', () => {
  it('terminal → terminal, file tools → files, computer_use → computer, send_file → send_file', () => {
    expect(toolScope('terminal')).toBe('terminal')
    expect(toolScope('read_file')).toBe('files')
    expect(toolScope('write_file')).toBe('files')
    expect(toolScope('patch')).toBe('files')
    expect(toolScope('search_files')).toBe('files')
    expect(toolScope('computer_use')).toBe('computer')
    expect(toolScope('send_file')).toBe('send_file')
  })
})

describe('classifyCommand names the protected capabilities a command plausibly uses', () => {
  it('ordinary work classifies as nothing', () => {
    expect([...classifyCommand('mkdir -p ~/Desktop/s1-demo && date +%F > ~/Desktop/s1-demo/hello.txt')]).toEqual([])
    expect([...classifyCommand('npm run build')]).toEqual([])
    expect([...classifyCommand('git status && git commit -m "x"')]).toEqual([])
  })

  it('ssh and friends → ssh_agent', () => {
    expect(classifyCommand('cat ~/.ssh/id_rsa').has('ssh_agent')).toBe(false)
    expect(classifyCommand('ssh -T git@github.com').has('ssh_agent')).toBe(true)
    expect(classifyCommand('scp a.txt host:/tmp').has('ssh_agent')).toBe(true)
    expect(classifyCommand('ssh-add -l').has('ssh_agent')).toBe(true)
  })

  it('crontab / launchctl / at → persistence', () => {
    expect(classifyCommand('crontab -l').has('persistence')).toBe(true)
    expect(classifyCommand('launchctl load ~/Library/LaunchAgents/x.plist').has('persistence')).toBe(true)
  })

  it('writing a shell startup file → persistence regardless of program', () => {
    expect(classifyCommand('echo "evil" >> ~/.zshrc').has('persistence')).toBe(true)
    expect(classifyCommand('printf x > ~/.bash_profile').has('persistence')).toBe(true)
  })

  it('only a delete aimed at the root, the home folder or a system folder is a broad delete', () => {
    for (const command of ['rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -rf ~/*', 'rm -fr $HOME', 'rm -rf /Users/fixture', 'rm -rf /Applications',
      'sudo rm -rf /System', 'rm -rf /*', 'rm -r -f ~/Documents', 'find ~ -name "*.log" -delete',
      // Preserve the recovery and user-visible behavior covered by this path.
      'rm -rf $HOME/Documents/*', 'rm -rf ~/Documents/*', 'rm -rf ~/Desktop/.*', 'rm -rf /Library/*', 'rm -rf /System/*', 'rm -rf /usr/local',
      'rm -r /Library', 'rm -R ~/Pictures', 'rm --recursive ~', 'find / -name x -exec rm {} \\;', 'find ~ -type f | xargs rm',
      'rm -rf "/Users/fixture/Documents"', 'rm -rf /Users/fixture/']) {
      expect(classifyCommand(command).has('bulk_destructive'), command).toBe(true)
    }

    for (const command of ['rm -rf node_modules', 'rm -rf ./dist', 'rm -rf /Users/fixture/code/app/dist', 'rm -rf ~/code/app/build',
      'rm -rf /tmp/build-123', 'rm -f /Users/fixture/code/app/a.log', 'find ./build -name "*.o" -delete', 'curl -fsSL https://example.com/x.sh -o /tmp/x.sh',
      'rm -rf ~/code/app/node_modules/*', 'rm -r ./tmp', 'find ./dist -type f -exec rm {} +', 'rm -rf /Users/fixture/code/app/build/*']) {
      expect(classifyCommand(command).has('bulk_destructive'), command).toBe(false)
    }
  })

  it('keychain, cloud CLIs, browser stores, broad deletes', () => {
    expect(classifyCommand('security find-generic-password -s x').has('keychain')).toBe(true)
    expect(classifyCommand('aws s3 ls').has('cloud_cli')).toBe(true)
    expect(classifyCommand('kubectl get pods').has('cloud_cli')).toBe(true)
    // GitHub CLI is everyday developer work, not money: no prompt (coordinator call 2026-10-20 under the owner's rule).
    expect(classifyCommand('gh pr create').has('cloud_cli')).toBe(false)
    expect(classifyCommand('cat ~/Library/Cookies/Cookies.binarycookies').has('browser_store')).toBe(true)
    expect(classifyCommand('rm -rf ~/*').has('bulk_destructive')).toBe(true)
  })

  it('sees through env-assignment and transparent prefixes to the real program', () => {
    expect(classifyCommand('FOO=bar ssh host').has('ssh_agent')).toBe(true)
    expect(classifyCommand('nohup crontab -r').has('persistence')).toBe(true)
  })

  it('anything run under sudo / su / doas is the sudo capability, and the real program still counts', () => {
    expect(classifyCommand('sudo ls /var/root')).toEqual(new Set(['sudo']))
    expect([...classifyCommand('sudo -u root launchctl list')].sort()).toEqual(['persistence', 'sudo'])
    expect(classifyCommand('env A=1 sudo -n true').has('sudo')).toBe(true)
    expect(classifyCommand('echo hi && su -c id').has('sudo')).toBe(true)
    expect(classifyCommand('git status && doas id').has('sudo')).toBe(true)
    expect(classifyCommand('echo "$(sudo id)"').has('sudo')).toBe(true)
  })

  it('a word that merely contains sudo is not sudo', () => {
    expect(classifyCommand('echo sudoku').has('sudo')).toBe(false)
    expect(classifyCommand('cat sudo-notes.txt').has('sudo')).toBe(false)
  })
})

// Review round 3 (2026-10-24): the program-based classes cut the text with a regex that knew `;`, `&&`,
// `||`, `|`, a newline, `$(` and a backtick, so `true & sudo id`, `if x; then sudo id; fi`, `sh -c 'sudo id'`
// and `(sudo id)` ran an administrator command without the Touch ID. They now read the text the way a
// shell does (`shell-lex.ts`), as the Drive mass-delete classifier already did.
describe('every command in a line is classified, wherever the shell would run it', () => {
  /** One protected command per class; none has a quote or a separator of its own, so any template can hold it. */
  const BASES: Array<[command: string, capability: DeviceProtectedCapability]> = [
    ['sudo id', 'sudo'],
    ['doas id', 'sudo'],
    ['su -c id', 'sudo'],
    ['security dump-keychain', 'keychain'],
    ['ssh host uptime', 'ssh_agent'],
    ['aws s3 ls', 'cloud_cli'],
    ['crontab -l', 'persistence']
  ]

  /** Ways a shell runs a command that is not the first word of the text. */
  const PLACES: Array<[place: string, wrap: (command: string) => string]> = [
    ['after a single &', c => `true & ${c}`],
    ['after & with no space', c => `true&${c}`],
    ['after &&', c => `true && ${c}`],
    ['after && with no space', c => `true&&${c}`],
    ['after ||', c => `false || ${c}`],
    ['after ;', c => `true; ${c}`],
    ['after a newline', c => `true\n${c}`],
    ['after a CRLF', c => `true\r\n${c}`],
    ['after a blank line and indentation', c => `echo a\n\n   ${c}`],
    ['after a pipe', c => `echo x | ${c}`],
    ['after |&', c => `echo x |& ${c}`],
    ['after a backgrounded command and a newline', c => `sleep 1 &\n${c}`],
    ['after a line continuation', c => `true && \\\n${c}`],
    ['in a subshell', c => `(${c})`],
    ['in a subshell after a command', c => `(cd /tmp; ${c})`],
    ['in a group', c => `{ ${c}; }`],
    ['after then', c => `if true; then ${c}; fi`],
    ['in an else branch', c => `if false; then true; else ${c}; fi`],
    ['as a condition', c => `if ${c}; then true; fi`],
    ['in a for loop', c => `for i in 1 2; do ${c}; done`],
    ['in a while loop', c => `while true; do ${c}; done`],
    ['after !', c => `! ${c}`],
    ['in $( )', c => `echo $(${c})`],
    ['in a quoted $( )', c => `echo "$(${c})"`],
    ['in backticks', c => `echo \`${c}\``],
    ['in a process substitution', c => `cat <(${c})`],
    ['in an assignment', c => `OUT=$(${c})`],
    ['in the default of a parameter expansion', c => `echo \${X:-$(${c})}`],
    ['in sh -c', c => `sh -c '${c}'`],
    ['in bash -lc', c => `bash -lc "${c}"`],
    ['in zsh -c after other commands', c => `zsh -c 'echo hi; ${c}'`],
    ['in sh -c in sh -c', c => `sh -c "bash -c '${c}'"`],
    ['in eval', c => `eval '${c}'`],
    ['in eval without quotes', c => `eval ${c}`],
    ['in a here-string to a shell', c => `bash <<< '${c}'`],
    ['in a heredoc to a shell', c => `bash <<EOF\n${c}\nEOF`],
    ['in an indented heredoc', c => `bash <<-EOF\n\t${c}\nEOF`],
    // Review round 4: a heredoc body is commands only when a shell reads it. These are the ways one does.
    ['in a quoted heredoc to sh', c => `sh <<'EOF'\n${c}\nEOF`],
    ['in a heredoc to zsh', c => `zsh <<EOF\n${c}\nEOF`],
    ['in a heredoc to bash -s', c => `bash -s -- a b <<EOF\n${c}\nEOF`],
    ['in a heredoc to bash -o', c => `bash -o errexit <<EOF\n${c}\nEOF`],
    ['in a heredoc to a wrapped shell', c => `env A=1 nohup bash <<EOF\n${c}\nEOF`],
    ['in a heredoc to xargs sh', c => `xargs sh <<EOF\n${c}\nEOF`],
    ['in a heredoc to source of stdin', c => `source /dev/stdin <<EOF\n${c}\nEOF`],
    ['in a heredoc to eval', c => `eval "$(cat)" <<EOF\n${c}\nEOF`],
    ['in a heredoc to a container shell', c => `docker exec -i box sh <<EOF\n${c}\nEOF`],
    ['in a heredoc piped to a shell', c => `cat <<'EOF' | bash\n${c}\nEOF`],
    ['in a heredoc piped through tee to a shell', c => `cat <<'EOF' | tee run.sh | sh\n${c}\nEOF`],
    ['in a script handed to bash -c', c => `bash -c "$(cat <<'EOF'\n${c}\nEOF\n)"`],
    ['in a script handed to eval', c => `eval "$(cat <<'EOF'\n${c}\nEOF\n)"`],
    ['in a script that is sourced', c => `source <(cat <<'EOF'\n${c}\nEOF\n)`],
    ['in an unquoted heredoc to cat, as a substitution', c => `cat <<EOF\n$(${c})\nEOF`],
    ['in an unquoted heredoc to cat, in backticks', c => `cat <<EOF\n\`${c}\`\nEOF`],
    ['fed to a shell by echo', c => `echo '${c}' | sh`],
    ['fed to a shell by printf', c => `printf '%s\\n' '${c}' | bash`],
    ['under xargs', c => `echo x | xargs ${c}`],
    ['under xargs with options', c => `echo x | xargs -n 1 -I{} ${c}`],
    ['under find -exec', c => `find . -type f -exec ${c} {} \\;`],
    ['under find -execdir', c => `find . -execdir ${c} {} +`],
    ['in a function body', c => `f() { ${c}; }; f`],
    ['after a wrapper', c => `nohup env A=1 ${c}`]
  ]

  it('finds each protected class at every place a shell runs a command', () => {
    for (const [command, capability] of BASES) {
      for (const [place, wrap] of PLACES) {
        const text = wrap(command)

        expect(classifyCommand(text).has(capability), `${command} ${place}: ${JSON.stringify(text)}`).toBe(true)
      }
    }
  })

  it('and asks about nothing else at those places: the same places around an ordinary command are silent', () => {
    for (const [place, wrap] of PLACES) {
      const text = wrap('date +%F')

      expect([...classifyCommand(text)], `${place}: ${JSON.stringify(text)}`).toEqual([])
    }
  })

  // Review round 4 (P1): `cat > notes.md <<'EOF'` with `sudo id` inside asked for the administrator's Touch ID.
  describe('a heredoc that only something reads is data', () => {
    /** Ways a program is given a heredoc that is not a shell's script: whatever its body says, nothing in it runs. */
    const DATA: Array<[place: string, wrap: (command: string) => string]> = [
      ['cat to a file', c => `cat > notes.md <<'EOF'\n${c}\nEOF`],
      ['cat to a file, the redirection first', c => `cat <<'EOF' > notes.md\n${c}\nEOF\nls`],
      ['cat with an unquoted delimiter', c => `cat > notes.md <<EOF\n${c}\nEOF`],
      ['cat with an escaped delimiter', c => `cat > notes.md <<\\EOF\n${c}\nEOF`],
      ['cat with a partly quoted delimiter', c => `cat > notes.md <<E"O"F\n${c}\nEOF`],
      ['an indented heredoc', c => `cat > notes.md <<-'EOF'\n\t${c}\n\tEOF`],
      ['tee', c => `tee notes.md <<'EOF'\n${c}\nEOF`],
      ['two heredocs', c => `cat <<'A' <<'B' > notes.md\n${c}\nA\n${c}\nB`],
      ['git commit -F -', c => `git commit -F - <<'EOF'\n${c}\nEOF`],
      ['gh pr create --body-file -', c => `gh pr create --title t --body-file - <<'EOF'\n${c}\nEOF`],
      ['a commit message', c => `git commit -m "$(cat <<'EOF'\n${c}\nEOF\n)"`],
      ['a pull request body', c => `gh pr create --title t --body "$(cat <<'EOF'\n${c}\nEOF\n)"`],
      ['a variable', c => `NOTE="$(cat <<'EOF'\n${c}\nEOF\n)"`],
      ['python', c => `python3 - <<'PY'\n${c}\nPY`],
      ['node', c => `node - <<'JS'\n${c}\nJS`],
      ['a database', c => `psql -d app <<'SQL'\n${c}\nSQL`],
      ['a script file given to bash', c => `bash run.sh <<'EOF'\n${c}\nEOF`],
      ['a shell given -c text', c => `bash -c 'cat' <<'EOF'\n${c}\nEOF`],
      ['source of a file', c => `source ./env.sh <<'EOF'\n${c}\nEOF`],
      ['a remote cat', c => `ssh host cat '>' notes.md <<'EOF'\n${c}\nEOF`],
      ['a container program', c => `docker exec -i db psql <<'SQL'\n${c}\nSQL`],
      ['cat into tee', c => `cat <<'EOF' | tee notes.md\n${c}\nEOF`],
      ['cat into grep', c => `cat <<'EOF' | grep -c x\n${c}\nEOF`],
      ['cat, then a shell on another command', c => `cat <<'EOF' > run.sh; bash run.sh\n${c}\nEOF`]
    ]

    it('finds nothing in a protected command that is only text in it', () => {
      for (const [command] of BASES) {
        for (const [place, wrap] of DATA) {
          const text = wrap(command)

          // `ssh` in `ssh host cat` is the program that runs; the body is what is not.
          const expected = place === 'a remote cat' ? ['ssh_agent'] : []

          expect([...classifyCommand(text)], `${command} as ${place}: ${JSON.stringify(text)}`).toEqual(expected)
        }
      }
    })

    it('finds no mass delete in inert prose, and the one a shell is given is still found', () => {
      for (const [place, wrap] of DATA) {
        if (place !== 'a remote cat') {
          for (const prose of ['rm -rf ~', 'rm -rf /', 'rm -rf $HOME/Documents', 'find ~ -delete', 'find / -name x -exec rm {} \\;']) {
            expect([...classifyCommand(wrap(prose))], `${prose} as ${place}`).toEqual([])
          }
        }
      }

      expect(classifyCommand("bash <<'EOF'\nrm -rf ~\nEOF").has('bulk_destructive')).toBe(true)
      expect(classifyCommand("cat <<'EOF' | sh\nrm -rf ~\nEOF").has('bulk_destructive')).toBe(true)
      expect(classifyCommand('cat <<EOF\n$(rm -rf ~)\nEOF').has('bulk_destructive'), 'an unquoted body runs its substitutions').toBe(true)
      expect(classifyCommand("cat <<'EOF'\n$(rm -rf ~)\nEOF").has('bulk_destructive'), 'a quoted one does not').toBe(false)
    })

    it('still reads every command on the lines around a heredoc', () => {
      expect(classifyCommand("cat <<'EOF' > notes.md\nprose\nEOF\nsudo id").has('sudo')).toBe(true)
      expect(classifyCommand("sudo id; cat <<'EOF' > notes.md\nprose\nEOF").has('sudo')).toBe(true)
      expect(classifyCommand("cat <<'EOF' > notes.md\nsudo id\nEOF\nsudo -v").has('sudo')).toBe(true)
      expect(classifyCommand("cat <<'EOF' > notes.md\nprose\nEOF\nrm -rf ~").has('bulk_destructive')).toBe(true)
    })
  })

  it('sees through the way a program is spelled or wrapped', () => {
    const SUDO = [
      "'sudo' id", '"sudo" id', 's\\udo id', '\\sudo id', "su''do id", "$'sudo' id", '/usr/bin/sudo id', 'SUDO id', '/usr/bin/SUDO id',
      'FOO=1 sudo id', 'FOO="a b" sudo id', 'sudo FOO=1 id', 'sudo -n id', 'sudo -u root -- id', 'sudo --user=root id', 'sudo -i', 'sudo',
      'env sudo id', 'env -i A=1 sudo id', 'env -u HOME sudo id', 'command sudo id', 'builtin sudo id', 'exec sudo id', 'time sudo id', 'nohup sudo id',
      'nice -n 5 sudo id', 'timeout 5 sudo id', 'timeout -s KILL 5 sudo id', 'gtimeout 5 sudo id', 'setsid sudo id', 'caffeinate -i sudo id',
      'caffeinate -t 60 sudo id', 'stdbuf -oL sudo id', 'arch -arm64 sudo id', 'unbuffer sudo id', 'busybox sudo id', 'ionice -c 3 sudo id',
      'sudo -u root nice -n 5 id', 'xargs sudo id', 'xargs -0 -n1 sudo id', 'xargs -I {} sudo id {}', 'xargs -- sudo id', 'doas -u root id',
      'su - root -c id', 'su'
    ]

    for (const text of SUDO) {
      expect(classifyCommand(text).has('sudo'), text).toBe(true)
    }

    expect(classifyCommand('timeout 5 sudo -u root launchctl list').has('persistence'), 'the program behind the wrapper chain counts too').toBe(true)
    expect(classifyCommand('sudo -n launchctl list').has('persistence'), '-n takes no argument').toBe(true)
    expect(classifyCommand('env -i A="b c" ssh host').has('ssh_agent')).toBe(true)
    expect(classifyCommand('/usr/bin/security find-generic-password -w').has('keychain')).toBe(true)
    expect(classifyCommand('Security dump-keychain').has('keychain'), 'APFS is case-insensitive').toBe(true)
    expect(classifyCommand('"ssh" host').has('ssh_agent')).toBe(true)
  })

  it('finds the command inside a case arm, though not the pattern that names it', () => {
    expect(classifyCommand('case "$1" in\n  a) ssh host ;;\nesac').has('ssh_agent')).toBe(true)
    expect(classifyCommand('case "$1" in a) sudo id ;; esac').has('sudo')).toBe(true)
    expect([...classifyCommand('case "$1" in ssh|scp) echo remote ;; at) echo later ;; esac')]).toEqual([])
    expect([...classifyCommand('case "$1" in\n  ssh|scp)\n    echo remote\n    ;;\n  aws | gcloud) echo cloud ;;\n  security) echo keychain ;;\nesac')]).toEqual([])
  })

  it('asks about text it will not follow: a protected word anywhere in nesting beyond what is read', () => {
    const deep = (inner: string) => `${'echo $('.repeat(10)}${inner}${')'.repeat(10)}`

    expect(classifyCommand(deep('sudo id')).has('sudo')).toBe(true)
    expect(classifyCommand(deep('ssh host')).has('ssh_agent')).toBe(true)
    expect([...classifyCommand(deep('date'))], 'an ordinary command in the same nesting is silent').toEqual([])
  })

  it('never throws, and a very long command is read in linear time', () => {
    for (const text of ['', ' ', '"', "'", '`', '$(', '$((', '${', '<<', '<<EOF', '&', '|', ';', '))', '(', '\\', '\0', "echo 'unterminated", 'a'.repeat(100_000)]) {
      expect(() => classifyCommand(text), JSON.stringify(text.slice(0, 20))).not.toThrow()
    }

    const started = Date.now()

    expect(classifyCommand(`${'echo a && '.repeat(20_000)}sudo id`).has('sudo')).toBe(true)
    expect(classifyCommand(`${'echo "a;b" '.repeat(20_000)}`).size).toBe(0)
    expect(Date.now() - started, 'two 200 KB commands').toBeLessThan(5000)
  }, 60_000)

  // The classifier now reads every terminal command, so the worst text an agent can send must not hold the
  // app's main process: each of these once cost seconds to minutes (a pattern that rescans to the end of the
  // text at every repeat, a copy per word, a recursion per word).
  it('reads the worst 100 KB texts it can be sent in a fraction of a second each', () => {
    const drive = { home: '/Users/fixture', roots: ['/Users/fixture/Atum/Drive'] }
    const N = 100_000

    const worst: Array<[name: string, text: string]> = [
      ['unmatched ${', '${'.repeat(N)],
      ['quoted unmatched ${', '"${'.repeat(N)],
      ['rm words', 'rm '.repeat(N / 4)],
      ['rm -rf words', 'rm -rf '.repeat(N / 4)],
      ['find words', 'find '.repeat(N / 4)],
      ['find -exec chain', 'find . -exec '.repeat(N / 8)],
      ['xargs chain', 'xargs '.repeat(N / 4)],
      ['wrapper chain', 'nohup '.repeat(N / 4)],
      ['assignment chain', 'FOO=1 '.repeat(N / 4)],
      ['open braces', '{ '.repeat(N)],
      ['git words', 'git '.repeat(N / 4)],
      ['git clone words', 'git clone '.repeat(N / 10)],
      ['slashes', `rm -rf ${'/'.repeat(N)}x`],
      ['/* chain', `rm -rf ${'/*'.repeat(N / 2)}`],
      ['unmatched braces after rm', `rm -rf ${'{'.repeat(N)}`],
      ['brace groups after rm', `rm -rf ${'{a,'.repeat(N / 3)}`]
    ]

    for (const [name, text] of worst) {
      const started = Date.now()

      expect(() => classifyCommand(text, drive), name).not.toThrow()
      expect(Date.now() - started, name).toBeLessThan(5000)
    }
  }, 60_000)

  // Review round 4 added three things that read more of a text: the heredoc consumer, the literal marks, the parameter forms.
  it('reads 100 KB of heredocs, quoted words and parameter expansions in a fraction of a second each', () => {
    const drive = { home: '/Users/fixture', roots: ['/Users/fixture/Atum/Drive'] }
    const N = 100_000

    const worst: Array<[name: string, text: string]> = [
      ['heredocs to cat', "cat <<'EOF'\nx\nEOF\n".repeat(N / 20)],
      ['heredocs to bash', 'bash <<EOF\nx\nEOF\n'.repeat(N / 20)],
      ['heredocs on one line', `cat ${"<<'E' ".repeat(N / 8)}\n`],
      ['heredoc pipelines', `${'cat <<EOF | '.repeat(N / 16)}cat\nx\nEOF\n`],
      ['substitutions that hold <<', 'echo $(echo <<) '.repeat(N / 16)],
      ['quoted words', 'echo \'~\' "*" \\* '.repeat(N / 14)],
      ['unknown parameter forms after rm', `rm -rf ${'${X%/}'.repeat(N / 6)}`],
      ['defaults after rm', `rm -rf ${'${A:-'.repeat(N / 5)}`],
      ['names after rm', `rm -rf ${'$A'.repeat(N / 2)}`]
    ]

    for (const [name, text] of worst) {
      const started = Date.now()

      expect(() => classifyCommand(text, drive), name).not.toThrow()
      expect(Date.now() - started, name).toBeLessThan(5000)
    }
  }, 60_000)

  it('still asks about text nested past what it follows, however it is nested', () => {
    expect(classifyCommand(`${'xargs '.repeat(12)}sudo id`).has('sudo')).toBe(true)
    expect(classifyCommand(`${'find . -exec '.repeat(12)}rm -rf ~`).has('bulk_destructive')).toBe(true)
    expect([...classifyCommand(`${'xargs '.repeat(12)}date`)]).toEqual([])
  })
})

describe('text that is not a command is not classified as one', () => {
  it('stays silent for protected words in quotes, comments, escapes, patterns and arguments', () => {
    const SILENT = [
      // Quoted separators and prose: the old regex cut inside the quotes.
      'echo "true && sudo id"', "echo 'a; sudo id'", 'echo "ssh; at; aws; security"', 'git commit -m "fix: handle ssh keys; at some point also sudo"',
      'git commit -m "docs: run sudo && done"', "echo 'a | ssh host'", 'echo "$(date) ssh"', "grep -rn 'sudo id' src/", 'echo "x" # && sudo id',
      'ls # ssh host', '# sudo id\nls', 'echo a\\; sudo id', 'echo a\\&\\& sudo id',
      // A protected word as data.
      'echo sudoku', 'cat sudo-notes.txt', 'grep -rn sudo src/', 'ls | grep ssh', "git log --grep='ssh' --oneline", 'git log --author=sudo', 'man sudo | head',
      'which ssh', 'type -a git', 'echo ssh', 'echo "$HOME/.ssh"', 'git config --get-regexp ssh', 'FOO=ssh npm run x', 'npm test -- --grep "ssh|sudo"',
      'node -e "console.log(\'sudo\')"', 'python3 -c "print(\'ssh\')"', 'find . -name sudo -print', 'xargs echo sudo', 'find . -exec echo sudo {} \\;',
      'bash -c "echo sudo"', "sh -c 'echo ssh'", "eval 'echo aws'", 'echo sudo | cat', "echo 'sudo id' | cat", "echo 'sudo id' | tee out.txt",
      'bash script.sh sudo', "bash <<< 'echo hi'", 'xargs -I{} echo {}'
    ]

    for (const text of SILENT) {
      expect([...classifyCommand(text)], JSON.stringify(text)).toEqual([])
      expect([...classifyCommand(text, DRIVE)], `${JSON.stringify(text)} with a Drive`).toEqual([])
    }
  })

  it('stays silent for ordinary development commands, as before', () => {
    const ORDINARY = [
      'npm install', 'npm ci --prefer-offline', 'npm run build && npm run lint && npm test', 'npm run dev &', 'npm run build & npm run lint & wait',
      'pnpm install --frozen-lockfile', 'npx vitest run src/foo.test.ts', 'yarn workspace app build', 'git status', 'git diff HEAD~1 -- src',
      'git add -A && git commit -m "x"', 'git log --oneline -20 | head -5', 'git push origin main', 'git pull --rebase', 'git checkout -b feat/x && git push -u origin feat/x',
      'git stash && git stash pop', 'gh pr create --title "x" --body "y"', 'gh run list --limit 5', 'ls -la', 'ls -la ~/Documents', 'cat README.md',
      'echo hello world', 'echo $(date) $(whoami)', 'echo `date`', "printf '%s\\n' a b c", 'rg "TODO|FIXME" src', "find . -name '*.ts' -not -path './node_modules/*'",
      'find . -type f -exec grep -l foo {} +', 'find . -type f -exec wc -l {} \\;', "find src -name '*.tsx' | xargs wc -l", 'xargs -n1 echo < list.txt',
      'mkdir -p build && cd build && cmake .. && make -j8', 'make test', 'cargo build --release', 'go build ./... && go test ./...', 'python3 -m pytest -q',
      'node scripts/build.js', 'docker ps', 'docker compose up -d', 'docker build -t app .', 'sed -i \'\' \'s/a/b/\' file.txt', "awk '{print $1}' file | sort -u",
      'tar xzf a.tgz -C /tmp', 'curl -s https://api.example.com | jq .', 'rsync -a src/ dst/', 'cp -R a b', 'mv a b', 'touch a b c', 'chmod +x script.sh',
      'export PATH=$PATH:/opt/bin', 'env FOO=1 npm test', 'env | grep SSH', 'time npm test', 'nohup npm run dev > out.log 2>&1 &', '(cd app && npm test)',
      '{ echo a; echo b; } > out.txt', 'for f in *.ts; do wc -l $f; done', 'if [ -f x ]; then cat x; else echo none; fi', 'while read l; do echo $l; done < in.txt',
      "bash -c 'npm test && npm run build'", 'sh -c "echo hi"', 'eval "echo hi"', 'test -d build || mkdir build', '[ -f package.json ] && node -v', 'true && false || echo ok',
      'sleep 1 &', 'ps aux | grep node', 'date +%F', 'uname -a', 'df -h', 'command -v node', 'command -v npm >/dev/null', 'echo "a b" | tr a-z A-Z',
      'cat <<EOF > notes.md\nsome notes\nEOF', 'python3 - <<\'PY\'\nimport os\nprint(os.getcwd())\nPY', 'set -e\nfor f in a b; do\n  echo $f\ndone'
    ]

    for (const text of ORDINARY) {
      expect([...classifyCommand(text)], JSON.stringify(text)).toEqual([])
      expect([...classifyCommand(text, DRIVE)], `${JSON.stringify(text)} with a Drive`).toEqual([])
    }
  })
})

// The delete class (the disk root, the home folder, a system folder) read the raw text too: `rm -rf ~;` was
// one word, `~;`, that no path matched, and `rm -rf build && ls /` looked at the `/` of another command.
describe('a broad delete is found in the command that does it, wherever the shell runs it', () => {
  it('gates the mass delete however it is written', () => {
    const BULK = [
      // Glued to a separator, a paren or a brace: the path is `~`, not `~;`.
      'rm -rf ~; echo done', 'rm -rf $HOME;', 'rm -rf /;', 'rm -rf /&', 'rm -rf ~|cat', '(rm -rf ~)', '{ rm -rf ~; }', 'echo $(rm -rf ~)', 'echo "$(rm -rf ~)"',
      'echo `rm -rf ~`', 'if true; then rm -rf ~; fi', 'for i in 1; do rm -rf ~/Documents; done', 'true&rm -rf ~', 'true\nrm -rf ~', 'true && \\\nrm -rf ~',
      // Run by another shell, a wrapper or a program that runs commands.
      'sh -c "rm -rf ~"', "bash -lc 'rm -rf /Applications'", 'eval "rm -rf ~"', 'bash <<< "rm -rf ~"', 'bash <<EOF\nrm -rf ~\nEOF', 'echo "rm -rf ~" | sh',
      'sudo rm -rf /System', 'env A=1 rm -rf ~', 'nohup rm -rf ~ &', 'timeout 5 rm -rf ~', 'command rm -rf ~', '\\rm -rf ~', '"rm" -rf ~', '/bin/rm -rf ~', 'RM -rf ~',
      'ssh host rm -rf ~', 'ssh host "rm -rf /"', 'docker exec c sh -c "rm -rf /"', "tmux new-session -d 'rm -rf ~'", 'watch rm -rf ~',
      // Operands and flags in any order.
      'rm -rf -- ~', 'rm -rf /tmp/x ~', 'rm --recursive --force /', 'rm -r --force ~/Documents', 'rm -fr "$HOME"', 'rm -rf "${HOME}/"',
      // find and xargs.
      'find ~ -delete', '(find ~ -delete)', 'true; find / -name x -exec rm {} \\;', 'find ~ -type f | xargs rm', 'find ~ -type f -print0 | xargs -0 rm',
      'find -L ~ -delete', 'find -f ~ -delete', 'echo ~ | xargs rm -rf', 'printf "%s\\n" ~ | xargs rm -r', 'xargs rm -rf ~'
    ]

    for (const text of BULK) {
      expect(classifyCommand(text).has('bulk_destructive'), JSON.stringify(text)).toBe(true)
    }
  })

  it('leaves ordinary deletes, and text that only mentions one, alone', () => {
    const ORDINARY = [
      // A path or flag of ANOTHER command in the line is not this delete's.
      'rm -rf build && ls /', 'rm -rf node_modules; ls ~', 'rm -r ./dist && cat /etc/hosts', 'rm -rf dist ; cd ~', 'rm -rf build\nls /', 'cd ~ && rm -rf build',
      'ls ~ && rm -rf ./build', 'echo ~ | rm -rf ./build', 'find ~ -type f | sort | xargs echo',
      // Text, not a command.
      'echo "rm -rf ~"', "echo 'rm -rf /'", 'git commit -m "rm -rf /"', 'grep -rn "rm -rf /" docs/', 'rm -rf build # rm -rf ~', '# rm -rf ~\nls',
      // Not recursive, not broad, or not a delete.
      'rm -f ~/.zsh_history', 'rm ~/old.txt', 'rmdir ~/empty', 'rm -rf ~/Library/Caches/foo', 'rm -rf ./*', 'find . -name "*.log" -delete', 'find ./build -delete',
      'find ~ -name "*.log" -print', 'git rm -r --cached .', 'docker rm -f c', 'docker run --rm -v ~:/x img', 'ssh host "ls /"', 'ssh host ls /'
    ]

    for (const text of ORDINARY) {
      expect(classifyCommand(text).has('bulk_destructive'), JSON.stringify(text)).toBe(false)
      expect(classifyCommand(text, DRIVE).has('bulk_destructive'), `${JSON.stringify(text)} with a Drive`).toBe(false)
    }
  })

  it('does not take a command that runs elsewhere for this Mac’s sudo, as before', () => {
    expect(classifyCommand('ssh host "sudo reboot"').has('sudo')).toBe(false)
    expect(classifyCommand('ssh host "sudo reboot"').has('ssh_agent')).toBe(true)
    expect(classifyCommand('ssh host "rm -rf /"').has('sudo')).toBe(false)
  })
})

describe('classifyExecute folds declared needs and the proposed effect in', () => {
  it('matches the vendored needs-approval cases: ssh command → ssh_agent', () => {
    const caps = classifyExecute({
      tool: 'terminal',
      args: { command: 'ssh -T git@github.com' },
      needs: ['ssh_agent'],
      proposedEffect: 'ssh_agent'
    })

    expect([...caps]).toEqual(['ssh_agent'])
  })

  it('catches an undeclared protected effect from the command itself (crontab -l)', () => {
    const caps = classifyExecute({
      tool: 'terminal',
      args: { command: 'crontab -l' },
      needs: [],
      proposedEffect: 'persistence'
    })

    expect(caps.has('persistence')).toBe(true)
  })

  it('an ordinary terminal command with no needs classifies as empty', () => {
    const caps = classifyExecute({
      tool: 'terminal',
      args: { command: 'date +%F' },
      needs: [],
      proposedEffect: 'ordinary'
    })

    expect([...caps]).toEqual([])
  })
})
