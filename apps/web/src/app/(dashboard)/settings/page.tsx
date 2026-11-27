import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { SettingsClient } from '@/components/settings/SettingsClient';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: profile }, { count: nodeCount }, { count: serverCount }, { data: audits }] =
    await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase.from('nodes').select('*', { count: 'exact', head: true }),
      supabase.from('servers').select('*', { count: 'exact', head: true }),
      supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(30),
    ]);

  return (
    <SettingsClient
      email={user.email ?? ''}
      userId={user.id}
      profile={profile}
      nodeCount={nodeCount ?? 0}
      serverCount={serverCount ?? 0}
      audits={audits ?? []}
    />
  );
}
