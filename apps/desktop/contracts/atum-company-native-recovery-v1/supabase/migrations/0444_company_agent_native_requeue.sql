-- 0444: company native attempt evidence and accounted recovery. Additive to 0442.
-- Adopted: 0395 reserve body:1341-1447, 0239 settlement/requeue:595-641,
-- 0257 age bounds, 0442 home fences:397-428 and token rotation:285-310.
begin;
set local lock_timeout='10s';
do $$
begin
 if md5((select prosrc from pg_proc where oid=to_regprocedure('atum.company_funding_reserve_v2(uuid,bigint,integer)')))
   is distinct from '9b9545a78c25c1f94435c60bcd3e0d81' then raise exception '0444 predecessor drift: company_funding_reserve_v2';end if;
 if to_regclass('atum_private.company_agent_native_tasks') is null then
   raise exception '0444 predecessor missing: apply 0442';end if;
end $$;
alter table atum_private.company_agent_native_tasks
  add column recovery_attempt integer not null default 0 check(recovery_attempt between 0 and 100),
  add column check_used boolean not null default false,
  add column recovery_mode text not null default 'run' check(recovery_mode in ('run','check','terminal')),
  add column check_operation uuid,
  add column effect_floor text not null default 'none' check(effect_floor in ('none','read_only','side_effect_possible','unknown'));
alter table atum_private.company_funding_reservations
  add column recovery_attempt integer not null default 0 check(recovery_attempt between 0 and 100),
  drop constraint company_funding_reservations_task_0323,
  add constraint company_funding_reservations_attempt_0444 unique(task,recovery_attempt) deferrable initially deferred;
alter table atum.cloud_admission_reservations
  add column company_recovery_attempt integer not null default 0 check(company_recovery_attempt between 0 and 100),
  drop constraint cloud_admission_reservations_company_task_key,
  add constraint cloud_admission_reservations_company_attempt_0444 unique(company_task,company_recovery_attempt);
