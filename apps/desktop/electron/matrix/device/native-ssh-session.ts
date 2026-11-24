/** OpenSSH authorized_keys command= wrapper. Perl/POSIX ship with macOS; no runtime install.
 * The login shell retains its terminal and job control. No user rc runs before this command.
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
  # Walk only this supervisor's descendants, never all sshd/login-user processes.
  my %children;
  open(my $ps, '-|', '/bin/ps', '-axo', 'pid=,ppid=') or exit 126;
  while (<$ps>) {
    if (/^\s*(\d+)\s+(\d+)\s*$/) { push @{$children{$2}}, $1; }
  }
  close $ps;
  my @tree = ($$);
  for (my $i = 0; $i < @tree; $i++) { push @tree, @{$children{$tree[$i]} || []}; }
  # Freeze first so ordinary children cannot fork while the tree is terminated.
  kill 'STOP', @tree[1..$#tree] if @tree > 1;
  kill 'KILL', reverse @tree[1..$#tree] if @tree > 1;
  exit $status;
}
$SIG{TERM} = $SIG{HUP} = $SIG{INT} = sub { close_session(); };
while (1) {
  close_session() unless allowed();
  my $done = waitpid($child, WNOHANG);
  if ($done == $child) { my $status = $?; close_session(($status & 127) ? 128 + ($status & 127) : $status >> 8); }
  exit 126 if $done == -1;
  select undef, undef, undef, 0.25;
}
`
