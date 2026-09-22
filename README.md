# Adronis Portal

The internal side of adronis.app: one page that reads the same Supabase
database the customer site uses, and changes the commercial part of an
account — plan, subscription status, trial dates, renewal date, discount.

It is a separate site. Nothing in the Adronis repository imports from here,
and nothing here is served from adronis.app.

## What it can and cannot do

**Can**

- List every account with its plan, status, discount, monthly revenue and dates
- Change a plan, a billing cycle, a subscription status
- Grant a plan to an account that never bought one, with no checkout and no card
- Extend a trial, or set the trial end and the next charge date by hand
- Record a per-account discount and the note explaining it
- Keep a private internal note per account
- Change the default trial length for every future signup
- Show what the account filled in — the business brief — read only
- Show who changed what, and when

**Cannot**

- Edit the business brief, or anything else the customer owns
- Delete an account or any row
- Add or remove its own admins — that is done in the Supabase SQL editor
- Charge a card. Stripe is not wired into Adronis yet, so a discount recorded
  here is the agreement, not an instruction to a payment processor.

## Setting it up

### 1. Run the SQL

Open the Supabase dashboard for the Adronis project, go to **SQL Editor**, paste
the whole of `supabase/portal-admin.sql` and run it. It is idempotent — running
it twice is harmless.

Before you run it, edit the last block of that file and put in the two email
addresses that should get in. Each one must already have an Adronis account —
the portal reuses the Adronis login, it does not create accounts of its own.
If your partner has not signed up on adronis.app yet, have them do that first,
then add their address and run the file again.

To add or remove an admin later:

```sql
insert into public.portal_admins (user_id, email, label)
select id, email, 'partner' from auth.users where email = 'them@example.com';

delete from public.portal_admins where email = 'them@example.com';
```

### 2. Deploy

Push this folder to its own Git repository and import it into Vercel as a
**new project** — not as part of the Adronis project. No build command, no
framework preset; it is static files.

Give it a URL nobody would guess or a subdomain like `portal.adronis.app`.
Anyone can open the page, but without an admin account they see the login
screen and nothing else: the database itself refuses to hand out a single row
to a signed-in user who is not in `portal_admins`.

### 3. Sign in

Your normal Adronis email and password.

## Why there is no secret key here

`supabase-config.js` holds the same public anon key the customer site holds.
That key grants nothing by itself — every table has row level security on, and
what an admin may read is decided by policies that call `is_portal_admin()`.

Writes do not go through table policies at all. They go through
`admin_update_account`, `admin_grant_plan`, `admin_extend_trial` and
`admin_set_setting`, which each check `is_portal_admin()`, touch only the
fields they name, and write a row into `admin_audit` in the same transaction.
So there is no change made from this portal that does not leave a trace, and no
path from this portal to a customer's brief.

The `service_role` key is never used here and must never be pasted into this
folder. It bypasses row level security completely.

## One thing to watch

`supabase/portal-admin.sql` redefines `public.start_trial` so the trial length
comes from the `app_settings` table instead of the hardcoded 7 days in the
Adronis schema. If you ever re-run the Adronis `supabase/schema.sql`, it will
put the hardcoded 7 back — run `portal-admin.sql` again afterwards.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole page: login gate, four tabs, edit drawer |
| `portal.js` | Auth, data loading, rendering, every write |
| `portal.css` | Adronis palette, laid out for dense reading |
| `supabase-config.js` | Project URL and public anon key — same as the site |
| `supabase/portal-admin.sql` | Admin list, policies, write functions, stats |
| `vercel.json` | `noindex` headers, no HTML caching |
