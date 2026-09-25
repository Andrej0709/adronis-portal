# Adronis Portal

The internal side of adronis.app: one page that reads the same Supabase
database the customer site uses, and changes the commercial part of an
account — plan, trial end, next charge, discount.

Every trial and paid plan is a Paddle subscription. Paddle is where it is
charged, and the site's `paddle` Edge Function mirrors it onto the account.
So the portal never writes billing into the database as if a customer had
paid: a change to a paying account is made in Paddle, through that same Edge
Function, and the account follows from Paddle's answer.

It is a separate site. Nothing in the Adronis repository imports from here,
and nothing here is served from adronis.app.

## What it can and cannot do

**Can**

- List every account with its plan, status, discount, monthly revenue and dates
- Change a paying account in Paddle: move a trial's end, end a trial and
  charge today, move the next charge, switch plan from the next charge, cancel
- Give a plan away for good: full access, no renewal date, never charged — the
  Paddle subscription behind it, if any, is cancelled first
- Put a per-account discount on the Paddle subscription, with the note
  explaining it
- Keep a private internal note per account
- Show what Paddle actually collected in the last 30 days, and each invoice
- Sign itself out after half an hour with nobody touching it
- Show what the account filled in — the business brief — read only
- Show who changed what, and when

**Cannot**

- Start a trial or a paid plan. Those start at checkout, where Paddle takes the
  card; a plan set in the database with nobody charging for it would just be a
  free plan wearing a price.
- Write billing fields by hand. **Advanced** shows every one of them, read only.
- Change the trial length. It is 7 days, set on the Paddle trial prices and
  written into the site's copy, so it is changed there.
- Edit the business brief, or anything else the customer owns
- Delete an account or any row
- Add or remove its own admins — that is done in the Supabase SQL editor

## The plan editor

Open any account and the first thing in the drawer is one sentence saying where
that account stands, then four buttons for where it should stand. Each one asks
only for what it needs, and a line underneath spells out what pressing **Apply**
will leave behind before you press it. Anything that charges the card or takes
the plan away asks first.

### An account that pays through Paddle

The drawer says *Pays through Paddle* with the subscription and customer IDs,
and **Apply** goes to the Edge Function (`admin_set_plan`):

| | What happens in Paddle |
| --- | --- |
| **Trial** | Only while Paddle still has it on trial: the trial end moves to the new date. A paying account can't go back on a trial. |
| **Paying** | On a trial: the trial ends and the card is charged today. Already paying: the next charge moves to the date you pick, and the days in between are free. |
| **Free forever** | The Paddle subscription is cancelled today, then the account is given the plan for good (below). |
| **No plan** | Paddle cancels at the end of the period, or today. |

A plan or cycle switch is billed from the next charge, the same as when the
customer switches on their own account page. If the customer already has a
switch waiting, the editor opens on that plan, so **Apply** doesn't undo it.

### An account with no running Paddle subscription

Only **Free forever** and **No plan** do anything; both go through
`admin_set_plan_state`, which refuses trials, paid plans, and any account Paddle
is billing. **Trial** and **Paying** say to send the customer to checkout.

An account that still has a dated plan set by hand from before Paddle is shown
as such: nothing charges it, and the site ends it on its date.

### The discount

