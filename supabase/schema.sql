-- SBBL database schema. Run in Supabase SQL Editor on a NEW project.
-- IMPORTANT: Read README.md and follow the one-time Super Admin bootstrap procedure.
create extension if not exists pgcrypto;

create type public.account_status as enum ('pending','approved','rejected','suspended');
create type public.app_role as enum ('super_admin','admin','member');
create type public.transaction_type as enum ('income','expense');
create type public.transaction_status as enum ('active','voided');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  email text not null unique,
  full_name text,
  avatar_url text,
  role public.app_role not null default 'member',
  status public.account_status not null default 'pending',
  status_reason text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type public.transaction_type not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(name,type)
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_date date not null,
  description text not null check (char_length(trim(description)) between 2 and 160),
  counterparty text check (counterparty is null or char_length(counterparty)<=120),
  category_id uuid not null references public.categories(id),
  type public.transaction_type not null,
  amount bigint not null check (amount > 0),
  payment_method text not null default 'cash' check (payment_method in ('cash','transfer','other')),
  notes text check (notes is null or char_length(notes)<=500),
  status public.transaction_status not null default 'active',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_by uuid references public.profiles(id),
  voided_at timestamptz,
  void_reason text
);

create table public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index transactions_date_idx on public.transactions(transaction_date desc);
create index transactions_status_date_idx on public.transactions(status,transaction_date desc);
create index transactions_category_idx on public.transactions(category_id);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index profiles_status_idx on public.profiles(status);

-- New Google sign-ins are always pending member accounts.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id,email,full_name,avatar_url,role,status)
  values(
    new.id,
    coalesce(new.email,''),
    coalesce(new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'name','Pengguna'),
    new.raw_user_meta_data->>'avatar_url',
    'member',
    'pending'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.status='approved');
$$;
create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.status='approved' and p.role in ('admin','super_admin'));
$$;
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.status='approved' and p.role='super_admin');
$$;

-- Profile: users may read their own profile; managers may read member directory.
alter table public.profiles enable row level security;
create policy "profile self read" on public.profiles for select to authenticated using (id=(select auth.uid()) and status='approved' or id=(select auth.uid()) and status in ('pending','rejected','suspended') or public.is_manager());
create policy "manager read profiles" on public.profiles for select to authenticated using (public.is_manager());
-- No client insert/update/delete policy: profile creation and status changes happen through trigger/RPC only.

alter table public.categories enable row level security;
create policy "approved users read categories" on public.categories for select to authenticated using (public.is_approved());
create policy "managers insert categories" on public.categories for insert to authenticated with check (public.is_manager() and created_by=(select auth.uid()));
create policy "managers update categories" on public.categories for update to authenticated using (public.is_manager()) with check (public.is_manager());

alter table public.transactions enable row level security;
create policy "approved users read active transactions" on public.transactions for select to authenticated using (public.is_approved() and (status='active' or public.is_manager()));
-- No direct insert/update/delete policies. Transaction writes go through guarded RPC.

alter table public.system_settings enable row level security;
create policy "approved users read settings" on public.system_settings for select to authenticated using (public.is_approved());
-- no client update policy

alter table public.audit_logs enable row level security;
create policy "managers read audit logs" on public.audit_logs for select to authenticated using (public.is_manager());
-- no client insert/update/delete policy

-- Record important actions. Trigger writes actor from authenticated database context.
create or replace function public.write_audit_log()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare actor uuid; actor_mail text; act text; obj_id text; detail jsonb;
begin
  actor := auth.uid();
  select p.email into actor_mail from public.profiles p where p.id=actor;
  if tg_op='INSERT' then act:='INSERT'; obj_id:=new.id::text; detail:=to_jsonb(new);
  elsif tg_op='UPDATE' then act:='UPDATE'; obj_id:=new.id::text; detail:=jsonb_build_object('before',to_jsonb(old),'after',to_jsonb(new));
  else act:='DELETE'; obj_id:=old.id::text; detail:=to_jsonb(old);
  end if;
  insert into public.audit_logs(actor_id,actor_email,action,entity,entity_id,details)
  values(actor,actor_mail,act,tg_table_name,obj_id,detail);
  return coalesce(new,old);
end;
$$;
create trigger transaction_audit after insert or update or delete on public.transactions for each row execute procedure public.write_audit_log();
create trigger category_audit after insert or update or delete on public.categories for each row execute procedure public.write_audit_log();

