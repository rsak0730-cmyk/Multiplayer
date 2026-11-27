'use client';

import { useState } from 'react';
import {
  SlidersHorizontal,
  Save,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Info,
} from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/Card';
import { Toggle } from '@/components/servers/NewServerForm';

const GAMEMODES = ['survival', 'creative', 'adventure'] as const;
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'] as const;
const PERMISSIONS = ['visitor', 'member', 'operator'] as const;

export function ConfigPanel({
  serverId,
  initialConfig,
  onChanged,
}: {
  serverId: string;
  initialConfig: Record<string, unknown> | null;
  onChanged: () => void;
}) {
  const [cfg, setCfg] = useState<Record<string, unknown>>(initialConfig ?? {});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);

  function update(key: string, value: unknown) {
    setCfg((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const { id: _id, server_id: _sid, owner_id: _oid, created_at: _c, updated_at: _u, ...changes } = cfg;
      void _id; void _sid; void _oid; void _c; void _u;
      const res = await fetch(`/api/servers/${serverId}/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changes),
      });
      const json = await res.json();
      if (!res.ok) {
        setFeedback({ tone: 'err', text: json.error ?? 'Failed to save configuration' });
      } else {
        setCfg(json.config);
        setFeedback({ tone: 'ok', text: json.message ?? 'Configuration saved.' });
        onChanged();
      }
    } catch {
      setFeedback({ tone: 'err', text: 'Network error while saving.' });
    } finally {
      setBusy(false);
    }
  }

  async function loadRaw() {
    const res = await fetch(`/api/servers/${serverId}/config?raw=1`, { cache: 'no-store' });
    if (!res.ok) {
      setRawText('Could not load server.properties preview.');
      return;
    }
    setRawText(await res.text());
  }

  if (!initialConfig) {
    return (
      <Card>
        <CardHeader icon={<SlidersHorizontal className="h-[18px] w-[18px]" />} title="Server settings" />
        <p className="text-xs text-white/45">
          No configuration row exists for this server yet. It is created automatically when the
          server is created; if this server predates that, recreate it or run the migration.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          icon={<SlidersHorizontal className="h-[18px] w-[18px]" />}
          title="Server settings"
          subtitle="Written to server.properties on your device when you save"
          right={
            <button type="button" className="btn-primary !min-h-9 !px-3 !py-1.5 text-xs" disabled={busy} onClick={save}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
          }
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Server name shown in the server list">
            <input
              className="input"
              value={String(cfg.server_name ?? '')}
              maxLength={64}
              onChange={(e) => update('server_name', e.target.value)}
            />
          </Field>
          <Field label="Max players">
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={Number(cfg.max_players ?? 10)}
              onChange={(e) => update('max_players', Number(e.target.value))}
            />
          </Field>
          <Field label="Game mode">
            <SegmentedControl
              options={[...GAMEMODES]}
              value={String(cfg.gamemode ?? 'survival')}
              onChange={(v) => update('gamemode', v)}
            />
          </Field>
          <Field label="Difficulty">
            <SegmentedControl
              options={[...DIFFICULTIES]}
              value={String(cfg.difficulty ?? 'easy')}
              onChange={(v) => update('difficulty', v)}
            />
          </Field>
          <Field label="Default player permission">
            <SegmentedControl
              options={[...PERMISSIONS]}
              value={String(cfg.default_player_permission_level ?? 'member')}
              onChange={(v) => update('default_player_permission_level', v)}
            />
          </Field>
          <Field label="Server port (UDP)">
            <input
              className="input"
              type="number"
              min={1024}
              max={65535}
              value={Number(cfg.server_port ?? 19132)}
              onChange={(e) => update('server_port', Number(e.target.value))}
            />
          </Field>
          <Field label="World folder name">
            <input
              className="input"
              value={String(cfg.level_name ?? 'world')}
              maxLength={64}
              onChange={(e) => update('level_name', e.target.value)}
            />
          </Field>
          <Field label="World seed (blank = random)">
            <input
              className="input"
              value={String(cfg.level_seed ?? '')}
              maxLength={64}
              onChange={(e) => update('level_seed', e.target.value)}
            />
          </Field>
          <Field label="Redstone conduction ticks">
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={Number(cfg.tick_command_redstone_conduction ?? 7)}
              onChange={(e) => update('tick_command_redstone_conduction', Number(e.target.value))}
            />
          </Field>
          <Field label="Function command limit">
            <input
              className="input"
              type="number"
              min={0}
              max={10000}
              value={Number(cfg.function_command_limit ?? 10)}
              onChange={(e) => update('function_command_limit', Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="divider" />

        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            checked={Boolean(cfg.force_gamemode)}
            onChange={(v) => update('force_gamemode', v)}
            label="Force game mode"
            hint="Re-apply the game mode to every player on join."
          />
          <Toggle
            checked={Boolean(cfg.spawn_monsters)}
            onChange={(v) => update('spawn_monsters', v)}
            label="Spawn monsters"
          />
          <Toggle
            checked={Boolean(cfg.spawn_animals)}
            onChange={(v) => update('spawn_animals', v)}
            label="Spawn animals"
          />
          <Toggle
            checked={Boolean(cfg.spawn_npcs)}
            onChange={(v) => update('spawn_npcs', v)}
            label="Spawn NPCs"
          />
          <Toggle checked={Boolean(cfg.pvp)} onChange={(v) => update('pvp', v)} label="PvP" />
          <Toggle
            checked={Boolean(cfg.online_mode)}
            onChange={(v) => update('online_mode', v)}
            label="Online mode"
            hint="Verify players against Xbox Live. Keep this on unless you know why you need it off."
          />
          <Toggle
            checked={Boolean(cfg.allow_list)}
            onChange={(v) => update('allow_list', v)}
            label="Allow list (whitelist)"
            hint="Only players in allowlist.json may join."
          />
          <Toggle
            checked={Boolean(cfg.command_block_output)}
            onChange={(v) => update('command_block_output', v)}
            label="Command block output"
          />
          <Toggle
            checked={Boolean(cfg.enable_command_blocking)}
            onChange={(v) => update('enable_command_blocking', v)}
            label="Enable command blocking"
          />
          <Toggle
            checked={Boolean(cfg.enable_scripting)}
            onChange={(v) => update('enable_scripting', v)}
            label="Enable scripting"
            hint="Required by many Bedrock add-ons that use the script API."
          />
          <Toggle
            checked={Boolean(cfg.texture_pack_required)}
            onChange={(v) => update('texture_pack_required', v)}
            label="Require resource packs"
            hint="Players must accept the server's resource packs to join."
          />
          <Toggle
            checked={Boolean(cfg.enable_lan_transfer)}
            onChange={(v) => update('enable_lan_transfer', v)}
            label="LAN transfer"
          />
        </div>

        {feedback ? (
          <div
            className={`mt-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed ${
              feedback.tone === 'ok'
                ? 'border-emerald-400/25 bg-emerald-500/8 text-emerald-100/90'
                : 'border-red-400/25 bg-red-500/8 text-red-100/90'
            }`}
          >
            {feedback.tone === 'ok' ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          icon={<FileText className="h-[18px] w-[18px]" />}
          title="server.properties preview"
          subtitle="Exactly what the agent writes on your device"
          right={
            <button
              type="button"
              className="btn-ghost !min-h-9 !px-3 !py-1.5 text-xs"
              onClick={async () => {
                setShowRaw((v) => !v);
                if (!showRaw) await loadRaw();
              }}
            >
              {showRaw ? 'Hide' : 'Show'}
            </button>
          }
        />
        {showRaw ? (
          <pre className="console-surface scrollbar-thin max-h-80 overflow-auto rounded-xl p-3 text-[11px] text-emerald-100/80">
            {rawText ?? 'Loading…'}
          </pre>
        ) : (
          <p className="flex items-start gap-2 text-[11px] leading-relaxed text-white/45">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Saving queues a config_apply command. If your device is offline the command waits and is
            applied automatically when the agent reconnects — settings are never silently applied to
            a running server.
          </p>
        )}
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0,1fr))` }}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`rounded-xl border px-1 py-2.5 text-[11px] font-medium capitalize transition-all ${
            value === o
              ? 'border-violet-400/50 bg-violet-500/15 text-white'
              : 'border-white/8 bg-black/25 text-white/50 hover:border-white/20'
          }`}
          style={{ minHeight: 44 }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
