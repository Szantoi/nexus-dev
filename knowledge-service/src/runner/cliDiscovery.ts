/** Runtime capability preflight for configured CLI providers. */

import { spawn } from 'node:child_process';
import { getCliAdapter } from './adapterRegistry';
import type { CliProvider } from './cliAdapter';
import type { ProviderConfig, RunnerConfig } from './runnerConfig';

export interface CliDiscoveryResult {
  provider: CliProvider;
  available: boolean;
  version?: string;
  error?: string;
}

export function discoverCli(
  provider: CliProvider,
  config: ProviderConfig,
  timeoutMs = 10_000,
): Promise<CliDiscoveryResult> {
  const adapter = getCliAdapter(provider);
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result: CliDiscoveryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.binary, adapter.versionArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        provider,
        available: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const timeout = setTimeout(() => {
      child.kill();
      finish({ provider, available: false, error: `version check timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timeout.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      finish({ provider, available: false, error: error.message });
    });
    child.on('exit', (code) => {
      const version = (stdout || stderr).trim().split(/\r?\n/, 1)[0];
      finish(
        code === 0
          ? { provider, available: true, version }
          : { provider, available: false, error: `version command exited ${code}` },
      );
    });
  });
}

export async function discoverConfiguredClis(config: RunnerConfig): Promise<CliDiscoveryResult[]> {
  const providers = new Set<CliProvider>();
  for (const terminal of Object.values(config.terminals)) {
    providers.add(terminal.provider || config.default_provider);
  }
  return Promise.all([...providers].map((provider) => {
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      return Promise.resolve({
        provider,
        available: false,
        error: 'provider is used but not configured',
      });
    }
    return discoverCli(provider, providerConfig);
  }));
}