-- Atomic transaction insert; verifies role, category, and amount on database side.
create or replace function public.create_transaction(p_transaction jsonb)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare new_id uuid; v_type public.transaction_type; v_category uuid; v_amount bigint;
begin
  if not public.is_manager() then raise exception 'Akses ditolak: hanya Admin yang dapat mencatat transaksi.'; end if;
  v_type := (p_transaction->>'type')::public.transaction_type;
  v_category := (p_transaction->>'category_id')::uuid;
  v_amount := (p_transaction->>'amount')::bigint;
  if v_amount is null or v_amount<=0 then raise exception 'Nominal harus lebih besar dari nol.'; end if;
  if not exists(select 1 from public.categories c where c.id=v_category and c.type=v_type and c.is_active) then
    raise exception 'Kategori tidak sesuai atau tidak aktif.';
  end if;
  insert into public.transactions(transaction_date,description,counterparty,category_id,type,amount,payment_method,notes,created_by)
  values(
    (p_transaction->>'transaction_date')::date,
    trim(p_transaction->>'description'),
    nullif(trim(p_transaction->>'counterparty'),''),
    v_category,v_type,v_amount,
    coalesce(p_transaction->>'payment_method','cash'),
    nullif(trim(p_transaction->>'notes'),''),
    auth.uid()
  ) returning id into new_id;
  return new_id;
end;
$$;

-- Member management. Admin can approve/reject/suspend ordinary members only.
-- Super Admin alone can manage admin appointments/demotions (separate future RPC).
create or replace function public.manage_member(p_user_id uuid,p_action text,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare target public.profiles%rowtype; actor_role public.app_role;
begin
  select role into actor_role from public.profiles where id=auth.uid() and status='approved';
  if actor_role not in ('admin','super_admin') then raise exception 'Akses ditolak.'; end if;
  select * into target from public.profiles where id=p_user_id for update;
  if not found then raise exception 'Anggota tidak ditemukan.'; end if;
  if target.role in ('admin','super_admin') then raise exception 'Admin dan Super Admin tidak dapat dikelola melalui tindakan anggota biasa.'; end if;
  if p_action='approve' then
    update public.profiles set status='approved',status_reason=null,reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=p_user_id;
  elsif p_action='reject' then
    if nullif(trim(p_reason),'') is null then raise exception 'Alasan penolakan wajib diisi.'; end if;
    update public.profiles set status='rejected',status_reason=trim(p_reason),reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=p_user_id;
  elsif p_action='suspend' then
    if target.status<>'approved' then raise exception 'Hanya anggota aktif yang dapat dinonaktifkan.'; end if;
    if nullif(trim(p_reason),'') is null then raise exception 'Alasan penonaktifan wajib diisi.'; end if;
    update public.profiles set status='suspended',status_reason=trim(p_reason),reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=p_user_id;
  else raise exception 'Tindakan tidak dikenal.'; end if;
  insert into public.audit_logs(actor_id,actor_email,action,entity,entity_id,details)
  select auth.uid(),email,'MEMBER_'||upper(p_action),'profiles',p_user_id::text,jsonb_build_object('previous_status',target.status,'new_status',p_action,'reason',p_reason)
  from public.profiles where id=auth.uid();
end;
$$;

-- Initial settings and starter categories.
insert into public.system_settings(key,value) values
('opening_balance','{"amount":0,"effective_date":"2026-11-04"}'::jsonb)
on conflict(key) do nothing;

insert into public.categories(name,type) values
('Iuran Kas','income'),('Sumbangan','income'),('Pemasukan Lainnya','income'),
('Konsumsi','expense'),('Kegiatan Sosial','expense'),('Transportasi','expense'),('Perlengkapan','expense'),('Pengeluaran Lainnya','expense')
on conflict(name,type) do nothing;

-- Grant only intended RPC execution to authenticated users; function performs authorization itself.
revoke all on function public.create_transaction(jsonb) from public;
grant execute on function public.create_transaction(jsonb) to authenticated;
revoke all on function public.manage_member(uuid,text,text) from public;
grant execute on function public.manage_member(uuid,text,text) to authenticated;
grant execute on function public.is_approved() to authenticated;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.is_super_admin() to authenticated;
