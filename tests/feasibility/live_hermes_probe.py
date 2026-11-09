"""Opt-in live core proof using the existing Hermes Copilot credential resolver.

Transport/usage evidence only: this core check is distinct from the PostgreSQL
managed billing test. No substitute provider is claimed for the bound managed job.
"""
import json, os, sqlite3, subprocess, sys, tempfile
from pathlib import Path
from hermes_cli.copilot_auth import resolve_copilot_token, get_copilot_api_token
from hermes_cli.auth import PROVIDER_REGISTRY

repo=Path(__file__).resolve().parents[2]
fixture=json.loads((repo/'tests/fixtures/shared-group-feasibility.json').read_text())
raw,_=resolve_copilot_token()
key,base=get_copilot_api_token(raw)
base=base or PROVIDER_REGISTRY['copilot'].inference_base_url
model='gpt-4o-mini-2024-07-18'
# Explicit conservative context cap avoids unrelated model-catalog network I/O.
proofs=[]
messages=list(fixture['messages'])
for turn in range(2):
 with tempfile.TemporaryDirectory(prefix='atum-live-hermes-',dir='/tmp') as directory:
  root=Path(directory).resolve(); shared=root/'shared'; home=shared/'.hermes'; private=root/'private';workspace=shared/'workspace'
  home.mkdir(parents=True);workspace.mkdir();private.mkdir()
  (home/'SOUL.md').write_text(fixture['persona']['text'])
  (home/'config.yaml').write_text('agent:\n  environment_probe: false\nmodel:\n  context_length: 64000\n')
  for name,marker in fixture['private_canaries'].items():(private/(name+'.txt')).write_text(marker)
  memories=home/'memories';memories.mkdir()
  (memories/'MEMORY.md').write_text(fixture['private_canaries']['memory'])
  (memories/'USER.md').write_text(fixture['private_canaries']['user'])
  projection=json.dumps({'conversation_id':fixture['conversation_id'],'messages':messages,'context_mode':'shared_group'})
  env={'HOME':str(shared),'HERMES_HOME':str(home),'USER':'shared','LOGNAME':'shared','HOSTNAME':'shared-fixture',
   'PATH':'/usr/bin:/bin','PYTHONPATH':str(repo),'PYTHONDONTWRITEBYTECODE':'1','SHARED_MODEL_API_KEY':key,
   'TZ':'UTC','LANG':'C.UTF-8','TIRITH_ENABLED':'false','AWS_EC2_METADATA_DISABLED':'true'}
  scenario={'private_root':str(private),'message':projection,'private_paths':[str(memories/'MEMORY.md'),str(memories/'USER.md')],'live':True,'single_turn':True,'provider':'copilot','model':model,'base_url':base}
  child=subprocess.run([sys.executable,str(repo/'tests/feasibility/hermes_child.py')],cwd=workspace,env=env,input=json.dumps(scenario),capture_output=True,text=True,timeout=150)
  if child.returncode:raise RuntimeError(child.stderr[-1500:].replace(key,'[redacted]'))
  proof=json.loads(next(line.removeprefix('SHARED_PROOF=') for line in child.stdout.splitlines() if line.startswith('SHARED_PROOF=')))
  assert proof['completed'] and proof['violations']==[] and proof['valid_tools']==[], json.dumps({k:proof[k] for k in ['completed','violations','valid_tools','final_response']}).replace(key,'[redacted]')
  assert proof['requests'] and len(proof['provider_responses']) == len(proof['requests'])
  assert proof['session_db_attached'] is False
  assert proof['credential_names'] == ['SHARED_MODEL_API_KEY']
  allowed={'.hermes/SOUL.md','.hermes/config.yaml','.hermes/logs/agent.log','.hermes/logs/errors.log','.hermes/state.db','.hermes/state.db-journal','.hermes/state.db-wal','.hermes/state.db-shm'}
  def allowed_access(item):
   path=item['path']
   # Editable Python installs probe this nonexistent namespace hook while
   # constructing the real SDK client. No file content is read there.
   import_hook=(path.startswith('workspace/__editable__.hermes_agent-') and path.endswith('.finder.__path_hook__') and not (shared/path).exists())
   return path in allowed or import_hook
  assert all(allowed_access(item) for item in proof['shared_accesses']), proof['shared_accesses']
  for database in proof['sqlite_paths']:
   assert Path(database).is_relative_to(home)
   with sqlite3.connect('file:'+database+'?mode=ro',uri=True) as connection:
    tables={row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
    assert not {'sessions','messages'} & tables
  captured=json.dumps(proof['requests'])
  assert all(marker not in captured for marker in fixture['private_canaries'].values())
  assert all(request['model']==model and not request.get('tools') for request in proof['requests'])
  assert 'Steady steps' in proof['final_response']
  proofs.append({k:proof[k] for k in ['requests','final_response','provider_responses','violations','credential_names']})
  messages.extend([{'speaker':{'kind':'assistant','id':fixture['target_id']},'text':proof['final_response']},
   {'speaker':{'kind':'human','id':fixture['requester_id']},'text':'What did Sam suggest, and what practical limitation did you mention? Two sentences.'}])
assert 'riverside' in proofs[-1]['final_response'].lower()
Path('/tmp/hermes-group-live-proof.json').write_text(json.dumps({'model':model,'provider':'copilot','turns':proofs},indent=2))
print('HERMES_LIVE_PROOF_OK real_provider_calls='+str(sum(len(p['requests']) for p in proofs))+' fresh_processes=2')