create table atum_private.company_agent_recovery_requests(
  request uuid primary key, task uuid not null references atum_private.company_agent_native_tasks(task) on delete cascade,
  controller uuid not null, executor uuid not null, input_digest text not null, result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table atum_private.company_agent_effects(
  task uuid not null references atum_private.company_agent_native_tasks(task) on delete cascade,
  attempt integer not null, effect text not null check(effect in ('none','read_only','side_effect_possible','unknown')),
  tools jsonb not null, operation_id uuid, primary key(task,attempt)
);
alter table atum_private.company_agent_recovery_requests enable row level security;
alter table atum_private.company_agent_effects enable row level security;
revoke all on atum_private.company_agent_recovery_requests,atum_private.company_agent_effects
  from public,anon,authenticated,service_role,ledger_service,atum_drive_ingress;
create or replace function atum.company_funding_reserve_v2(
  p_task uuid,p_model_ceiling bigint,p_compute_seconds integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare run_row atum_private.company_ai_runs;prior atum_private.company_funding_reservations;
  policy atum_private.company_funding_policy;dispatch atum_private.cloud_dispatch_policy;
  model_policy atum_private.matrix_model_policy;model_row atum_private.matrix_model_catalog;
  scope_value jsonb;hold_value jsonb;funding_id uuid:=gen_random_uuid();admission_id uuid:=gen_random_uuid();
  expected_ceiling bigint;company_used bigint;requester_used bigint;v_rate ledger.usage_rates;
  v_compute_ceiling bigint;v_total_ceiling bigint;v_enabled boolean;v_compute_funding text;
  v_attempt integer:=coalesce((select recovery_attempt from atum_private.company_agent_native_tasks where task=p_task),0);
  v_member_limit bigint;v_allowance atum_private.company_private_cos_allowances;
begin
  if p_task is null or p_model_ceiling is null or p_model_ceiling not between 1 and 9007199254740991
    or p_compute_seconds is null or p_compute_seconds not between 1 and 86400 then raise exception 'matrix_invalid';end if;
  perform pg_advisory_xact_lock(hashtextextended('company-ai-reserve:'||p_task::text,323));
  select * into run_row from atum_private.company_ai_runs where task=p_task for update;
  if not found or run_row.scope_kind not in ('company_channel','company_private_cos')
    then raise exception 'matrix_not_found';end if;
  select * into prior from atum_private.company_funding_reservations where task=p_task and recovery_attempt=v_attempt;
  if found then
    if prior.model_ceiling<>p_model_ceiling or prior.compute_seconds<>p_compute_seconds
      then raise exception 'matrix_request_conflict' using errcode='PT409';end if;
    return atum.company_funding_check_v2(prior.id);
  end if;
  if run_row.funding_denied_at is not null then
    return jsonb_build_object('schemaVersion',2,'error',jsonb_build_object('code','budget_exhausted'));end if;
  if run_row.state<>'claimed' and not (v_attempt>0 and run_row.state='dispatched') then raise exception 'matrix_request_conflict' using errcode='PT409';end if;
  scope_value:=atum_private.company_ai_scope_current(p_task);
  if scope_value is null or scope_value->>'scopeDigest'<>run_row.publication_scope_digest then
    return jsonb_build_object('schemaVersion',2,'error',jsonb_build_object('code','denied'));end if;
  select * into policy from atum_private.company_funding_policy where company=run_row.company for update;
  select * into dispatch from atum_private.cloud_dispatch_policy where singleton and active for share;
  select * into model_policy from atum_private.matrix_model_policy where singleton and active for share;
  select * into model_row from atum_private.matrix_model_catalog where alias=model_policy.default_alias and active for share;
  if policy.company is null or dispatch.singleton is null or model_row.alias is null or not policy.enabled
    or policy.model_policy_digest<>model_policy.policy_digest
    or not atum_private.company_ai_enabled_for_wallet(run_row.company) then
    return jsonb_build_object('schemaVersion',2,'error',jsonb_build_object('code','ai_disabled'));end if;
  expected_ceiling:=least(policy.task_limit,dispatch.model_ceiling_micro_protons);
  if p_model_ceiling<>expected_ceiling or p_compute_seconds<>least(policy.compute_seconds,dispatch.compute_seconds)
    or model_row.max_turn_micro_protons>expected_ceiling then
    raise exception 'matrix_request_conflict' using errcode='PT409';end if;
  perform ledger._usage_rate_lock('cloud_compute',false);
  v_rate:=ledger._usage_rate_at('cloud_compute',clock_timestamp());
  if v_rate.revision is null then perform ledger._fail('usage_rate_missing');end if;
  v_compute_ceiling:=ledger._usage_price(p_compute_seconds,v_rate);
  select enabled into v_enabled from atum_private.cloud_compute_billing_settings where singleton;
  if v_enabled is null then raise exception 'matrix_invalid';end if;
  v_compute_funding:=case when v_enabled then 'wallet' else 'platform' end;
  v_total_ceiling:=p_model_ceiling+case when v_enabled then v_compute_ceiling else 0 end;
  if v_total_ceiling>9007199254740991 then perform ledger._fail('usage_amount_out_of_range');end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'company-ai-daily:'||run_row.company::text||':'||current_date::text,323));
  perform pg_advisory_xact_lock(hashtextextended(
    'company-ai-requester-daily:'||run_row.requester::text||':'||current_date::text,323));
  select u.company_used,u.requester_used into company_used,requester_used
    from atum_private.company_funding_usage_0395(run_row.company,run_row.requester) u;
  if run_row.scope_kind='company_private_cos' then
    select * into v_allowance from atum_private.company_private_cos_allowances
      where company=run_row.company and member=run_row.requester for share;
    v_member_limit:=coalesce(v_allowance.allowance_micro_protons,
      policy.requester_daily_limit_micro_protons,policy.company_daily_limit_micro_protons,
      policy.task_limit+v_compute_ceiling);
  end if;
  if policy.company_daily_limit_micro_protons is not null
      and company_used+v_total_ceiling>policy.company_daily_limit_micro_protons
    or policy.requester_daily_limit_micro_protons is not null
      and requester_used+v_total_ceiling>policy.requester_daily_limit_micro_protons
    or run_row.scope_kind='company_private_cos' and requester_used+v_total_ceiling>v_member_limit then
    update atum_private.company_ai_runs set funding_denied_at=clock_timestamp(),updated_at=clock_timestamp()
      where task=p_task;
    return jsonb_build_object('schemaVersion',2,'error',jsonb_build_object('code','budget_exhausted'));
  end if;
  begin
    hold_value:=ledger._hold(run_row.company,v_total_ceiling,'usage','company-ai:'||p_task::text||case when v_attempt>0 then ':r'||v_attempt else '' end,
      atum_private.company_ledger_accounts(run_row.company));
  exception when raise_exception then
    if sqlerrm in ('ledger_insufficient_protons','ledger_unknown_principal') then
      update atum_private.company_ai_runs set funding_denied_at=clock_timestamp(),updated_at=clock_timestamp()
        where task=p_task;
      return jsonb_build_object('schemaVersion',2,'error',jsonb_build_object('code','budget_exhausted'));
    end if;raise;
  end;
  insert into atum_private.company_funding_reservations(
    id,company,project,actor,request,audience_generation,funding_revision,ceiling,hold,
    scope_kind,requester,requester_membership_epoch,channel,channel_admission_generation,
    task,agent,authority_generation,channel_generation,source_generation,publication_scope_digest,
    model_ceiling,compute_seconds,cloud_admission_reservation,membership_incarnation,recovery_attempt)
  values(funding_id,run_row.company,null,null,null,null,policy.revision,v_total_ceiling,
    (hold_value->>'hold')::uuid,run_row.scope_kind,run_row.requester,run_row.requester_membership_epoch,
    run_row.channel,run_row.channel_admission_generation,run_row.task,run_row.agent,
    run_row.authority_generation,run_row.channel_generation,run_row.source_generation,
    run_row.publication_scope_digest,p_model_ceiling,p_compute_seconds,admission_id,run_row.membership_incarnation,v_attempt)
  returning * into prior;
  insert into atum.cloud_admission_reservations(
    id,owner,agent,subject,idempotency_key,fingerprint,funding,wallet_hold,ceiling_micro_protons,
    compute_seconds,expires_at,compute_funding,company_funding_reservation,company_task,
    compute_billing_version,compute_rate_revision,compute_ceiling_micro_protons,company_recovery_attempt)
  values(admission_id,run_row.company,run_row.agent,
    jsonb_build_object('kind',run_row.scope_kind,'taskId',p_task),
    'company-ai:'||p_task::text||case when v_attempt>0 then ':r'||v_attempt else '' end,ledger._fingerprint(jsonb_build_array(
      p_task,p_model_ceiling,p_compute_seconds,run_row.scope_kind)),
    'company_wallet',(hold_value->>'hold')::uuid,p_model_ceiling,p_compute_seconds,
    clock_timestamp()+make_interval(secs=>p_compute_seconds),v_compute_funding,
    funding_id,p_task,1,v_rate.revision,v_compute_ceiling,v_attempt);
  update atum_private.company_ai_runs set reservation=funding_id,updated_at=clock_timestamp() where task=p_task;
  return atum_private.company_funding_projection_v2(prior,'reserved');
