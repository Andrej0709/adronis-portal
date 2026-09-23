/* ============================================================ */
/* Adronis Portal - admin layer on top of the Adronis schema.    */
/*                                                               */
/* Run this whole file once in: Supabase Dashboard -> SQL Editor */
/* AFTER the main adronis supabase/schema.sql. Safe to re-run.   */
/*                                                               */
/* It never changes anything a customer sees. It only adds:      */
/*   - a list of people allowed into the portal                  */
/*   - read access for those people across every table           */
/*   - a small set of write functions that record what they did  */
/* ============================================================ */


/* ------------------------------------------------------------ */
/* 1. Who is allowed in                                          */
/*                                                               */
/* Nobody is, until a row lands here. Adding yourself is the one  */
/* step that cannot be done from the portal itself - see the      */
/* seed block at the bottom of this file.                         */
/* ------------------------------------------------------------ */
create table if not exists public.portal_admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  email    text not null,
  label    text,
  added_at timestamptz not null default now()
);

/* The name the portal calls an admin by - in the top bar, the audit log
   and the admin list - instead of their whole email address. */
alter table public.portal_admins add column if not exists username text;

alter table public.portal_admins enable row level security;

/* An admin may see the admin list. Anyone else sees an empty table,
   which is exactly what the portal's login gate reads as "not an admin". */
drop policy if exists "portal admins read" on public.portal_admins;
create policy "portal admins read" on public.portal_admins
  for select to authenticated
  using (exists (select 1 from public.portal_admins a where a.user_id = auth.uid()));


/* is_portal_admin() - the single gate every policy and function below asks.
   security definer so it can read portal_admins without recursing through
   that table's own RLS policy. */
create or replace function public.is_portal_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.portal_admins where user_id = auth.uid()
  );
$$;

grant execute on function public.is_portal_admin() to authenticated;


/* ------------------------------------------------------------ */
/* 2. Settings the portal can change without a deploy             */
/*                                                               */
/* trial_days is the length of the free trial start_trial() hands */
/* out. It lived as a hardcoded 7 in the schema; it now lives     */
/* here, so it can be changed from the portal.                    */
/* ------------------------------------------------------------ */
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.app_settings (key, value)
values ('trial_days', '7'::jsonb)
on conflict (key) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists "settings read admin" on public.app_settings;
create policy "settings read admin" on public.app_settings
  for select to authenticated
  using (public.is_portal_admin());


/* trial_days() - reads the setting, falls back to 7 if the row is missing
   or holds something that is not a sane number. start_trial() calls it. */
