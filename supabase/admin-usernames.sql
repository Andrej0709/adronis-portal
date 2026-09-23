/* ------------------------------------------------------------ */
/* Give the portal admins usernames.                              */
/*                                                                */
/* Run in: Supabase Dashboard -> SQL Editor. Safe to re-run.       */
/* Change a name here and run it again to rename someone. An admin */
/* without a username is shown by their email, as before.          */
/* ------------------------------------------------------------ */
alter table public.portal_admins add column if not exists username text;

update public.portal_admins set username = 'Andrej' where email = 'andrejstefanovic2007@gmail.com';
update public.portal_admins set username = 'Dušan'  where email = 'dusan.imperl@gmail.com';

select email, username from public.portal_admins order by added_at;
