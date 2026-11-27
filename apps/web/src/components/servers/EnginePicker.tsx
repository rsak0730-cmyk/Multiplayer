'use client';

import { engineInstallCommand, engineChoicesForPlatform, resolveEngineForNode } from '@/lib/servers/engine-selection';
import { engineById } from '@oghost/shared';
import { Badge } from '@/components/ui/Badge';

/**
 * Engine selection for the Server Creation Studio (§7).
 *
 * Two rules from the spec drive this component, and both are about honesty rather
 * than layout:
 *
 *   1. Show only the engines the selected device can actually run.
 *   2. Explain why the others are not shown.
 *
 * Silently omitting four of five engines would read as a broken form, and listing
 * all five on a phone would let an owner pick something that can never start. So
 * the unavailable engines are rendered too — as reasons, not as options.
 *
 * An engine is additionally refused here when the agent has no install adapter for
 * it, even if the catalog says the platform could run it. That mirrors the second
 * gate in POST /api/servers: the UI must not offer what the backend will reject.
 */
export function EnginePicker({
  node,
  nodeName,
  value,
  onChange,
}: {
  /** The selected device, or null when none is chosen yet. */
  node: { agent_platform?: string | null; operating_system?: string | null } | null;
  nodeName?: string;
  value: string;
  onChange: (engineId: string) => void;
}) {
  if (!node) {
    return (
      <section className="glass p-5">
        <h2 className="card-title mb-1">Server engine</h2>
        <p className="text-xs text-white/45">Choose a hosting device first — which engines are possible depends on it.</p>
      </section>
    );
  }

  const choices = engineChoicesForPlatform(node);
  const selection = resolveEngineForNode({ engineId: value, node });

  return (
    <section className="glass p-5">
      <h2 className="card-title mb-1">Server engine</h2>
      <p className="mb-4 text-xs text-white/45">
        Compatibility is decided from what this device reported about itself, not from what the form
        assumes. Nothing here is offered unless the engine catalog says it can run.
      </p>

      {choices.platform === null ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/8 p-3.5">
          <p className="text-sm font-semibold text-amber-200/90">This device did not report a platform OG HOST recognises</p>
          <p className="mt-1 text-[11px] text-white/55">
            Reported: agent_platform “{String(node.agent_platform ?? 'nothing')}”, operating_system “
            {String(node.operating_system ?? 'nothing')}”. Without a platform, no engine can be
            checked for compatibility, so none is offered. Re-pair the device with an agent that
            reports its platform.
          </p>
        </div>
      ) : choices.available.length === 0 ? (
        <div className="rounded-xl border border-rose-400/30 bg-rose-500/8 p-3.5">
          <p className="text-sm font-semibold text-rose-200/90">
            No engine can run on {nodeName ?? 'this device'} yet
          </p>
          <ul className="mt-2 space-y-1.5">
            {choices.hidden.map((hidden) => (
              <li key={hidden.id} className="text-[11px] text-white/60">
                <span className="font-semibold text-white/80">{hidden.displayName}</span> — {hidden.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-[11px] text-white/45">
            OG HOST does not pool resources across devices or move servers on its own, so another
            device in your account is the only way to host this engine.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {choices.available.map((option) => {
              const engine = engineById(option.id);
              const installable = engineInstallCommand(option.id) !== null;
              const active = value === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={!installable}
                  onClick={() => onChange(option.id)}
                  className={`rounded-xl border p-3.5 text-left transition-all duration-200 ${
                    active
                      ? 'border-violet-400/50 bg-violet-500/12 shadow-[0_0_28px_-14px_rgba(139,92,246,1)]'
                      : 'border-white/8 bg-black/25 hover:border-white/20'
                  } ${installable ? '' : 'cursor-not-allowed opacity-55'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white/90">{option.displayName}</p>
                      <p className="mt-0.5 text-[11px] text-white/40">
                        {option.edition === 'bedrock' ? 'Bedrock protocol' : 'Java Edition'} · port{' '}
                        {option.defaultPort}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {engine?.official ? <Badge tone="violet">official</Badge> : <Badge tone="slate">community</Badge>}
                      {!installable ? <Badge tone="amber">no adapter</Badge> : null}
                    </div>
                  </div>
                  {!installable ? (
                    <p className="mt-2 text-[11px] text-amber-200/70">
                      The agent has no install adapter for this engine yet, so a server cannot be
                      created for it.
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>

          {selection.ok && selection.caveats.length > 0 ? (
            <div className="mt-3 rounded-xl border border-white/8 bg-black/25 p-3.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-white/45">
                What is not verified about this choice
              </p>
              <ul className="mt-1.5 space-y-1">
                {selection.caveats.map((caveat) => (
                  <li key={caveat} className="text-[11px] text-white/60">
                    {caveat}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!selection.ok ? (
            <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-500/8 p-3.5">
              <p className="text-[11px] text-rose-200/85">{selection.error}</p>
            </div>
          ) : null}

          {choices.hidden.length > 0 ? (
            <details className="mt-3 rounded-xl border border-white/8 bg-black/20 p-3.5">
              <summary className="cursor-pointer text-[11px] font-semibold text-white/55">
                Why {choices.hidden.length} other {choices.hidden.length === 1 ? 'engine is' : 'engines are'} not
                listed
              </summary>
              <ul className="mt-2 space-y-1.5">
                {choices.hidden.map((hidden) => (
                  <li key={hidden.id} className="text-[11px] text-white/55">
                    <span className="font-semibold text-white/75">{hidden.displayName}</span> — {hidden.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The first engine a device can actually host, or null when it can host none.
 * Used when the device selection changes so the form never keeps an engine that
 * the newly chosen device cannot run.
 */
export function firstEngineForNode(
  node: { agent_platform?: string | null; operating_system?: string | null } | null,
): string | null {
  if (!node) return null;
  // Only an engine the agent can actually install. Falling back to a
  // platform-compatible engine with no adapter would preselect something the API
  // refuses, which is a form that looks ready and is not.
  const installable = engineChoicesForPlatform(node)
    .available.map((option) => option.id)
    .filter((id) => engineInstallCommand(id) !== null);
  return installable[0] ?? null;
}
