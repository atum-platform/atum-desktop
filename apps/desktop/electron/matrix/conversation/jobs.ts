import { execFile } from 'node:child_process'
import path from 'node:path'

import { buildConversationMarker } from '../../../shared/agent-conversation'
import { matrixHermesEnvironment, type MatrixHermesRuntimeConfig } from '../hermes-runtime'

// Imported from the agent's verified runtime, using the shipped cron store's lock/API.
const JOB_ORIGINS = `import json, sys
from cron import jobs
request = json.loads(sys.argv[1])
rooms = set(request["rooms"])
with jobs._jobs_lock():
    selected = [job for job in jobs.list_jobs(include_disabled=True)
        if isinstance(job.get("origin"), dict)
        and job["origin"].get("platform") == "matrix"
        and job["origin"].get("chat_id") in rooms
        and job["origin"].get("chat_id") != request.get("main")]
    if request["action"] == "repoint":
        for job in selected:
            origin = dict(job["origin"])
            origin["chat_id"] = request["main"]
            if jobs.update_job(job["id"], {"origin": origin}) is None:
                raise RuntimeError("job_changed")
    print(json.dumps({"count": len(selected)}))
`

/** Call repoint only after the native fence stops/settles this agent's executor. */
export async function conversationJobOrigins(runtime: MatrixHermesRuntimeConfig, home: string, request: {
  action: 'count' | 'repoint'
  rooms: readonly string[]
  main?: string
}, signal: AbortSignal): Promise<number> {
  if (!path.isAbsolute(home)) {throw new Error('matrix_conversation_jobs_unavailable')}
  for (const roomId of request.rooms) {buildConversationMarker({ roomId, role: 'main', main: roomId, at: 0 })}
  if (request.action === 'repoint') {buildConversationMarker({ roomId: request.main!, role: 'main', main: request.main!, at: 0 })}
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    execFile(runtime.python, ['-s', '-P', '-B', '-c', JOB_ORIGINS, JSON.stringify(request)], {
      cwd: runtime.source, env: matrixHermesEnvironment(runtime, home, home),
      signal, timeout: 30_000, maxBuffer: 65_536, windowsHide: true
    }, (error, stdout) => {
      if (!error) {
        try {
          const value = JSON.parse(stdout) as { count: unknown }
          if (typeof value.count === 'number' && Number.isSafeInteger(value.count) && value.count >= 0) {resolve(value.count); return}
        } catch {/* Closed native failure below; no raw output crosses IPC. */}
      }
      reject(new Error('matrix_conversation_jobs_unavailable'))
    })
  })
}
