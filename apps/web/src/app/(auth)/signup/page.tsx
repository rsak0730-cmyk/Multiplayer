'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { UserPlus, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrorText(null);

    if (password.length < 8) {
      setErrorText('Password must be at least 8 characters.');
      setBusy(false);
      return;
    }

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName || email.split('@')[0] } },
    });
    if (error) {
      setErrorText(error.message);
      setBusy(false);
      return;
    }

    // If Supabase email confirmation is enabled, there is no session yet.
    if (!data.session) {
      setNeedsConfirm(true);
      setBusy(false);
      return;
    }

    router.replace('/dashboard');
    router.refresh();
  }

  if (needsConfirm) {
    return (
      <div className="glass fade-in p-6 sm:p-7 text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-emerald-400/30 bg-emerald-500/12 text-emerald-300">
          <CheckCircle2 className="h-6 w-6" />
        </div>
        <h1 className="text-lg font-bold text-white">Check your email</h1>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-white/50">
          We sent a confirmation link to <span className="text-white/80">{email}</span>. Open it to
          activate your account, then sign in. If your Supabase project has email confirmation
          disabled, you can sign in right away.
        </p>
        <Link href="/login" className="btn-primary mt-6 w-full">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="glass fade-in p-6 sm:p-7">
      <h1 className="text-xl font-bold text-white">Create your account</h1>
      <p className="mt-1 text-xs leading-relaxed text-white/45">
        Free forever. You bring the Windows machine; OG HOST brings the control panel.
      </p>

      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
        <div>
          <label className="label" htmlFor="displayName">
            Display name
          </label>
          <input
            id="displayName"
            type="text"
            className="input"
            placeholder="How you want to be called"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
          />
        </div>
        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            className="input"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="input"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {errorText ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errorText}</span>
          </div>
        ) : null}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          {busy ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-xs text-white/45">
        Already registered?{' '}
        <Link href="/login" className="font-medium text-violet-300 hover:text-violet-200">
          Sign in
        </Link>
      </p>
    </div>
  );
}
