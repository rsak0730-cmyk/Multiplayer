'use client';

import { useState } from 'react';
import {
  User,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  ScrollText,
  Info,
  LogOut,
  KeyRound,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { createClient } from '@/lib/supabase/client';

interface AuditRow {
  id: string;
  actor_type: string;
  action: string;
  target_type: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

export function SettingsClient({
  email,
  userId,
  profile,
  nodeCount,
  serverCount,
  audits,
}: {
  email: string;
  userId: string;
  profile: { display_name: string | null; avatar_url: string | null } | null;
  nodeCount: number;
  serverCount: number;
  audits: AuditRow[];
}) {
  const [displayName, setDisplayName] = useState(profile?.display_name ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');

  async function saveProfile() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: displayName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed to save');
      setFeedback({ tone: 'ok', text: 'Profile saved.' });
    } catch (e) {
      setFeedback({ tone: 'err', text: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordBusy(true);
    setPasswordFeedback(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) {
      setPasswordFeedback({ tone: 'err', text: error.message });
    } else {
      setPasswordFeedback({ tone: 'ok', text: 'Password updated.' });
      setNewPassword('');
    }
    setPasswordBusy(false);
  }

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <div className="fade-in flex flex-col gap-5">
      <header>
        <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">Settings</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
          Account & security
        </h1>
        <p className="mt-1 text-xs text-white/45">
          {nodeCount} devices · {serverCount} servers · user id {userId.slice(0, 8)}…
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            icon={<User className="h-[18px] w-[18px]" />}
            title="Profile"
            subtitle="How your account appears in the panel"
          />
          <div className="flex flex-col gap-3">
            <div>
              <span className="label">Email</span>
              <input className="input" value={email} disabled readOnly />
              <p className="mt-1.5 text-[11px] text-white/35">
                Change your email from your Supabase project’s auth settings if you need to.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="displayName">
                Display name
              </label>
              <input
                id="displayName"
                className="input"
                maxLength={40}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </div>
            <button type="button" className="btn-primary" disabled={busy} onClick={saveProfile}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save profile
            </button>
            {feedback ? (
              <p
                className={`flex items-center gap-1.5 text-[11px] ${
                  feedback.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'
                }`}
              >
                {feedback.tone === 'ok' ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                {feedback.text}
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader
            icon={<KeyRound className="h-[18px] w-[18px]" />}
            title="Password"
            subtitle="Handled by Supabase Auth"
          />
          <form onSubmit={changePassword} className="flex flex-col gap-3">
            <div>
              <label className="label" htmlFor="newPassword">
                New password
              </label>
              <input
                id="newPassword"
                className="input"
                type="password"
                minLength={8}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>
            <button type="submit" className="btn-primary" disabled={passwordBusy || newPassword.length < 8}>
              {passwordBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Update password
            </button>
            {passwordFeedback ? (
              <p
                className={`flex items-center gap-1.5 text-[11px] ${
                  passwordFeedback.tone === 'ok' ? 'text-emerald-300' : 'text-red-300'
                }`}
              >
                {passwordFeedback.tone === 'ok' ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5" />
                )}
                {passwordFeedback.text}
              </p>
            ) : null}
          </form>

          <div className="divider" />
          <button type="button" className="btn-danger w-full" onClick={signOut}>
            <LogOut className="h-4 w-4" /> Sign out of OG HOST
          </button>
        </Card>
      </div>

      <Card>
        <CardHeader
          icon={<ShieldCheck className="h-[18px] w-[18px]" />}
          title="How your account is protected"
        />
        <div className="grid gap-3 text-[11px] leading-relaxed text-white/55 sm:grid-cols-2">
          <p>
            Authentication is Supabase Auth. Every table has Row Level Security enabled, and every
            policy is scoped to your own user id, so one account can never read or write another
            account’s devices, servers, backups or logs — even by guessing an id.
          </p>
          <p>
            All writes from the browser go through server-side API routes that re-verify ownership
            before touching data. Device credentials are stored only as SHA-256 hashes, pairing codes
            are single-use and expire in 10 minutes, and tokens can be rotated or revoked from the
            Devices page at any time.
          </p>
          <p>
            There is no remote shell. Console input is limited to an allowlist of official Bedrock
            commands, enforced both in the API and again on the device. File operations are confined
            to the server’s own directory, and Bedrock system files are protected.
          </p>
          <p>
            The service-role key exists only in server-side environment variables and is never sent
            to a browser. Rate limiting protects the pairing, token rotation and command endpoints.
            Every privileged action is written to the audit log below.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          icon={<ScrollText className="h-[18px] w-[18px]" />}
          title="Audit log"
          subtitle="Your most recent privileged actions"
          right={<Badge tone="slate">{audits.length} shown</Badge>}
        />
        {audits.length === 0 ? (
          <p className="text-xs text-white/45">
            Nothing recorded yet. Actions such as pairing a device, creating a server, rotating a
            token or changing configuration appear here.
          </p>
        ) : (
          <ul className="scrollbar-thin max-h-96 overflow-y-auto pr-1">
            {audits.map((a) => (
              <li
                key={a.id}
                className="flex items-start justify-between gap-3 border-b border-white/6 px-1 py-2.5 last:border-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-medium text-white/80">{a.action}</p>
                  <p className="mt-0.5 truncate text-[10px] text-white/35">
                    {a.actor_type}
                    {a.target_type ? ` · ${a.target_type}` : ''}
                    {a.ip_address ? ` · ${a.ip_address}` : ''}
                    {a.details && Object.keys(a.details).length > 0
                      ? ` · ${JSON.stringify(a.details)}`
                      : ''}
                  </p>
                </div>
                <span className="shrink-0 text-[10px] text-white/30">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-white/40">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />
          Audit entries are written server-side and are read-only in the browser — Row Level Security
          allows selecting your own rows but not inserting or editing them.
        </p>
      </Card>
    </div>
  );
}