end $$;


-- Existing consumers select the run's CURRENT funding row. Old attempt rows are
-- retained for billing/audit; task is no longer a unique funding-row selector.
do $$
declare f record;body text;changed text;
begin
 for f in select p.oid,p.prosrc,pg_get_functiondef(p.oid) definition from pg_proc p
   join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname in ('atum','atum_private') and p.prokind='f'
     and p.proname like 'company_%' and p.prosrc like '%company_funding_reservations%'
 loop
   body:=f.definition;
   changed:=replace(body,'company_funding_reservations where task=r.task','company_funding_reservations where id=r.reservation');
   changed:=replace(changed,'company_funding_reservations f2 on f2.task=r2.task','company_funding_reservations f2 on f2.id=r2.reservation');
   if f.oid='atum.company_private_cos_spend(uuid,uuid,date)'::regprocedure then
     changed:=replace(changed,'count(*) runs','count(distinct r.task) runs');
   end if;
   if changed<>body then execute changed;end if;
 end loop;
end $$;

alter function atum.company_agent_native_dispatch(uuid,text,uuid,uuid,uuid) set schema atum_private;
alter function atum_private.company_agent_native_dispatch(uuid,text,uuid,uuid,uuid) rename to company_agent_native_dispatch_pre_0444;
revoke all on function atum_private.company_agent_native_dispatch_pre_0444(uuid,text,uuid,uuid,uuid)
  from public,anon,authenticated,service_role,ledger_service,atum_drive_ingress;
