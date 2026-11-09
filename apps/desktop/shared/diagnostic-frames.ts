export function diagnosticFrames(stack: unknown) {
  if (typeof stack !== 'string') {
    return []
  }

  // Only shipped bundle paths and coordinates survive. Never function names,
  // source lines, home paths, URLs, query strings, or the exception message.
  return stack
    .slice(0, 16_384)
    .split('\n')
    .flatMap(line => {
      const match =
        /(?:[/\\](?:dist(?:-matrix)?|app\.asar)[/\\]|app:\/\/\/|atum-matrix:\/\/(?:ui|sdk)\/)(electron-(?:main\.mjs|preload\.js)|matrix-(?:main\.mjs|(?:ui|sdk|pages)-preload\.js|sdk\.js)|(?:pages[/\\])?assets[/\\][a-zA-Z0-9_.-]+\.js):(\d+):(\d+)\)?\s*$/.exec(
          line
        )

      if (!match) {
        return []
      }

      return [
        {
          filename: `app:///${match[1].replaceAll('\\', '/')}`,
          lineno: Number(match[2]),
          colno: Number(match[3]),
          in_app: true
        }
      ]
    })
    .slice(0, 40)
    .reverse()
}
