/* ------------------------------------------------------------ */
/* Seed portal admins.                                            */
/*                                                                */
/* Run in: Supabase Dashboard -> SQL Editor, after portal-admin.sql */
/* has already been run once (creates public.portal_admins).       */
/*                                                                  */
/* Each address must already exist as a Supabase user under          */
/* Authentication -> Users - this only grants portal admin access,   */
/* it does not create accounts. Safe to re-run.                      */
/*                                                                    */
/* To remove someone later:                                           */
/*   delete from public.portal_admins where email = 'them@x.com';     */
/* ------------------------------------------------------------ */
insert into public.portal_admins (user_id, email, label)
select u.id, u.email, 'owner'
  from auth.users u
 where u.email in (
   'dusan.imperl@gmail.com',
   'andrejstefanovic2007@gmail.com'
 )
on conflict (user_id) do nothing;

/* Says who actually landed in the table. If an address is missing from
   this result, that user does not exist in auth.users yet - check the
   spelling in the Supabase dashboard under Authentication -> Users. */
select email, label, added_at from public.portal_admins order by added_at;
