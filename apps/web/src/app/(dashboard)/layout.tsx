import { Sidebar } from '@/components/layout/Sidebar';
import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen">
      <Sidebar />
      <main className="px-4 pb-16 pt-5 sm:px-6 lg:ml-64 lg:px-8 lg:pt-8">{children}</main>
    </div>
  );
}
