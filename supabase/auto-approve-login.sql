-- SBBL: aktifkan login Google otomatis untuk akun baru.
-- Jalankan SEKALI di Supabase Dashboard > SQL Editor.
-- Tidak menghapus data, transaksi, kategori, atau akun Super Admin yang sudah ada.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles(id,email,full_name,avatar_url,role,status,reviewed_at)
  values (
    new.id,
    coalesce(new.email,''),
    coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name','Pengguna'),
    new.raw_user_meta_data->>'avatar_url',
    'member',
    'approved',
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Akun member lama yang masih pending diaktifkan sesuai keputusan pemilik sistem.
-- Akun rejected/suspended tidak disentuh.
update public.profiles
set status='approved', status_reason=null, reviewed_at=now(), updated_at=now()
where status='pending' and role='member';

-- Pastikan setiap pengguna yang login dapat membaca profilnya sendiri,
-- termasuk status akun, sementara data profil pengguna lain tetap terbatas.
drop policy if exists "profile self read" on public.profiles;
create policy "profile self read" on public.profiles
for select to authenticated
using (id=(select auth.uid()) or public.is_manager());

-- Pastikan fungsi trigger dapat dipanggil oleh Supabase Auth.
grant usage on schema public to authenticated;

-- Batas peran ditegakkan di database agar tidak dapat dilewati dari browser.
create or replace function public.enforce_profile_role_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare role_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('sbbl_profile_role_limits'));
  if tg_op='UPDATE' then
    if new.role is not distinct from old.role then return new; end if;
  end if;
  if new.role='admin' then
    select count(*) into role_count from public.profiles p where p.role='admin' and p.id<>new.id;
    if role_count>=4 then raise exception 'Maksimal hanya 4 Admin biasa.'; end if;
  elsif new.role='member' then
    select count(*) into role_count from public.profiles p where p.role='member' and p.id<>new.id;
    if role_count>=50 then raise exception 'Kapasitas anggota SBBL maksimal 50 akun.'; end if;
  elsif new.role='super_admin' then
    select count(*) into role_count from public.profiles p where p.role='super_admin' and p.id<>new.id;
    if role_count>=1 then raise exception 'SBBL hanya memiliki 1 Super Admin.'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profile_role_limits on public.profiles;
create trigger profile_role_limits
before insert or update on public.profiles
for each row execute procedure public.enforce_profile_role_limits();

-- Hanya Super Admin yang dapat mengangkat atau menurunkan Admin.
create or replace function public.set_admin_role(p_user_id uuid,p_make_admin boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare target public.profiles%rowtype; next_role public.app_role;
begin
  if not public.is_super_admin() then raise exception 'Hanya Super Admin yang dapat mengatur Admin.'; end if;
  select * into target from public.profiles where id=p_user_id for update;
  if not found then raise exception 'Akun tidak ditemukan.'; end if;
  if target.status<>'approved' then raise exception 'Hanya akun aktif yang dapat diubah rolenya.'; end if;
  if target.role='super_admin' then raise exception 'Role Super Admin tidak dapat diubah melalui menu ini.'; end if;
  if p_make_admin then
    if target.role<>'member' then raise exception 'Akun ini bukan Anggota.'; end if;
    next_role:='admin';
  else
    if target.role<>'admin' then raise exception 'Akun ini bukan Admin.'; end if;
    next_role:='member';
  end if;
  update public.profiles set role=next_role,updated_at=now(),reviewed_by=auth.uid(),reviewed_at=now() where id=p_user_id;
  insert into public.audit_logs(actor_id,actor_email,action,entity,entity_id,details)
  select auth.uid(),email,case when p_make_admin then 'PROMOTE_ADMIN' else 'DEMOTE_ADMIN' end,
    'profiles',p_user_id::text,jsonb_build_object('email',target.email,'old_role',target.role,'new_role',next_role)
  from public.profiles where id=auth.uid();
end;
$$;

revoke all on function public.set_admin_role(uuid,boolean) from public;
grant execute on function public.set_admin_role(uuid,boolean) to authenticated;
revoke all on function public.enforce_profile_role_limits() from public;
