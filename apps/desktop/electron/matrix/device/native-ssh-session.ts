/** OpenSSH authorized_keys command= wrapper. Perl/POSIX ship with macOS; no runtime install.
 * The login shell retains its terminal and job control. sshd invokes this through $SHELL -c; ~/.zshenv may run first.
 * This contains cooperative login sessions, not hostile code already executing as the OS user.
 */
export const nativeSshSession = String.raw`use strict;
use warnings;
use POSIX qw(WNOHANG);
my ($marker, $epoch) = @ARGV;
sub allowed {
  open(my $f, '<', $marker) or return 0;
  local $/;
  return (<$f> // '') eq $epoch;
}
exit 126 unless allowed();
my $child = fork();
defined($child) or exit 126;
if (!$child) {
  $SIG{INT} = 'DEFAULT';
  my $shell = $ENV{SHELL} || '/bin/zsh';
  if (exists $ENV{SSH_ORIGINAL_COMMAND}) {
    exec {$shell} $shell, '-c', $ENV{SSH_ORIGINAL_COMMAND};
  } else {
    exec {$shell} $shell, '-l';
  }
  exit 126;
}
sub close_session {
  my ($status) = @_;
  $status = 126 unless defined $status;
  # Only a supervisor that leads its own group may collect reparented jobs.
  # Never signal the inherited caller group (or init's group).
  my $group = getpgrp();
  my $owns_group = $group == $$ && $group > 1;
  my %targets;
  while (1) {
    my (%children, @group_pids);
    my $snapshot_pid = open(my $ps, '-|', '/bin/ps', '-axo', 'pid=,ppid=,pgid=') or exit 126;
    while (<$ps>) {
      next if /^\s*$snapshot_pid\s/;
      if (/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/) {
        push @{$children{$2}}, $1;
        push @group_pids, $1 if $owns_group && $3 == $group && $1 != $$;
      }
    }
    close $ps;
    # Retain stopped ancestors even if a child has since been reparented.
    my @tree = ($$, keys %targets);
    my %seen;
    for (my $i = 0; $i < @tree; $i++) {
      next if $seen{$tree[$i]}++;
      push @tree, @{$children{$tree[$i]} || []};
    }
    my @new = grep { $_ != $$ && !$targets{$_}++ } (@tree, @group_pids);
    last unless @new;
    kill 'STOP', @new;
    # Rescan after STOP: a process may fork while the first ps is running.
  }
  kill 'KILL', keys %targets if %targets;
  exit $status;
}
$SIG{INT} = 'IGNORE';
$SIG{TERM} = $SIG{HUP} = sub { close_session(); };
while (1) {
  close_session() unless allowed();
  my $done = waitpid($child, WNOHANG);
  if ($done == $child) { my $status = $?; close_session(($status & 127) ? 128 + ($status & 127) : $status >> 8); }
  exit 126 if $done == -1;
  select undef, undef, undef, 0.25;
}
`
