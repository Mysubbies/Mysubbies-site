create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text not null unique,
  seo_title text,
  meta_description text,
  target_keywords text,
  excerpt text,
  body_html text,
  feature_image_url text,
  feature_image_alt text,
  status text not null default 'draft' check (status in ('draft','ready_for_review','approved','scheduled','published','archived')),
  scheduled_for timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists blog_posts_status_idx on public.blog_posts(status, updated_at desc);
alter table public.blog_posts enable row level security;
revoke all privileges on table public.blog_posts from anon, authenticated;
