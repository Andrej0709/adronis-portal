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
/* Empty for now. The free trial length used to live here; it is  */
/* set on the Paddle trial prices now (see 7b).                   */
/* ------------------------------------------------------------ */
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.app_settings enable row level security;

drop policy if exists "settings read admin" on public.app_settings;
create policy "settings read admin" on public.app_settings
  for select to authenticated
  using (public.is_portal_admin());


/* ------------------------------------------------------------ */
/* 3. Commercial fields the portal owns                           */
/*                                                               */
/* discount_percent is the per-account discount agreed with the   */
/* customer. The portal sets it through the site's paddle Edge    */
/* Function, which puts it on the Paddle subscription - so it is  */
/* what Paddle charges, not only a note - and the account page    */
/* and the revenue figure read it from here.                      */
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


/* Every trial and paid plan is a Paddle subscription. Paddle is where it is
   charged, and the site's paddle Edge Function mirrors it onto the profile.
   So nothing here writes a trial, a paid plan, a renewal date or a discount:
   the portal changes those through that Edge Function (admin_set_plan and
   admin_set_discount), which makes the change in Paddle and records it in
   admin_audit the same way these functions do.

   What is left for the database alone is what Paddle has no part in: giving a
   plan away for good to an account with no running subscription, ending
   such a plan, and the portal's own notes. */

/* True while Paddle is billing this account - then it is Paddle's to change. */
create or replace function public.admin_paddle_running(p public.profiles)
returns boolean
language sql
immutable
as $$
  select p.paddle_subscription_id is not null
     and not p.comped
     and p.subscription_status in ('trialing', 'active', 'past_due');
$$;


/* admin_update_account - the portal's own notes on an account.
   p_patch is a json object; only the keys listed here are honoured and
   anything else in it is ignored. Pass a key as an empty string to clear it.
   Billing fields are not among them: Paddle writes those. */
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
  allowed    text[] := array['admin_notes', 'comped_reason'];
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  select * into before_row from public.profiles where id = p_user;
  if before_row.id is null then
    raise exception 'No such account.';
  end if;

  update public.profiles p set
    admin_notes   = case when p_patch ? 'admin_notes'   then nullif(p_patch->>'admin_notes','')   else p.admin_notes end,
    comped_reason = case when p_patch ? 'comped_reason' and p.comped
                         then nullif(p_patch->>'comped_reason','') else p.comped_reason end,
    updated_at    = now()
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


/* Handing out trials and paid plans by hand is gone: a plan nobody pays for
   through Paddle is never charged, so it was a free plan wearing a price. */
drop function if exists public.admin_grant_plan(uuid, public.plan_tier, text, int, boolean, int, text);
drop function if exists public.admin_extend_trial(uuid, int);


/* admin_set_plan_state - the plan editor, for an account Paddle is not
   billing. You say what the account should BE, and the function writes every
   field that state implies, so no combination of half-set columns can be left
   behind.

   p_mode is one of:

     'forever'  the plan for good: active, no renewal date, no trial end, and
                comped set so the portal knows the missing date was a decision.
                finalize_billing_period() on the site returns the moment it
                sees a null period end, so nothing ever renews or cancels this
                account. p_reason records why it was given.

     'none'     no plan. p_at_period_end true lets a plan run to the date it
                already has and end there; false ends it now.

   'trial' and 'paying' are refused: those start at checkout, where Paddle
   takes the card. An account Paddle is billing is refused outright - the
   portal changes it through the paddle Edge Function instead. */
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
begin
  if not public.is_portal_admin() then
    raise exception 'Not an admin.';
  end if;

  select * into before_row from public.profiles where id = p_user;
  if before_row.id is null then
    raise exception 'No such account.';
  end if;

  if public.admin_paddle_running(before_row) then
    raise exception 'This account pays through Paddle - change it in Paddle, not in the database.';
  end if;

  if p_mode in ('trial', 'paying') then
    raise exception 'Trials and paid plans start at checkout, where Paddle takes the card.';
  end if;

  if p_mode not in ('forever', 'none') then
    raise exception 'Unknown plan state: %', p_mode;
  end if;

  if p_mode = 'forever' and coalesce(p_plan, before_row.plan) is null then
    raise exception 'Pick a plan.';
  end if;

  if p_mode = 'forever' then
    /* trial_ends_at has to go too. The site falls back to it when there is no
       period end, and a leftover trial date would print a charge that is
       never coming on the customer's own billing page. */
    update public.profiles set
      plan                  = coalesce(p_plan, plan),
      billing_cycle         = coalesce(p_cycle, billing_cycle, 'monthly'),
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

  elsif p_at_period_end and before_row.current_period_end is not null
        and before_row.current_period_end > now()
        and before_row.subscription_status in ('trialing', 'active') then
    /* Let it run out. finalize_billing_period() on the site ends a plan with
       no Paddle subscription behind it once its date has passed. */
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