**Save changes** sends it to the Edge Function (`admin_set_discount`). On a
paying account it goes onto the Paddle subscription at once, as a percentage off
every charge from the next one on — in place of any promo code used at checkout.
On any other account it is recorded, and the Edge Function puts it on the
subscription the moment the customer checks out, unless they used a promo code
there. Each percentage is one *custom* Paddle discount (hidden from the catalog,
can't be typed in at checkout), shared by every account on that percentage.

Every change the Edge Function makes writes the same `admin_audit` row the SQL
functions do, marked *in Paddle* in the log.

Deploy the site's `supabase/functions/paddle` again whenever it changes — the
portal's Paddle choices only work against a version that has these actions.

### What "free forever" actually is

`subscription_status = 'active'` and `current_period_end` null.

The site already handles that pair without knowing anything about this portal.
`hasActivePlan()` is true, so the customer has the full plan. And
`finalize_billing_period()` returns the moment it sees a null period end, so
nothing ever rolls the period over, appends an invoice, or acts on a
cancellation. It simply stays.

The `comped` column records that the missing date was a decision rather than a
gap in the data. That is what keeps the account out of the monthly revenue
figure — it is active like any other, but it was given away — and what prints
*free forever* in the table instead of a missing date. `comped_reason` is the
one line saying why.

One change was needed on the customer site for this, in
`adronis/account.js`: with no renewal date there is no next invoice, so the
billing page no longer prints an upcoming charge, the status reads
*Active — nothing to pay*, and the switch-plan and cancel controls step out of
the way. Without it a comped account would have seen an invalid date and a
charge that is never coming.

## Setting it up

### 1. Run the SQL

Open the Supabase dashboard for the Adronis project, go to **SQL Editor**, paste
the whole of `supabase/portal-admin.sql` and run it. It is idempotent — running
it twice is harmless. Run it again whenever that file changes: the plan editor
calls a function that only exists once it has been run.

The last block of that file is the admin list. It already names
`andrejstefanovic2007@gmail.com` and `dusan.imperl@gmail.com`; a third person
is one more line. Each address must already exist as a Supabase user — the
portal reuses the Adronis login, it does not create accounts of its own.

The file ends by printing the admin table, so the result pane tells you who
actually got in. An address that is missing from that list does not exist in
`auth.users` under that exact spelling.

### An admin account with no business behind it

You do not have to sign up as a customer to get in. In the Supabase dashboard,
**Authentication → Users → Add user**: email, password, and tick *Auto Confirm
User*. That is enough to sign into the portal.

Adronis creates a `profiles` row for every new user, so that account will have
one too — but it stays empty: no business name, no brief, no plan, no trial.
Nothing on the customer site treats it as a customer, and the portal hides
accounts that are in `portal_admins` from the account list and leaves them out
of every number on the overview, so your own login never shows up as a
phantom signup.

If you would rather use an account you already have on adronis.app, that works
too — just add its address to the seed block.

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

## It signs itself out

Half an hour with nobody touching the page ends the session: the portal signs
out and the login screen says why. The last minute of that is spent saying so,
with a bar at the bottom of the screen and a **Stay signed in** button — though
any click, keypress or scroll anywhere is enough, so it is only there to stop a
half-filled form disappearing under you.

Activity is shared between tabs, so working in one keeps the others alive. The
check compares timestamps rather than trusting a timer, which means a laptop
that slept through the afternoon comes back to an expired session rather than
to a live one waiting for a timer that never fired.

This is not a security boundary by itself — it runs in the browser, and it is
the database that decides what any token may read. It is for the ordinary case:
the portal left open on a laptop, with every customer's email address and every
figure in the business on the screen behind whoever walks past it.

## Why there is no secret key here

`supabase-config.js` holds the same public anon key the customer site holds.
That key grants nothing by itself — every table has row level security on, and
what an admin may read is decided by policies that call `is_portal_admin()`.

Writes do not go through table policies at all. In the database they go
through `admin_set_plan_state`, `admin_update_account` and `admin_set_setting`,
which each check `is_portal_admin()`, touch only the fields they name, and
write a row into `admin_audit` in the same transaction. Everything that touches
Paddle goes through the site's `paddle` Edge Function, which checks the caller
is in `portal_admins` before it does anything and writes the same audit row.
So there is no change made from this portal that does not leave a trace, and no
path from this portal to a customer's brief.

The `service_role` key is never used here and must never be pasted into this
folder. It bypasses row level security completely.

## One thing to watch

Earlier versions of `supabase/portal-admin.sql` replaced the site's
`public.start_trial` and granted it to every signed-in user, which let anyone
start a trial — or a paid plan — from the browser console without Paddle. The
current file never touches that function except to shut it, so it is safe to
run in any order with the Adronis `supabase/schema.sql`. Run the current one at
least once to close the gap if an older one was ever run after the schema.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole page: login gate, four tabs, edit drawer |
| `portal.js` | Auth, data loading, rendering, every write |
| `portal.css` | Adronis palette, laid out for dense reading |
| `supabase-config.js` | Project URL and public anon key — same as the site |
| `supabase/portal-admin.sql` | Admin list, policies, write functions, stats |
| `vercel.json` | `noindex` headers, no HTML caching |