create or replace function public.trial_days()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select greatest(0, least(365, coalesce(
    (select (value #>> '{}')::int from public.app_settings where key = 'trial_days'),
    7
  )));
$$;

grant execute on function public.trial_days() to authenticated, anon;


/* ------------------------------------------------------------ */
/* 3. Commercial fields the portal owns                           */
/*                                                               */
/* A discount recorded here is what the account page and any      */
/* future invoice should bill at. Nothing charges a card today -  */
/* Stripe is not wired - so this column IS the agreement.         */
/* ------------------------------------------------------------ */
alter table public.profiles add column if not exists discount_percent int;
alter table public.profiles add column if not exists discount_note    text;
alter table public.profiles add column if not exists admin_notes      text;

/* A comped account: a plan granted for good, with no renewal date and no
   charge, ever. It is `subscription_status = 'active'` with
   `current_period_end` null, which the site already handles - hasActivePlan()
   is true, so the customer has the full plan, and finalize_billing_period()
   returns immediately when there is no period end, so nothing ever rolls the
   period over or cancels it.

   The flag itself is what tells the portal that null period end was a decision
   rather than a gap in the data: it keeps the account out of the revenue
   figure and prints "free forever" instead of a missing date.

   A customer cannot set either column. protect_profile_billing() in the main
   schema copies only the fields a customer owns onto the old row and rejects
   the update if anything else moved, so every column added here is protected
   the moment it exists. */
alter table public.profiles add column if not exists comped        boolean not null default false;
alter table public.profiles add column if not exists comped_reason text;

do $$ begin
  alter table public.profiles
    add constraint profiles_discount_range
    check (discount_percent is null or (discount_percent >= 0 and discount_percent <= 100));
exception when duplicate_object then null; end $$;


/* ------------------------------------------------------------ */
/* 4. The audit log                                               */
/*                                                               */
/* Two people share this portal. Every write below appends here,  */
/* with the exact before/after of the fields that moved, so a     */
/* surprise in the data always has a name and a timestamp on it.  */
/* ------------------------------------------------------------ */
create table if not exists public.admin_audit (
  id           bigserial primary key,
  actor_id     uuid references auth.users (id) on delete set null,
  actor_email  text,
  target_user  uuid,
  target_email text,
  action       text not null,
  changes      jsonb not null default '{}'::jsonb,
  at           timestamptz not null default now()
);

create index if not exists admin_audit_at_idx on public.admin_audit (at desc);
create index if not exists admin_audit_target_idx on public.admin_audit (target_user, at desc);

alter table public.admin_audit enable row level security;

drop policy if exists "audit read admin" on public.admin_audit;
create policy "audit read admin" on public.admin_audit
  for select to authenticated
  using (public.is_portal_admin());


/* ------------------------------------------------------------ */
/* 5. Read access                                                 */
/*                                                                */
/* Admins read everything. The existing "own row" policies stay   */
/* untouched, so a customer still sees only themselves - these    */
/* are additional policies, and Postgres ORs them together.       */
/* ------------------------------------------------------------ */
drop policy if exists "profiles select admin" on public.profiles;
create policy "profiles select admin" on public.profiles
  for select to authenticated using (public.is_portal_admin());

drop policy if exists "drops select admin" on public.drops;
create policy "drops select admin" on public.drops
  for select to authenticated using (public.is_portal_admin());

drop policy if exists "creatives select admin" on public.creatives;
create policy "creatives select admin" on public.creatives
  for select to authenticated using (public.is_portal_admin());

/* The two public forms nobody could read from a browser until now. */
drop policy if exists "contact select admin" on public.contact_requests;
create policy "contact select admin" on public.contact_requests
  for select to authenticated using (public.is_portal_admin());

drop policy if exists "messages select admin" on public.messages;
create policy "messages select admin" on public.messages
  for select to authenticated using (public.is_portal_admin());


/* ------------------------------------------------------------ */
/* 6. Writes                                                      */
/*                                                                */
/* Deliberately NOT done with update policies. Every change goes  */
/* through a function that whitelists the fields it will touch    */
/* and writes the audit row in the same transaction, so there is  */
/* no way to change billing from the portal without leaving a     */
/* trace, and no way to reach a customer's brief by accident.     */
/*                                                                */
/* These run as the function owner, which is what carries them    */
/* past the protect_profile_billing trigger - that trigger only   */
/* polices the 'authenticated' and 'anon' roles.                  */
/* ------------------------------------------------------------ */

/* Internal: append one audit row. */
create or replace function public.admin_log(
  p_target  uuid,
  p_action  text,
  p_changes jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_mail  text;
  target_mail text;
begin
  select email into actor_mail  from public.portal_admins where user_id = auth.uid();
  select email into target_mail from public.profiles      where id      = p_target;

  insert into public.admin_audit (actor_id, actor_email, target_user, target_email, action, changes)
  values (auth.uid(), actor_mail, p_target, target_mail, p_action, coalesce(p_changes, '{}'::jsonb));
end;
$$;


/* admin_update_account - the one write the account editor calls.
   p_patch is a json object; only the keys listed here are honoured and
   anything else in it is ignored. Pass a key as an empty string to clear it. */
create or replace function public.admin_update_account(
  p_user  uuid,
  p_patch jsonb
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_row public.profiles;
  after_row  public.profiles;
  diff       jsonb := '{}'::jsonb;
  fld        text;
  allowed    text[] := array[
    'plan', 'billing_cycle', 'subscription_status',
    'trial_started_at', 'trial_ends_at', 'current_period_end',
    'cancel_at_period_end', 'pending_plan', 'pending_billing_cycle',
    'payment_method_at', 'discount_percent', 'discount_note', 'admin_notes',
    'comped', 'comped_reason'
  ];
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  select * into before_row from public.profiles where id = p_user;
  if before_row.id is null then
    raise exception 'No such account.';
  end if;

  update public.profiles p set
    plan                  = case when p_patch ? 'plan'                  then nullif(p_patch->>'plan','')::public.plan_tier           else p.plan end,
    billing_cycle         = case when p_patch ? 'billing_cycle'         then nullif(p_patch->>'billing_cycle','')                    else p.billing_cycle end,
    subscription_status   = case when p_patch ? 'subscription_status'   then nullif(p_patch->>'subscription_status','')::public.subscription_status else p.subscription_status end,
    trial_started_at      = case when p_patch ? 'trial_started_at'      then nullif(p_patch->>'trial_started_at','')::timestamptz    else p.trial_started_at end,
    trial_ends_at         = case when p_patch ? 'trial_ends_at'         then nullif(p_patch->>'trial_ends_at','')::timestamptz       else p.trial_ends_at end,
    current_period_end    = case when p_patch ? 'current_period_end'    then nullif(p_patch->>'current_period_end','')::timestamptz  else p.current_period_end end,
    payment_method_at     = case when p_patch ? 'payment_method_at'     then nullif(p_patch->>'payment_method_at','')::timestamptz   else p.payment_method_at end,
    cancel_at_period_end  = case when p_patch ? 'cancel_at_period_end'  then coalesce((p_patch->>'cancel_at_period_end')::boolean, false) else p.cancel_at_period_end end,
    pending_plan          = case when p_patch ? 'pending_plan'          then nullif(p_patch->>'pending_plan','')::public.plan_tier   else p.pending_plan end,
    pending_billing_cycle = case when p_patch ? 'pending_billing_cycle' then nullif(p_patch->>'pending_billing_cycle','')            else p.pending_billing_cycle end,
    discount_percent      = case when p_patch ? 'discount_percent'      then nullif(p_patch->>'discount_percent','')::int            else p.discount_percent end,
    discount_note         = case when p_patch ? 'discount_note'         then nullif(p_patch->>'discount_note','')                    else p.discount_note end,
    admin_notes           = case when p_patch ? 'admin_notes'           then nullif(p_patch->>'admin_notes','')                      else p.admin_notes end,
    comped                = case when p_patch ? 'comped'                then coalesce((p_patch->>'comped')::boolean, false)          else p.comped end,
    comped_reason         = case when p_patch ? 'comped_reason'         then nullif(p_patch->>'comped_reason','')                    else p.comped_reason end,
    updated_at            = now()
  where p.id = p_user
  returning * into after_row;

  /* Record only what actually moved. */
  foreach fld in array allowed loop
    if to_jsonb(before_row) -> fld is distinct from to_jsonb(after_row) -> fld then
      diff := diff || jsonb_build_object(fld, jsonb_build_object(
        'from', to_jsonb(before_row) -> fld,
        'to',   to_jsonb(after_row)  -> fld));
    end if;
  end loop;

  if diff <> '{}'::jsonb then
    perform public.admin_log(p_user, 'update_account', diff);
  end if;

  return after_row;
end;
$$;

grant execute on function public.admin_update_account(uuid, jsonb) to authenticated;


/* admin_grant_plan - hand an account a plan it never bought.
   p_days sets how long the granted period runs before it needs renewing.
   p_as_trial true records it as a trial, false as a paying subscription. */
create or replace function public.admin_grant_plan(
  p_user     uuid,
  p_plan     public.plan_tier,
  p_cycle    text default 'monthly',
  p_days     int default null,
  p_as_trial boolean default false,
  p_discount int default null,
  p_note     text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  after_row public.profiles;
  days      int;
  ends      timestamptz;
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  days := coalesce(p_days, case when p_as_trial then public.trial_days()
                                when p_cycle = 'annual' then 365 else 30 end);
  ends := now() + make_interval(days => days);

  update public.profiles set
    plan                  = p_plan,
    billing_cycle         = coalesce(p_cycle, 'monthly'),
    subscription_status   = case when p_as_trial then 'trialing'::public.subscription_status
                                 else 'active'::public.subscription_status end,
    trial_started_at      = case when p_as_trial then coalesce(trial_started_at, now()) else trial_started_at end,
    trial_ends_at         = case when p_as_trial then ends else trial_ends_at end,
    current_period_end    = ends,
    payment_method_at     = coalesce(payment_method_at, now()),
    cancel_at_period_end  = false,
    pending_plan          = null,
    pending_billing_cycle = null,
    discount_percent      = coalesce(p_discount, discount_percent),
    discount_note         = coalesce(p_note, discount_note),
    updated_at            = now()
  where id = p_user
  returning * into after_row;

  if after_row.id is null then
    raise exception 'No such account.';
  end if;

  perform public.admin_log(p_user, 'grant_plan', jsonb_build_object(
    'plan', p_plan, 'cycle', p_cycle, 'days', days,
    'as_trial', p_as_trial, 'runs_until', ends,
    'discount_percent', p_discount, 'note', p_note));

  return after_row;
end;
$$;

grant execute on function public.admin_grant_plan(uuid, public.plan_tier, text, int, boolean, int, text) to authenticated;


/* admin_set_plan_state - the one call behind the portal's plan editor.
   admin_grant_plan and the raw field edits above still work and are still
   what the advanced controls use, but everyday work goes through this: you
   say what the account should BE, and the function writes every field that
   state implies, so no combination of half-set columns can be left behind.

   p_mode is one of:

     'trial'    a trial running p_days more days from now. Sets both the trial
                end and the renewal date to the same moment, which is what the
                site's own start_trial does.

     'paying'   a paying subscription whose next charge is p_until (defaults to
                one month, or twelve for an annual cycle).

     'forever'  the plan for good: active, no renewal date, no trial end, and
                comped set so the portal knows the missing date was a decision.
                finalize_billing_period() on the site returns the moment it
                sees a null period end, so nothing ever renews or cancels this
                account. p_reason records why it was given.

     'none'     no plan. p_at_period_end true lets the plan run to the date it
                already has and cancel there (exactly what a customer clicking
                cancel gets); false ends it now.

   Every mode clears any pending plan switch - a scheduled change to a state
   that was just overwritten by hand is never what was meant. */
create or replace function public.admin_set_plan_state(
  p_user          uuid,
  p_mode          text,
  p_plan          public.plan_tier default null,
  p_cycle         text default null,
  p_days          int default null,
  p_until         timestamptz default null,
  p_at_period_end boolean default false,
  p_reason        text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_row public.profiles;
  after_row  public.profiles;
  cycle      text;
  ends       timestamptz;
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  select * into before_row from public.profiles where id = p_user;
  if before_row.id is null then
    raise exception 'No such account.';
  end if;

  if p_mode not in ('trial', 'paying', 'forever', 'none') then
    raise exception 'Unknown plan state: %', p_mode;
  end if;

  if p_mode <> 'none' and coalesce(p_plan, before_row.plan) is null then
    raise exception 'Pick a plan.';
  end if;

  cycle := coalesce(p_cycle, before_row.billing_cycle, 'monthly');

  if p_mode = 'trial' then
    if coalesce(p_days, 0) < 1 or p_days > 3650 then
      raise exception 'A trial runs between 1 and 3650 days.';
    end if;
    ends := now() + make_interval(days => p_days);

    update public.profiles set
      plan                  = coalesce(p_plan, plan),
      billing_cycle         = cycle,
      subscription_status   = 'trialing',
      trial_started_at      = coalesce(trial_started_at, now()),
      trial_ends_at         = ends,
      current_period_end    = ends,
      payment_method_at     = coalesce(payment_method_at, now()),
      cancel_at_period_end  = false,
      pending_plan          = null,
      pending_billing_cycle = null,
      comped                = false,
      comped_reason         = null,
      updated_at            = now()
    where id = p_user
    returning * into after_row;

  elsif p_mode = 'paying' then
    ends := coalesce(p_until, now() + case when cycle = 'annual'
                                           then interval '12 months'
                                           else interval '1 month' end);

    update public.profiles set
      plan                  = coalesce(p_plan, plan),
      billing_cycle         = cycle,
      subscription_status   = 'active',
      current_period_end    = ends,
      payment_method_at     = coalesce(payment_method_at, now()),
      cancel_at_period_end  = false,
      pending_plan          = null,
      pending_billing_cycle = null,
      comped                = false,
      comped_reason         = null,
      updated_at            = now()
    where id = p_user
    returning * into after_row;

  elsif p_mode = 'forever' then
    /* trial_ends_at has to go too. The site falls back to it when there is no
       period end, and a leftover trial date would print a charge that is
       never coming on the customer's own billing page. */
    update public.profiles set
      plan                  = coalesce(p_plan, plan),
      billing_cycle         = cycle,
      subscription_status   = 'active',
      trial_ends_at         = null,
      current_period_end    = null,
      payment_method_at     = coalesce(payment_method_at, now()),
      cancel_at_period_end  = false,
      pending_plan          = null,
      pending_billing_cycle = null,
      comped                = true,
      comped_reason         = nullif(p_reason, ''),
      updated_at            = now()
    where id = p_user
    returning * into after_row;

  else
    if p_at_period_end and before_row.current_period_end is not null
       and before_row.subscription_status in ('trialing', 'active') then
      /* Let it run out. finalize_billing_period() on the site is what turns
         this into 'canceled' when the date arrives, same as a customer
         cancelling from their own account page. */
      update public.profiles set
        cancel_at_period_end  = true,
        pending_plan          = null,
        pending_billing_cycle = null,
        updated_at            = now()
      where id = p_user
      returning * into after_row;
    else
      update public.profiles set
        subscription_status   = 'canceled',
        current_period_end    = null,
        cancel_at_period_end  = false,
        pending_plan          = null,
        pending_billing_cycle = null,
        comped                = false,
        comped_reason         = null,
        updated_at            = now()
      where id = p_user
      returning * into after_row;
    end if;
  end if;

  perform public.admin_log(p_user, 'set_plan_state', jsonb_build_object(
    'mode',        p_mode,
    'plan',        after_row.plan,
    'cycle',       after_row.billing_cycle,
    'status',      after_row.subscription_status,
    'runs_until',  after_row.current_period_end,
    'at_period_end', (p_mode = 'none' and after_row.cancel_at_period_end),
    'comped',      after_row.comped,
    'reason',      after_row.comped_reason,
    'was', jsonb_build_object(
      'plan',   before_row.plan,
      'status', before_row.subscription_status,
      'comped', before_row.comped)));

  return after_row;
end;
$$;

grant execute on function public.admin_set_plan_state(
  uuid, text, public.plan_tier, text, int, timestamptz, boolean, text) to authenticated;


/* admin_extend_trial - push a trial's end date out by p_days.
   Also moves the renewal date, so the account page and the billing
   fast-forward agree with what the customer was told. */
create or replace function public.admin_extend_trial(
  p_user uuid,
  p_days int
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  after_row public.profiles;
  base      timestamptz;
  found_id  uuid;
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  select id, greatest(coalesce(trial_ends_at, now()), now())
    into found_id, base
    from public.profiles where id = p_user;

  if found_id is null then
    raise exception 'No such account.';
  end if;

  update public.profiles set
    subscription_status = case when subscription_status is null or subscription_status = 'canceled'
                               then 'trialing'::public.subscription_status else subscription_status end,
    trial_started_at    = coalesce(trial_started_at, now()),
    trial_ends_at       = base + make_interval(days => p_days),
    current_period_end  = base + make_interval(days => p_days),
    payment_method_at   = coalesce(payment_method_at, now()),
    updated_at          = now()
  where id = p_user
  returning * into after_row;

  perform public.admin_log(p_user, 'extend_trial', jsonb_build_object(
    'days', p_days, 'new_end', after_row.trial_ends_at));

  return after_row;
end;
$$;

grant execute on function public.admin_extend_trial(uuid, int) to authenticated;


/* admin_set_setting - change a global setting, e.g. the default trial length. */
create or replace function public.admin_set_setting(
  p_key   text,
  p_value jsonb
)
returns public.app_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row_out    public.app_settings;
  before_val jsonb;
  actor_mail text;
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  select value into before_val from public.app_settings where key = p_key;
  select email into actor_mail from public.portal_admins where user_id = auth.uid();

  insert into public.app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), actor_mail)
  on conflict (key) do update
    set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by
  returning * into row_out;

  perform public.admin_log(null, 'set_setting', jsonb_build_object(
    'key', p_key, 'from', before_val, 'to', p_value));

  return row_out;
end;
$$;

grant execute on function public.admin_set_setting(text, jsonb) to authenticated;


/* ------------------------------------------------------------ */
/* 7. The dashboard numbers                                       */
/*                                                                */
/* One round trip instead of pulling every row into the browser   */
/* and counting there. Prices live here because nothing else in   */
/* the database knows them - they match checkout.js.              */
/* ------------------------------------------------------------ */
create or replace function public.plan_price(p_plan public.plan_tier, p_cycle text)
returns numeric
language sql
immutable
as $$
  select case p_plan
           when 'counter'    then 89
           when 'storefront' then 249
           when 'franchise'  then 690
           else 0
         end
       * case when p_cycle = 'annual' then 0.8 else 1 end;
$$;

create or replace function public.admin_stats()
returns json
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  out_json json;
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  /* c is every real customer. An admin's own Adronis login is a row in
     profiles like any other, and counting it would put a phantom account
     in the totals and a phantom bar in the signup chart. */
  with c as (
    select * from public.profiles
     where id not in (select user_id from public.portal_admins)
  )
  select json_build_object(
    'accounts',        (select count(*) from c),
    'onboarded',       (select count(*) from c where onboarded_at is not null),
    'trialing',        (select count(*) from c where subscription_status = 'trialing'),
    'active',          (select count(*) from c where subscription_status = 'active'),
    'past_due',        (select count(*) from c where subscription_status = 'past_due'),
    'canceled',        (select count(*) from c where subscription_status = 'canceled'),
    'no_subscription', (select count(*) from c where subscription_status is null),
    'cancelling',      (select count(*) from c where cancel_at_period_end),

    /* A comped account is 'active' and has the full plan, but it is not a
       customer in any revenue sense - it is counted on its own and left out
       of every money figure below. */
    'comped',          (select count(*) from c where comped),
    'paying',          (select count(*) from c where subscription_status = 'active' and not comped),

    /* Monthly recurring revenue, net of any discount recorded on the account.
       Trials count as zero - they are not paying yet. */
    'mrr', (
      select coalesce(round(sum(
               public.plan_price(plan, billing_cycle)
               * (1 - coalesce(discount_percent, 0) / 100.0)
             ), 2), 0)
        from c
       where subscription_status = 'active' and not comped
    ),
    'mrr_if_trials_convert', (
      select coalesce(round(sum(
               public.plan_price(plan, billing_cycle)
               * (1 - coalesce(discount_percent, 0) / 100.0)
             ), 2), 0)
        from c
       where subscription_status = 'trialing'
    ),

    'by_plan', (
      select coalesce(json_agg(t), '[]'::json) from (
        select coalesce(plan::text, 'none') as plan, count(*) as n
          from c group by 1 order by 2 desc
      ) t
    ),

    /* Signups per day for the last 30 days, zero-filled so the chart has
       a bar for every day rather than skipping the quiet ones. */
    'signups_30d', (
      select coalesce(json_agg(t order by t.day), '[]'::json) from (
        select d::date as day,
               (select count(*) from c
                 where c.created_at >= d and c.created_at < d + interval '1 day') as n
          from generate_series(
                 date_trunc('day', now()) - interval '29 days',
                 date_trunc('day', now()),
                 interval '1 day') d
      ) t
    ),

    'trials_ending_7d', (
      select coalesce(json_agg(t order by t.trial_ends_at), '[]'::json) from (
        select id, email, business_name, plan::text as plan, trial_ends_at
          from c
         where subscription_status = 'trialing'
           and trial_ends_at between now() and now() + interval '7 days'
      ) t
    ),

    'renewals_7d', (
      select coalesce(json_agg(t order by t.current_period_end), '[]'::json) from (
        select id, email, business_name, plan::text as plan, current_period_end
          from c
         where subscription_status = 'active'
           and current_period_end between now() and now() + interval '7 days'
      ) t
    ),

    'open_leads', (
      (select count(*) from public.contact_requests where status = 'new')
      + (select count(*) from public.messages where status = 'new')
    ),
    'discounted', (select count(*) from c where coalesce(discount_percent, 0) > 0),
    'trial_days', public.trial_days()
  ) into out_json;

  return out_json;
end;
$$;

grant execute on function public.admin_stats() to authenticated;



/* ------------------------------------------------------------ */
/* 7b. Make the trial-length setting actually take effect         */
/*                                                                */
/* The main schema hands out a hardcoded 7-day trial. This is the */
/* same function with that one number read from app_settings      */
/* instead, so changing it in the portal changes what the next    */
/* signup gets. Everything else is byte-identical to the original */
/* in adronis/supabase/schema.sql.                                */
/*                                                                */
/* NOTE: re-running the main schema.sql will overwrite this and   */
/* put the hardcoded 7 back. Run this file again afterwards.      */
/* ------------------------------------------------------------ */
create or replace function public.start_trial(
  p_plan  public.plan_tier,
  p_cycle text default 'monthly'
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row_out public.profiles;
  days    int := public.trial_days();
begin
  if auth.uid() is null then
    raise exception 'Not signed in.';
  end if;

  select * into row_out from public.profiles where id = auth.uid();

  if row_out.onboarded_at is null then
    raise exception 'Finish the business brief before starting a trial.';
  end if;

  if coalesce(p_plan, row_out.plan) is null or coalesce(p_plan, row_out.plan) = 'free' then
    raise exception 'Pick a paid plan to start a trial.';
  end if;

  /* Already on a trial or paying: don't restart the clock. */
  if row_out.subscription_status in ('trialing', 'active') then
    return row_out;
  end if;

  /* Returning customer: no second trial. The first period starts and is
     billed today, snapshotted into billing_history like any renewal. */
  if row_out.trial_started_at is not null then
    update public.profiles
       set plan                  = coalesce(p_plan, plan),
           billing_cycle         = coalesce(p_cycle, 'monthly'),
           payment_method_at     = now(),
           subscription_status   = 'active',
           current_period_end    = now() + case when coalesce(p_cycle, 'monthly') = 'annual'
                                                then interval '12 months' else interval '1 month' end,
           cancel_at_period_end  = false,
           pending_plan          = null,
           pending_billing_cycle = null,
           billing_history       = billing_history || jsonb_build_array(jsonb_build_object(
                                     'period_start', now(),
                                     'plan', coalesce(p_plan, row_out.plan),
                                     'cycle', coalesce(p_cycle, 'monthly')))
     where id = auth.uid()
     returning * into row_out;

    return row_out;
  end if;

  update public.profiles
     set plan                  = coalesce(p_plan, plan),
         billing_cycle         = coalesce(p_cycle, 'monthly'),
         payment_method_at     = now(),
         subscription_status   = 'trialing',
         trial_started_at      = now(),
         trial_ends_at         = now() + make_interval(days => days),
         current_period_end    = now() + make_interval(days => days),
         cancel_at_period_end  = false,
         pending_plan          = null,
         pending_billing_cycle = null
   where id = auth.uid()
   returning * into row_out;

  return row_out;
end;
$$;

grant execute on function public.start_trial(public.plan_tier, text) to authenticated;

/* ------------------------------------------------------------ */
/* 8. Seed - the only step that cannot be done from the portal    */
/*                                                                */
/* These two get in. Each address must already exist as a Supabase  */
/* user - the portal reuses the same login, it does not create      */
/* accounts of its own. Adding one more is another line here.       */
/*                                                                  */
/* To remove someone later:                                         */
/*   delete from public.portal_admins where email = 'them@x.com';   */
/* ------------------------------------------------------------ */
insert into public.portal_admins (user_id, email, label)
select u.id, u.email, 'owner'
  from auth.users u
 where u.email in (
   'andrejstefanovic2007@gmail.com',
   'dusan.imperl@gmail.com'
 )
on conflict (user_id) do nothing;

/* Says who actually landed in the table. If an address is missing from
   this result, that user does not exist in auth.users yet - check the
   spelling in the Supabase dashboard under Authentication -> Users. */
select email, label, added_at from public.portal_admins order by added_at;
