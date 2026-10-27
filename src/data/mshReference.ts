// msh's reference: one text for `man msh` in the terminal and the `msh` skill the agents read.
// No imports, so the server can use it too.

export const MSH_REFERENCE = `# msh: the MvL OS shell

msh is the shell in the MvL OS terminal. It follows POSIX sh closely, with a few bash extras. It
runs in the browser: commands are the ones MvL OS has (see \`help\`), files live in Seafile (under
~ and /mnt/seafile when mounted), /tmp is scratch space in memory, and there are no processes,
so \`&\` runs in the foreground.

## Running msh

    msh -c 'echo hi; ls | wc -l'      run a command line
    msh -c 'echo $1' name arg         $0 is "name", $1 is "arg"
    msh script.sh a b                 run a script with arguments
    ./script.sh a b                   the same, for a file starting with #!/bin/msh (or sh, bash); needs chmod +x
    echo 'ls' | msh                   read the script from stdin
    msh -n script.sh                  check the syntax only
    msh -x script.sh                  print each command before running it (set -x)
    source file  /  . file            run a file in the current shell

sh and bash are names for msh too. Scripts for python, node and other interpreters do not run.

A script run as a command needs its x bit, as in any shell: without it, ./script.sh prints
\`msh: ./script.sh: Permission denied\` (status 126), and \`chmod +x script.sh\` fixes it. msh script.sh,
source and . read it without. See man chmod.

## Command lines

    a; b          run a, then b
    a && b        run b if a succeeded
    a || b        run b if a failed
    a | b         a's output is b's input
    ! a           invert a's status
    ( a; b )      a subshell: cd and variables stay inside
    { a; b; }     a group, in this shell
    # comment     to the end of the line
    \\             at the end of a line: the line goes on

## Redirects

    > file     write output to a file (Seafile or /tmp)
    >> file    append
    < file     read input from a file
    2> file    errors to a file; 2>/dev/null drops them
    2>&1       errors into the output; >&2 output into the errors
    &> file    both
    <<EOF      a here-document up to a line EOF ($vars expand; <<'EOF' keeps them as written;
               <<-EOF strips leading tabs)

## Quoting and expansion

    'single'          literally
    "double"          $vars, $(…) and \\ work inside
    \\x                one character literally
    ~ ~/dir           your home folder
    $name \${name}     a variable; $1…$9 arguments, $# their count, "$@" all of them as words,
                      $* joined, $? last status, $0 the script, $$ a process id, $RANDOM
    $(cmd) \`cmd\`      what cmd prints, trailing newlines removed
    $((1 + x * 2))    integer arithmetic: + - * / % ** << >> & | ^ ~ ! == != < <= > >= && || ?:
                      = += -= ++ --, (…); hex 0x1F, octal 017
    * ? [a-z] [!x]    globbing: matching file names (dotfiles only with a leading .)

Unquoted expansions are split into words on $IFS (space, tab, newline) and then globbed. Quote
them ("$x") to keep them one word.

### \${…} forms

    \${x:-word}    word if x is unset or empty          \${x-word}  only if unset
    \${x:=word}    the same, and assign it               \${x=word}
    \${x:+word}    word if x is set and not empty        \${x+word}
    \${x:?msg}     fail with msg if unset or empty
    \${#x}         length
    \${x#pat}      remove the shortest matching prefix   \${x##pat}  the longest
    \${x%pat}      remove the shortest matching suffix   \${x%%pat}  the longest
    \${x/pat/rep}  replace the first match               \${x//pat/rep}  every match
    \${x:off:len}  a substring

## Compound commands

    if cond; then …; elif cond; then …; else …; fi
    for x in a b c; do …; done          (without "in …": the arguments)
    while cond; do …; done
    until cond; do …; done
    case $x in
      a|b) … ;;
      *.md) … ;;
      *) … ;;
    esac
    name() { …; }                       a function: its arguments are $1…, return N ends it
    function name { …; }

break [n] and continue [n] work in loops; local x=1 keeps a variable to a function.

## Builtins

    echo [-n] [-e] text     print (-n: no newline, -e: \\n \\t escapes)
    printf fmt args…        formatted: %s %d %i %x %o %f %e %g %c %b %%, widths, \\n escapes
    test expr  /  [ expr ]  -e -f -d -s -r -w -x file, -z -n string, = != < >, -eq -ne -lt -le -gt -ge,
                            ! -a -o ( )
    true  false  :          status 0, 1, 0
    read [-r] [-p prompt] a b   a line from input (or the keyboard) into variables
    export [name[=value]]   set a variable (no arguments: list them)
    unset [-f] name         remove a variable (or function)
    set -e -x -u            stop on errors, trace, fail on unset variables (+e etc. to undo);
    set -o pipefail         a pipeline fails when any part fails
    set -- a b c            replace the arguments
    shift [n]  local  return [n]  exit [n]  break [n]  continue [n]
    eval words              run the words as a command line
    command [-v] name       run a command, skipping functions (-v: say what it is)
    type name               what a name is (an alias, function, builtin or command)
    alias [name[=value]]    list, show or define an alias; unalias [-a] name removes one
    getopts spec var        parse options in a loop
    sleep 1.5               wait (s, m, h suffixes)

## Aliases and ~/.mvshrc

    alias ll='ls -l'        a new first word for a command: ll /tmp runs ls -l /tmp
    alias                   list them; alias ll shows one
    unalias ll              remove it (unalias -a removes all)

An alias replaces the first word of a command, also after ; && || and | (not inside quotes, and
not in scripts). A name expands once per command, so alias ls='ls -l' and two aliases that name
each other do not loop. Aliases belong to one terminal tab.

~/.mvshrc is a file in your home folder that every terminal tab runs when it opens, like .bashrc:
alias lines, export, cd, anything msh runs. It is silent unless a line prints something; a line
that fails shows its number and the rest still runs. Create it with nano ~/.mvshrc or
echo "alias ll='ls -l'" >> ~/.mvshrc. Where ~ cannot be written (signed out), it is kept in this
browser. Settings, Terminal can turn the startup file off. The agents' shell does not run it.

## Exit status

0 is success. A failing command is 1, a syntax error 2, an unknown command 127. grep is 1 when
nothing matched. With set -e a script stops at the first failure outside if, while, && and ||.

## Differences from bash

No arrays, no [[ … ]], no process substitution, no job control; aliases are simple (no arguments). Commands
are the ones MvL OS has: run \`help\` for the list and \`man <command>\` for one. Everything runs in
the browser tab, and Ctrl+C stops a running line.
`

/** The reference as a terminal manual page: headings in bold, code blocks kept. */
export const MSH_MAN = MSH_REFERENCE.replace(/^# .*\n\n/, '')
  .split('\n')
  .map((l) => (l.startsWith('#') ? `{c:bold}${l.replace(/^#+\s*/, '').toUpperCase()}{/}` : l.replace(/`([^`]+)`/g, '{c:cyan}$1{/}')))
  .join('\n')
