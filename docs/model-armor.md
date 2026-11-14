# Google content screening with Model Armor

The native scanner always runs. To add Model Armor, configure `config.yaml`.

```yaml
security:
  google_content_scanner: modelarmor
  modelarmor_socket: /run/atum-model-armor/scanner.sock
```

An operator must provide the host scanner socket to the sandbox. The socket accepts
one UTF-8 JSON line `{"text":"..."}` and returns `{"findings":[]}` or
`{"findings":["prompt_injection"]}`. Requests are limited to 8 MiB. Hermes waits
at most 2.8 seconds for the complete response. Missing sockets, timeouts, errors and
invalid replies retain the native verdict. A finding uses the existing warning and
per-turn tool refusal path.

Only the socket is shared with the agent. Service-account credentials, cloud token
refresh and regional API calls belong to the separate host service. The host must
limit socket access to the intended sandbox and prohibit agent access to its
credential files, process environment and cloud metadata. The client never loads
Google authentication libraries or credentials. The host chunks text and enforces
its own 2.5-second deadline. Application logs contain fixed finding IDs and error
classes. They must never include Google content or remote error messages.

The default remains `native`. An operator enables the additional processor after
configuring its credentials and completing the privacy-policy update.