create function atum.company_agent_native_dispatch(
 p_controller uuid,p_credential_digest text,p_executor uuid,p_task uuid,p_holder uuid
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare result_value jsonb;n atum_private.company_agent_native_tasks;
begin
 if not atum_private.cloud_controller_current(p_controller,p_credential_digest) then
   raise exception 'matrix_denied';end if;
 perform pg_advisory_xact_lock(hashtextextended('company-ai-reserve:'||p_task::text,323));
 result_value:=atum_private.company_agent_native_dispatch_pre_0444(p_controller,p_credential_digest,p_executor,p_task,p_holder);
 select * into n from atum_private.company_agent_native_tasks where task=p_task;
 if n.recovery_attempt>0 then
   result_value:=result_value||jsonb_build_object('recovery',jsonb_build_object(
     'attempt',n.recovery_attempt,'mode',n.recovery_mode,'effect',n.effect_floor,'operationId',n.check_operation));
 end if;
 return result_value;
end $$;
revoke all on function atum.company_agent_native_dispatch(uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function atum.company_agent_native_dispatch(uuid,text,uuid,uuid,uuid) to service_role;

create function atum.company_agent_native_recovery(
 p_controller uuid,p_credential_digest text,p_executor uuid,p_input jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare n atum_private.company_agent_native_tasks;r atum_private.company_ai_runs;
 h atum_private.company_agent_homes;l atum_private.company_agent_home_leases;
 a atum_private.company_agent_audiences;g atum_private.cloud_model_grants;
 f atum_private.company_funding_reservations;c atum.cloud_admission_reservations;
 prior atum_private.company_agent_recovery_requests;e atum_private.company_agent_effects;
 op text:=p_input->>'operation';effect_value text;check_identity_known boolean;req uuid;digest_value text;result_value jsonb;
 receipts jsonb;funded jsonb;dispatch jsonb;new_token text;
begin
 if not atum_private.cloud_controller_current(p_controller,p_credential_digest) then
   raise exception 'matrix_denied' using errcode='42501';end if;
 if (atum_private.json_keys_exact(p_input,array['schemaVersion','operation','requestId','taskId',
   'invocationId','homeId','leaseToken','leaseGeneration','disclosureEpoch','expectedGeneration','effect','tools','operationId'])
   and p_input->'schemaVersion'='1'::jsonb and op in ('effects','close','requeue','check')
   and atum_private.json_uuid(p_input->'requestId') and atum_private.json_uuid(p_input->'taskId')
   and atum_private.json_uuid(p_input->'invocationId') and atum_private.json_uuid(p_input->'homeId')
   and atum_private.json_text(p_input->'leaseToken','^[A-Za-z0-9_-]{43}$',43)
   and atum_private.json_int(p_input->'leaseGeneration',1,9007199254740991) is not null
   and atum_private.json_int(p_input->'disclosureEpoch',1,9007199254740991) is not null
   and atum_private.json_int(p_input->'expectedGeneration',0,9007199254740991) is not null
   and p_input->>'effect' in ('none','read_only','side_effect_possible','unknown')
   and (p_input->'operationId'='null'::jsonb or atum_private.json_uuid(p_input->'operationId'))
   and case when jsonb_typeof(p_input->'tools')='array' then jsonb_array_length(p_input->'tools')<=12
     and not exists(select 1 from jsonb_array_elements(p_input->'tools') t
       where jsonb_typeof(t)<>'string' or t#>>'{}' !~ '^[A-Za-z0-9_.:/-]{1,64}$') else false end) is not true then
   raise exception 'matrix_invalid' using errcode='22023';end if;
 req:=(p_input->>'requestId')::uuid;
 digest_value:=encode(extensions.digest(p_input::text,'sha256'),'hex');
 -- Same lock order as reserve, then 0442 task/home/lease. Serializes duplicate request ids too.
 perform pg_advisory_xact_lock(hashtextextended('company-native-request:'||req::text,444));
 perform pg_advisory_xact_lock(hashtextextended('company-ai-reserve:'||(p_input->>'taskId'),323));
 select * into r from atum_private.company_ai_runs where task=(p_input->>'taskId')::uuid for update;
 select * into n from atum_private.company_agent_native_tasks where task=r.task and executor=p_executor for update;
 if not found or not exists(select 1 from atum_private.cloud_enrollments
   where executor=p_executor and controller=p_controller and state='active') then
   raise exception 'matrix_denied' using errcode='42501';end if;
 select * into prior from atum_private.company_agent_recovery_requests where request=req;
 if found then
   if prior.task<>n.task or prior.executor<>p_executor or prior.controller<>p_controller or prior.input_digest<>digest_value then
     raise exception 'company_agent_native_conflict' using errcode='PT409';end if;
   return prior.result;
 end if;
 select * into h from atum_private.company_agent_homes where home=n.home for update;
 select * into l from atum_private.company_agent_home_leases where home=n.home for update;
 select * into a from atum_private.company_agent_audiences where home=n.home;
 if r.state<>'dispatched' or r.stopped_at is not null or n.recovery_mode='terminal'
   or r.invocation_fence is distinct from (p_input->>'invocationId')::uuid
   or n.home is distinct from (p_input->>'homeId')::uuid
   or l.state<>'held' or l.expires_at<=clock_timestamp()
   or l.holder is distinct from n.lease_holder or l.token is distinct from n.lease_token
   or l.epoch is distinct from n.lease_epoch or l.token is distinct from p_input->>'leaseToken'
   or l.epoch is distinct from (p_input->>'leaseGeneration')::bigint
   or h.generation is distinct from (p_input->>'expectedGeneration')::bigint
   or h.disclosure_epoch is distinct from (p_input->>'disclosureEpoch')::bigint
   or a.disclosure_epoch is distinct from h.disclosure_epoch
   or atum_private.company_ai_scope_current(r.task)->>'scopeDigest' is distinct from r.publication_scope_digest then
   raise exception 'company_agent_home_fenced' using errcode='42501';end if;
 select * into g from atum_private.cloud_model_grants where company_task=r.task and executor=p_executor
   and controller=p_controller for update;
 if not found then raise exception 'matrix_denied' using errcode='42501';end if;
 select * into f from atum_private.company_funding_reservations where id=g.company_funding_reservation for update;
 select * into c from atum.cloud_admission_reservations where id=f.cloud_admission_reservation for update;
 effect_value:=p_input->>'effect';
 select * into e from atum_private.company_agent_effects where task=n.task and attempt=n.recovery_attempt;
 check_identity_known:=e.operation_id is not null and e.operation_id is not distinct from (p_input->>'operationId')::uuid;
 if found then
   -- Evidence only strengthens. Unknown cannot become a claim of no effects.
   if e.operation_id is not null and e.operation_id is distinct from (p_input->>'operationId')::uuid then
     raise exception 'company_agent_native_conflict' using errcode='PT409';end if;
   if array_position(array['none','read_only','side_effect_possible','unknown'],effect_value)
      <array_position(array['none','read_only','side_effect_possible','unknown'],e.effect) then effect_value:=e.effect;end if;
 elsif op not in ('effects','close') then effect_value:='unknown';end if;
 if array_position(array['none','read_only','side_effect_possible','unknown'],effect_value)
    <array_position(array['none','read_only','side_effect_possible','unknown'],n.effect_floor) then
   effect_value:=n.effect_floor;
 end if;
 update atum_private.company_agent_native_tasks set effect_floor=effect_value where task=n.task;
 insert into atum_private.company_agent_effects(task,attempt,effect,tools,operation_id)
   values(n.task,n.recovery_attempt,effect_value,p_input->'tools',case when op in ('effects','close') then (p_input->>'operationId')::uuid else e.operation_id end)
   on conflict(task,attempt) do update set effect=excluded.effect,tools=excluded.tools,operation_id=case when op in ('effects','close') then
     coalesce(company_agent_effects.operation_id,excluded.operation_id) else company_agent_effects.operation_id end;
 if op in ('effects','close') then
   -- Close before settlement. In-flight model accounting must finish before readmission.
   if op='close' then
     update atum_private.cloud_model_grants set stopped_at=coalesce(stopped_at,clock_timestamp()) where token_digest=g.token_digest;
   end if;
   result_value:=jsonb_build_object('schemaVersion',1,'taskId',n.task,'state',case when op='close' then 'closed' else 'recorded' end,'attempt',n.recovery_attempt,'effect',effect_value);
 else
   if g.stopped_at is null then raise exception 'company_agent_native_conflict' using errcode='PT409';end if;
   if exists(select 1 from atum.cloud_admission_model_calls where reservation=c.id and charged_micro_protons is null) then
     raise exception 'company_agent_native_conflict' using errcode='PT409';end if;
   select coalesce(jsonb_agg(jsonb_build_object('requestKey',request_key,
     'chargedMicroProtons',charged_micro_protons) order by request_key),'[]'::jsonb) into receipts
     from atum.cloud_admission_model_calls where reservation=c.id;
   perform atum_private.cloud_admission_settle_outcome(c.id,'complete:'||(case when r.scope_kind='company_private_cos' then r.task else r.invocation_fence end)::text,receipts,0,'uncertain');
   -- Refusals are committed receipts: the spent grant stays closed and money is settled.
   if effect_value='unknown' or least(c.expires_at,g.expires_at)-interval '5 seconds'<=clock_timestamp()
      or (select coalesce(sum(charged_micro_protons),0) from atum.cloud_admission_model_calls where reservation=c.id)>=f.model_ceiling
      or n.check_used or n.recovery_attempt>=100
      or clock_timestamp()>=n.created_at+(case when exists(select 1 from atum_private.cloud_agent_queue where agent_principal=r.agent and seq=r.queue_seq and source='occurrence') then interval '5 minutes' else interval '30 minutes' end)
      or effect_value='read_only' and n.recovery_attempt>=2
      or op='check' and (effect_value<>'side_effect_possible' or not check_identity_known)
      or op='requeue' and effect_value='side_effect_possible' then
     update atum_private.company_agent_native_tasks set recovery_mode='terminal' where task=n.task;
     result_value:=jsonb_build_object('schemaVersion',1,'taskId',n.task,'state','refused','outcome','uncertain','computeSeconds',0,'attempt',n.recovery_attempt,'effect',effect_value);
   else
     update atum_private.company_agent_native_tasks set recovery_attempt=recovery_attempt+1,
       check_used=op='check',recovery_mode=case when op='check' then 'check' else 'run' end,
       check_operation=(p_input->>'operationId')::uuid where task=n.task returning * into n;
     funded:=atum.company_funding_reserve_v2(r.task,f.model_ceiling,f.compute_seconds);
     if funded ? 'error' then
       update atum_private.company_agent_native_tasks set recovery_mode='terminal' where task=n.task;
       result_value:=jsonb_build_object('schemaVersion',1,'taskId',n.task,'state','refused','outcome','uncertain','computeSeconds',0,'attempt',n.recovery_attempt,'effect',effect_value);
     else
       select * into f from atum_private.company_funding_reservations where id=(funded->>'reservationId')::uuid;
       select * into c from atum.cloud_admission_reservations where id=f.cloud_admission_reservation;
       -- Rotate both the writer term and the model capability. Old callbacks cannot cross attempts.
       update atum_private.company_agent_home_leases set token=atum_private.company_agent_token(),epoch=epoch+1,
         expires_at=clock_timestamp()+interval '2 minutes',acquired_from_epoch=null,
         acquired_from_generation=null,acquired_from_sha256=null,updated_at=clock_timestamp()
         where home=n.home returning * into l;
       new_token:=atum_private.company_agent_token();
       update atum_private.cloud_model_grants set stopped_at=null,token_digest=encode(extensions.digest(new_token,'sha256'),'hex'),
         reservation=c.id,company_funding_reservation=f.id,expires_at=least(c.expires_at,clock_timestamp()+interval '2 minutes')
         where token_digest=g.token_digest;
       update atum.matrix_invocations set expires_at=c.expires_at where fence=n.invocation;
       update atum_private.company_agent_native_tasks set lease_epoch=l.epoch,lease_token=l.token,
         model_token=new_token,session_committed=false,committed_home=null where task=n.task;
       dispatch:=atum.company_agent_native_dispatch(p_controller,p_credential_digest,p_executor,n.task,n.lease_holder);
       result_value:=jsonb_build_object('schemaVersion',1,'taskId',n.task,'state','dispatched','attempt',n.recovery_attempt,
         'effect',effect_value,'mode',n.recovery_mode,'operationId',n.check_operation,'dispatch',dispatch);
     end if;
   end if;
 end if;
 insert into atum_private.company_agent_recovery_requests(request,task,controller,executor,input_digest,result)
   values(req,n.task,p_controller,p_executor,digest_value,result_value);
 return result_value;
end $$;
revoke all on function atum.company_agent_native_recovery(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function atum.company_agent_native_recovery(uuid,text,uuid,jsonb) to service_role;

-- Like personal 0239's stale-completion fence: a task identity alone no longer
-- authorizes completion after requeue. Lock the run BEFORE reading its attempt,
-- in recovery's order, and hold that lock through outbox/settlement. Reservation
-- keyed ledger adapters already address an immutable attempt; never change them.
create function atum_private.company_native_assert_attempt(p_task uuid,p_attempt jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare n atum_private.company_agent_native_tasks;
begin
 perform 1 from atum_private.company_ai_runs where task=p_task for update;
 select * into n from atum_private.company_agent_native_tasks where task=p_task for update;
 if found and (n.recovery_attempt>0 or p_attempt is not null) and
   atum_private.json_int(p_attempt,0,100) is distinct from n.recovery_attempt then
   raise exception 'company_agent_home_fenced' using errcode='42501';end if;
end $$;
revoke all on function atum_private.company_native_assert_attempt(uuid,jsonb)
 from public,anon,authenticated,service_role,ledger_service,atum_drive_ingress;

-- Keep the old signatures, now fenced, and add explicit attempt overloads. No
-- native row means exactly the old behavior. Attempt-zero wire compatibility is
-- safe: no superseded callback exists until the first recovery.
do $patch$
declare signature text;body text;extended text;fname text;
begin
 foreach signature in array array[
   'atum_private.company_ai_complete_0323(uuid,uuid,uuid,uuid,text,integer)',
   'atum_private.company_private_cos_complete_0395(uuid,uuid,uuid,text,integer)'] loop
   body:=pg_get_functiondef(signature::regprocedure);
   extended:=replace(body,'p_compute_seconds integer)', 'p_compute_seconds integer, p_native_attempt jsonb)');
   if extended=body then raise exception '0444 completion signature drift: %',signature;end if;
   extended:=regexp_replace(extended,'\mbegin\M',
     E'begin\n  perform atum_private.company_native_assert_attempt(p_task,p_native_attempt);','i');
   execute extended;
   body:=regexp_replace(body,'\mbegin\M',
     E'begin\n  perform atum_private.company_native_assert_attempt(p_task,null);','i');
   execute body;
   fname:=split_part(signature,'(',1);
   execute 'revoke all on function '||fname||case when fname like '%0323' then
     '(uuid,uuid,uuid,uuid,text,integer,jsonb)' else '(uuid,uuid,uuid,text,integer,jsonb)' end||
     ' from public,anon,authenticated,service_role,ledger_service,atum_drive_ingress';
 end loop;
end $patch$;

-- Carry the caller's attempt into EVERY completion call, including receipt,
-- abandon and native outbox. Fence entry before idempotency/outbox shortcuts;
-- preserve the original input for receipt fingerprinting, strip only for exact
-- shape validation. Revoked predecessor bodies are fenced as well.
do $patch$
declare f record;body text;guard text;
begin
 for f in select p.oid,p.proname,pg_get_functiondef(p.oid) definition from pg_proc p
   join pg_namespace ns on ns.oid=p.pronamespace
   where ns.nspname in ('atum','atum_private') and p.prokind='f' and
    (p.proname='company_ai_invocation' or p.proname like 'company_ai_agent%' or
     p.proname like 'company_private_cos_controller%') and p.prosrc like '%p_input%' loop
   body:=replace(f.definition,'json_keys_exact(p_input,','json_keys_exact(p_input-''nativeAttempt'',');
   body:=regexp_replace(body,'(company_ai_complete_0323\([^;]+)\);',
     '\1,p_input->''nativeAttempt'');','g');
   body:=regexp_replace(body,'(company_private_cos_complete_0395\([^;]+)\);',
     '\1,p_input->''nativeAttempt'');','g');
   guard:=case when f.proname like 'company_private_cos_controller%' then
     'p_resource in (''receipt'',''recover'',''commit'',''outbox'',''published'')' else
     'p_input->>''operation'' in (''complete'',''commit'',''abandon'',''outbox'',''published'',''release'',''recover'')' end;
   body:=regexp_replace(body,'\mbegin\M',E'begin\n  if '||guard||E' and p_input ? ''taskId'' then\n'||
     E'    if not atum_private.cloud_controller_current(p_controller,p_credential_digest) then raise exception ''matrix_denied'';end if;\n'||
     E'    perform atum_private.company_native_assert_attempt((p_input->>''taskId'')::uuid,p_input->''nativeAttempt'');\n  end if;','i');
   if f.proname like 'company_ai_agent%' then
     body:=replace(body,'select * into r from atum_private.company_ai_runs where agent=a.agent and queue_seq=q.seq for update;',
       'select * into r from atum_private.company_ai_runs where agent=a.agent and queue_seq=q.seq for update;
        perform atum_private.company_native_assert_attempt(r.task,p_input->''nativeAttempt'');');
   end if;
   execute body;
 end loop;
end $patch$;
commit;
