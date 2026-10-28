-- Storage for the voice-profile-mcp connector.
-- Only the edge function (service_role) touches these tables; RLS is on with no
-- policies and anon/authenticated grants are revoked, so the public API keys
-- cannot read or write them.

create table public.voice_profiles (
  name text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);

create table public.voice_profile_history (
  id bigint generated always as identity primary key,
  name text not null,
  content text not null,
  saved_at timestamptz not null default now()
);

create index voice_profile_history_name_saved_at_idx on public.voice_profile_history (name, saved_at desc);

-- SHA-256 (hex) of each valid connector URL token. Plaintext tokens are never stored.
create table public.connector_tokens (
  token_hash text primary key,
  label text,
  created_at timestamptz not null default now()
);

alter table public.voice_profiles enable row level security;
alter table public.voice_profile_history enable row level security;
alter table public.connector_tokens enable row level security;

revoke all on public.voice_profiles, public.voice_profile_history, public.connector_tokens from anon, authenticated;
