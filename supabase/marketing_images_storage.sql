-- Required for generated marketing email hero photos.
-- Public URLs are used in HTML emails; never upload sensitive customer photos here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('marketing-images', 'marketing-images', true, 10485760, array['image/png'])
on conflict (id) do update set public = true;
