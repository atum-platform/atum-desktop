/**
 * Authenticated CONNECT for OpenSSH (macOS nc cannot supply a noninteractive
 * proxy password). A-APP sets ATUM_DEVICE_PROXY_TOKEN in forced_command_env;
 * the credential stays in the environment rather than the process argv.
 */
const CONNECT = String.raw`import base64, os, re, select, socket, sys
token = os.environ.get("ATUM_DEVICE_PROXY_TOKEN", "")
if not token:
    sys.exit("device_proxy_token_missing")
host, port, proxy_port = sys.argv[1:]
if not port.isdecimal() or not 0 < int(port) < 65536 or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,253}", host):
    sys.exit("device_proxy_destination_invalid")
authority = ("[" + host + "]" if ":" in host else host) + ":" + port
auth = base64.b64encode(("srt:" + token).encode()).decode()
s = socket.create_connection(("127.0.0.1", int(proxy_port)), timeout=20)
s.sendall(("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nProxy-Authorization: Basic " + auth + "\r\n\r\n").encode())
head = bytearray()
while b"\r\n\r\n" not in head:
    byte = s.recv(1)
    if not byte or len(head) >= 16384:
        sys.exit("device_proxy_invalid_response")
    head.extend(byte)
if bytes(head).split(b"\r\n", 1)[0].split()[1:2] != [b"200"]:
    sys.exit("device_proxy_refused")
s.settimeout(None)
inputs = [s, 0]
while inputs:
    ready, _, _ = select.select(inputs, [], [])
    if s in ready:
        data = s.recv(65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            s.sendall(data)
        else:
            inputs.remove(0)
            s.shutdown(socket.SHUT_WR)
s.close()
`

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`

export function sshProxyCommand(pythonPath: string, proxyPort: number): string {
  if (
    !pythonPath.startsWith('/') ||
    pythonPath.includes('\0') ||
    !Number.isSafeInteger(proxyPort) ||
    proxyPort < 1 ||
    proxyPort > 65535
  ) {
    throw new Error('device_proxy_command_invalid')
  }

  // OpenSSH validates the expanded hostname before exec; single quotes also
  // keep shell operators inert. The helper independently rejects non-host syntax.
  return `${quote(pythonPath)} -I -c ${quote(CONNECT)} '%h' '%p' ${proxyPort}`
}
