-- Separate terminal presentation authority; no ledger or turn-state mutations.
-- Adopted 0442:81 audiences, :143 native task identity, :156 writer fence, :312 binding;
-- 0395:1247 company_ai_scope_current checks current channel/private membership.
-- This decision is for immediate redaction of the caller's OWN progress root only.
-- Matrix sender, exact marker/thread/trigger and event ownership remain checked by
-- the controller against the original event before every redaction/retry.
begin;
create function atum.company_agent_presentation_cleanup(
  p_controller uuid,p_credential_digest text,p_executor uuid,p_input jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare n atum_private.company_agent_native_tasks;r atum_private.company_ai_runs;
  a atum_private.company_agent_audiences;h atum_private.company_agent_homes;
  scope_value jsonb;audience_value jsonb;reason_value text;
begin
  if not atum_private.cloud_controller_current(p_controller,p_credential_digest) then
    raise exception 'matrix_denied' using errcode='42501';end if;
  if (atum_private.json_keys_exact(p_input,array['schemaVersion','companyId','agentPrincipal','audience',
      'roomId','threadRootEventId','triggerEventId','taskId','invocationId','disclosureEpoch','leaseToken','leaseGeneration'])
    and p_input->'schemaVersion'='1'::jsonb
    and atum_private.json_uuid(p_input->'companyId') and atum_private.json_uuid(p_input->'agentPrincipal')
    and atum_private.json_uuid(p_input->'taskId') and atum_private.json_uuid(p_input->'invocationId')
    and atum_private.json_text(p_input->'roomId','^![!-9;-~]{1,255}:[!-~]{1,255}$',512)
    and atum_private.json_text(p_input->'threadRootEventId','^\$[!-~]+$',512)
    and atum_private.json_text(p_input->'triggerEventId','^\$[!-~]+$',512)
    and atum_private.json_text(p_input->'leaseToken','^[A-Za-z0-9_-]{43}$',43)
    and atum_private.json_int(p_input->'leaseGeneration',1,9007199254740991) is not null
    and atum_private.json_int(p_input->'disclosureEpoch',1,9007199254740991) is not null
    and ((atum_private.json_keys_exact(p_input->'audience',array['kind','channelId'])
      and p_input#>>'{audience,kind}'='channel' and atum_private.json_uuid(p_input#>'{audience,channelId}'))
    or (atum_private.json_keys_exact(p_input->'audience',array['kind','memberPrincipal','membershipIncarnation'])
      and p_input#>>'{audience,kind}'='private' and atum_private.json_uuid(p_input#>'{audience,memberPrincipal}')
      and atum_private.json_uuid(p_input#>'{audience,membershipIncarnation}')))) is not true then
    raise exception 'matrix_invalid' using errcode='22023';end if;
  select * into n from atum_private.company_agent_native_tasks
    where task=(p_input->>'taskId')::uuid and executor=p_executor;
  select * into r from atum_private.company_ai_runs where task=n.task;
  select * into a from atum_private.company_agent_audiences where home=n.home;
  select * into h from atum_private.company_agent_homes where home=n.home;
  audience_value:=case when r.scope_kind='company_channel' then
    jsonb_build_object('kind','channel','channelId',r.channel) else
    jsonb_build_object('kind','private','memberPrincipal',r.requester,'membershipIncarnation',r.membership_incarnation) end;
  -- Retained native fence proves original publisher; it is NOT a live work lease.
  -- A new native admission replaces these coordinates and fences the old writer.
  if n.task is null or r.task is null or a.home is null or h.home is null
    or n.invocation is distinct from (p_input->>'invocationId')::uuid
    or r.invocation_fence is distinct from n.invocation
    or r.company is distinct from (p_input->>'companyId')::uuid
    or r.agent is distinct from (p_input->>'agentPrincipal')::uuid
    or a.company is distinct from r.company or a.agent is distinct from r.agent
    or a.scope_kind is distinct from r.scope_kind or a.channel is distinct from r.channel
    or a.membership_incarnation is distinct from r.membership_incarnation
    or h.company is distinct from r.company or h.agent is distinct from r.agent
    or a.room is distinct from p_input->>'roomId'
    or n.thread_root is distinct from p_input->>'threadRootEventId'
    or r.thread_root is distinct from n.thread_root
    or r.trigger_event is distinct from p_input->>'triggerEventId'
    or audience_value is distinct from p_input->'audience'
    or n.lease_token is distinct from p_input->>'leaseToken'
    or n.lease_epoch is distinct from (p_input->>'leaseGeneration')::bigint then
    reason_value:='identity_mismatch';
  elsif not exists(select 1 from atum_private.cloud_enrollments e
    join atum.matrix_executors x on x.id=e.executor and x.owner=r.company and x.agent=r.agent
      and x.state='active' and x.expires_at>clock_timestamp()
    where e.executor=p_executor and e.controller=p_controller and e.owner=r.company and e.agent=r.agent
      and e.state='active' and e.trust='trusted'
      and e.kind=case when r.scope_kind='company_channel' then 'company_ai' else 'company_private_cos' end
    ) then reason_value:='executor_denied';
  end if;
  if reason_value is null then
    scope_value:=atum_private.company_ai_scope_current(n.task);
    if scope_value is null or scope_value->>'roomId' is distinct from a.room
      or scope_value->>'scopeDigest' is distinct from r.publication_scope_digest then
      reason_value:='audience_stale';
    elsif a.disclosure_epoch is distinct from (p_input->>'disclosureEpoch')::bigint
      or h.disclosure_epoch is distinct from a.disclosure_epoch then
      reason_value:='disclosure_stale';
    elsif r.state not in ('settled','published','cancelled','stopped','failed','uncertain') then
      reason_value:='task_not_terminal';
    end if;
  end if;
  return jsonb_build_object('schemaVersion',1,'allowed',reason_value is null,
    'reason',coalesce(reason_value,'own_progress_cleanup'),'operation','redact_own_progress');
end $$;
revoke all on function atum.company_agent_presentation_cleanup(uuid,text,uuid,jsonb)
  from public,anon,authenticated,ledger_service,atum_drive_ingress;
grant execute on function atum.company_agent_presentation_cleanup(uuid,text,uuid,jsonb) to service_role;
commit;