/* admin_set_setting - change a global setting in app_settings. */
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
/* the database knows them - they match checkout.js and the       */
/* Paddle catalog (list price, VAT included, before any promo).   */
/*                                                                */
/* collected_30d is what Paddle actually charged in the last 30    */
/* days: the paddle Edge Function writes each paid invoice into    */
/* billing_history with its real amount, promo codes and all.      */
/* ------------------------------------------------------------ */
create or replace function public.plan_price(p_plan public.plan_tier, p_cycle text)
returns numeric
language sql
immutable
as $$
  select case p_plan
           when 'counter'    then 59
           when 'storefront' then 149
           when 'franchise'  then 490
           else 0
         end
       * case when p_cycle = 'annual' then 0.8 else 1 end;
$$;

/* The discount Paddle takes off an account's charges, as the paddle Edge
   Function mirrors it into paddle_discount - a promo code from checkout or a
   discount agreed in the portal. Null once it has run out, or with no
   subscription to take it off. */
create or replace function public.live_discount(p_discount jsonb, p_subscription text)
returns jsonb
language sql
stable
as $$
  select case
           when p_subscription is null or p_discount is null then null
           when (p_discount->>'ends_at') is not null
                and (p_discount->>'ends_at')::timestamptz <= now() then null
           else p_discount
         end;
$$;

/* A monthly list price with that discount taken off. A flat discount comes
   off every charge (in cents), so on an annual plan a twelfth of it a month. */
create or replace function public.net_monthly(p_price numeric, p_discount jsonb, p_cycle text)
returns numeric
language sql
immutable
as $$
  select case
           when p_discount is null then p_price
           when p_discount->>'type' = 'percentage'
             then p_price * (1 - (p_discount->>'amount')::numeric / 100)
           else greatest(0, p_price - (p_discount->>'amount')::numeric / 100
                                    / case when p_cycle = 'annual' then 12 else 1 end)
         end;
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
               public.net_monthly(public.plan_price(plan, billing_cycle),
                                  public.live_discount(paddle_discount, paddle_subscription_id), billing_cycle)
             ), 2), 0)
        from c
       where subscription_status = 'active' and not comped
    ),
    'mrr_if_trials_convert', (
      select coalesce(round(sum(
               public.net_monthly(public.plan_price(plan, billing_cycle),
                                  public.live_discount(paddle_discount, paddle_subscription_id), billing_cycle)
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
    'discounted', (select count(*) from c
                    where public.live_discount(paddle_discount, paddle_subscription_id) is not null
                       or coalesce(discount_percent, 0) > 0),

    'collected_30d', (
      select coalesce(round(sum((e->>'amount')::numeric), 2), 0)
        from c, jsonb_array_elements(coalesce(c.billing_history, '[]'::jsonb)) e
       where jsonb_typeof(e->'amount') = 'number'
         and (e->>'period_start')::timestamptz >= now() - interval '30 days'
    ),
    'invoices_30d', (
      select count(*)
        from c, jsonb_array_elements(coalesce(c.billing_history, '[]'::jsonb)) e
       where jsonb_typeof(e->'amount') = 'number'
         and (e->>'period_start')::timestamptz >= now() - interval '30 days'
    )
  ) into out_json;

  return out_json;
end;
$$;

grant execute on function public.admin_stats() to authenticated;



/* ------------------------------------------------------------ */
/* 7b. start_trial stays shut                                     */
/*                                                                */
/* Earlier versions of this file replaced the site's start_trial  */
/* and granted it to every signed-in user again - which let       */
/* anyone start a trial, or a second "paid" plan, from the        */
/* browser console without Paddle. Trials start at checkout now,  */
/* so this file never touches start_trial again, and running it   */
/* shuts the function whichever file ran last.                    */
/*                                                                */
/* The trial length is set on the Paddle trial prices and in the  */
/* site's copy, not here, so the setting that used to feed        */
/* start_trial goes with it.                                      */
/* ------------------------------------------------------------ */
do $$ begin
  revoke execute on function public.start_trial(public.plan_tier, text) from public, anon, authenticated;
exception when undefined_function then null; end $$;

drop function if exists public.trial_days();
delete from public.app_settings where key = 'trial_days';

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
