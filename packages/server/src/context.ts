import { Driver } from './browser/driver.js';
import type { LaunchOptions } from './browser/launch.js';
import { type Config, loadConfig, resolveProjectDir } from './config.js';
import {
  describeEnvironment,
  type EnvNetwork,
  environmentBadge,
  environmentGuard,
  environmentNetwork,
  rebaseUrl,
  secretScope,
} from './environments.js';
import { ToolError } from './errors.js';
import type { OriginGuard } from './guards/origins.js';
import { SecretStore } from './guards/secrets.js';
import type { LhFlow } from './lighthouse/flow.js';
import { log } from './log.js';
import { Mutex } from './mutex.js';
import type { ActionRecord } from './page/actions.js';
import { buildVars, TokenResolver } from './page/tokens.js';
import { newUnique } from './page/unique.js';
import type { LivePresentation } from './presentation/policy.js';
import { adhocEvidenceDir } from './project-files.js';
import type { RunStore } from './run/run-store.js';
import type { StepAnswer } from './tools/developer-tools.js';
import type { VideoCapture } from './video/capture.js';
import type { VideoRecording } from './video/recording.js';

// Asks the developer a yes-or-no question through the MCP client, if it can.
export type Elicit = (
  message: string,
  options: { timeoutMs: number; signal?: AbortSignal; relatedRequestId?: string | number },
) => Promise<'yes' | 'no' | 'timeout'>;

// Who chose the session environment. A plan's own choice is not kept for the session.
export type EnvSource = 'tool' | 'UIWALK_ENV';

export type ConfirmResult =
  | { status: 'confirmed' }
  | { status: 'waiting'; text: string }
  | { status: 'canceled'; text: string };

// Shared state for all tools in one server.
export class Context {
  readonly lock = new Mutex();
  readonly actionLog: ActionRecord[] = [];
  readonly stepAnswers: StepAnswer[] = [];
  driver?: Driver;
  // The test run in progress, if any.
  run?: RunStore;
  // Actions before this index already belong to a recorded step.
  actionCursor = 0;
  // The value of {{unique}}. Each run gets a new one.
  unique = newUnique();
  // The Lighthouse user flow of the run, after its first flow step.
  lhFlow?: LhFlow;
  // The video that is recording, or one that stopped but is not saved yet.
  video?: VideoRecording;
  // The bug clip buffer of the run that is going.
  ring?: VideoCapture;
  forgetRing?: () => void;
  // Fields hidden while anything records. They show again when all recordings stop.
  videoMasks: Array<() => Promise<void>> = [];
  // The environment that the developer or a tool chose for this session.
  sessionEnv?: { name: string; source: EnvSource };
  // Values for {{var:NAME}}: config and environment, plus the plan during a run.
  vars: Record<string, string> = {};
  // Headers and a login for the environment's site, with secrets filled in.
  network?: EnvNetwork;
  // The presentation that is going, if any. Most tools wait until it ends.
  presentation?: LivePresentation;
  private loaded?: { config: Config; secrets: SecretStore; guard: OriginGuard };
  // A switch to a protected environment that waits for the developer.
  // Tabs move, or the session goes back, after the answer.
  private pendingSwitch?: { from: Config; session?: Context['sessionEnv'] };

  constructor(
    private readonly roots: () => Promise<string[]>,
    // The name of the MCP client, such as "claude-code".
    readonly clientName: () => string | undefined = () => undefined,
    // Undefined when the client cannot ask the developer a question.
    readonly elicit?: () => Elicit | undefined,
  ) {
    const fromEnv = process.env.UIWALK_ENV?.trim();
    if (fromEnv) this.sessionEnv = { name: fromEnv, source: 'UIWALK_ENV' };
  }

  // Reads the project folder, settings, and secrets again.
  // It keeps the environment in use, unless "environment" names another one.
  async refresh(projectDirArg?: string, environment?: string): Promise<Config> {
    const roots = projectDirArg ? [] : await this.roots().catch(() => []);
    const { dir, source } = resolveProjectDir({ argument: projectDirArg, roots });
    // The environment in use stays until something changes it on purpose.
    const loadedHere =
      this.loaded?.config.projectDir === dir ? this.loaded.config.environment.name : undefined;
    const name = environment ?? this.sessionEnv?.name ?? loadedHere;
    let config: Config;
    try {
      config = loadConfig(dir, source, name);
    } catch (error) {
      // The session environment is gone from the settings. Use the default one.
      if (environment || !name || (error as ToolError).code !== 'environment_unknown') throw error;
      log.warn(`the environment "${name}" is not in the settings any more`);
      this.sessionEnv = undefined;
      config = loadConfig(dir, source);
      config.warnings.push(
        `The session used the environment "${name}", but the settings do not have it now. Walkthrough uses "${config.environment.name}".`,
      );
    }
    const secrets = SecretStore.forProject(dir, secretScope(config.environment));
    this.loaded = {
      config,
      secrets,
      guard: environmentGuard(config, this.driver?.confirmedEnvs),
    };
    this.vars = buildVars(config);
    this.network = environmentNetwork(
      config.environment,
      (text) => secrets.resolve(text),
      config.warnings,
    );
    if (this.driver?.alive) {
      await this.driver.applyEnvironment(config, this.network);
      await this.driver.panel?.setEnvironment(environmentBadge(config));
    }
    return config;
  }

  // A person confirmed a protected environment for this browser, such as in a presentation.
  confirmFor(name: string): void {
    this.driver?.confirmedEnvs.add(name);
    this.rebuildGuard();
  }

  // Builds the guard again, for example after the developer confirms an environment.
  private rebuildGuard(): void {
    if (!this.loaded) return;
    this.loaded.guard = environmentGuard(this.loaded.config, this.driver?.confirmedEnvs);
  }

  // Fills in {{var:NAME}}, {{unique}}, and secrets.
  async tokens(): Promise<TokenResolver> {
    return new TokenResolver(this.unique, this.vars, await this.secrets());
  }

  // Fills in {{var:NAME}} and {{unique}}. Secrets stay as tokens.
  display(text: string): string {
    return new TokenResolver(this.unique, this.vars).display(text);
  }

  // Switches the session to another environment. Open tabs on the old one move to the same page,
  // after the developer confirms a protected environment. Returns lines for the reply.
  async useEnvironment(
    name: string,
    how: { source?: EnvSource; projectDir?: string } = {},
  ): Promise<string[]> {
    const before = await this.config();
    const session = this.sessionEnv;
    if (before.environment.name === name) {
      if (how.source) this.sessionEnv = { name, source: how.source };
      return [];
    }
    this.checkCanSwitch();
    // An open confirm question was for the old choice.
    if (this.driver?.panel?.pending?.kind === 'confirm') await this.driver.panel.clear();
    this.pendingSwitch = undefined;
    const config = await this.refresh(how.projectDir, name);
    if (how.source) this.sessionEnv = { name, source: how.source };
    const lines = [
      `The session uses the "${name}" environment now: ${describeEnvironment(config.environment)}.`,
    ];
    if (config.environment.protected && !this.driver?.confirmedEnvs.has(name)) {
      this.pendingSwitch = { from: before, session };
      return lines;
    }
    lines.push(...(await this.moveTabs(before, config)));
    return lines;
  }

  // For a tool's "environment" argument: switch, with the developer's OK for a protected one.
  // Without a browser, the confirmation comes when the browser opens.
  async useEnvironmentForTool(
    name: string,
    extra: { signal?: AbortSignal; requestId?: string | number },
  ): Promise<string[]> {
    const lines = await this.useEnvironment(name, { source: 'tool' });
    if (!this.driver?.alive) return lines;
    const result = await this.confirmEnvironment({
      signal: extra.signal,
      requestId: extra.requestId,
    });
    if (result.status === 'confirmed') return [...lines, ...(await this.finishSwitch(true))];
    if (result.status === 'canceled') {
      const back = await this.finishSwitch(false);
      throw new ToolError([result.text, ...back].join(' '), 'protected_unconfirmed');
    }
    throw new ToolError(`${result.text} Then call this tool again.`, 'confirm_waiting');
  }

  // After the developer answers: move the tabs, or go back to the environment from before.
  async finishSwitch(confirmed: boolean): Promise<string[]> {
    const pending = this.pendingSwitch;
    this.pendingSwitch = undefined;
    if (!pending) return [];
    if (confirmed) return this.moveTabs(pending.from, await this.config());
    const back = pending.from.environment.name;
    await this.refresh(pending.from.projectDir, back);
    this.sessionEnv = pending.session;
    return [`The session goes back to the "${back}" environment.`];
  }

  private checkCanSwitch(): void {
    const busy =
      this.run?.run.status === 'running'
        ? `the run "${this.run.run.name}" is still going. Call run_finish first`
        : this.driver?.panel?.recording
          ? 'recording is on. Call record with action "stop" first'
          : this.video?.capture.recording
            ? 'a video is recording. Call video with action "stop" first'
            : this.driver?.panel?.pending && this.driver.panel.pending.kind !== 'confirm'
              ? 'a question is open in the panel'
              : undefined;
    if (busy) {
      throw new ToolError(
        `Walkthrough cannot change the environment now, because ${busy}.`,
        'busy',
      );
    }
  }

  // Moves tabs on the old environment to the same page on the new one.
  private async moveTabs(before: Config, after: Config): Promise<string[]> {
    const driver = this.driver?.alive ? this.driver : undefined;
    if (!driver) return [];
    const lines: string[] = [];
    for (const tab of driver.tabs.values()) {
      const url = tab.page.url();
      const moved = rebaseUrl(url, before.environment.baseUrl, after.environment.baseUrl);
      if (moved) {
        await tab.page.goto(moved, { waitUntil: 'load' }).catch((error: Error) => {
          lines.push(`Tab ${tab.id} could not open ${moved}: ${error.message}`);
        });
        lines.push(`Tab ${tab.id} moved to ${moved}.`);
      } else if (/^https?:/.test(url) && !(await this.guard()).isAllowed(url)) {
        lines.push(`Tab ${tab.id} is on ${url}, which this environment does not allow.`);
      }
    }
    return lines;
  }

  // Asks the developer to confirm a protected environment, once for each browser.
  // Only a person can confirm: in the panel, in the client, or with UIWALK_ALLOW_PROTECTED.
  async confirmEnvironment(options: {
    signal?: AbortSignal;
    requestId?: string | number;
    resume?: boolean;
  }): Promise<ConfirmResult> {
    const config = await this.config();
    const env = config.environment;
    const driver = this.driver?.alive ? this.driver : undefined;
    if (!env.protected || driver?.confirmedEnvs.has(env.name)) return { status: 'confirmed' };
    const allowed = (process.env.UIWALK_ALLOW_PROTECTED ?? '').split(',').map((s) => s.trim());
    const confirm = (): ConfirmResult => {
      driver?.confirmedEnvs.add(env.name);
      this.rebuildGuard();
      return { status: 'confirmed' };
    };
    if (allowed.includes(env.name)) return confirm();
    if (!driver) {
      return {
        status: 'waiting',
        text: `"${env.name}" is a protected environment. Open the browser with browser_open, and the developer confirms it there.`,
      };
    }
    const timeoutMs =
      (config.askTimeoutSec ?? (this.clientName() === 'claude-code' ? 300 : 50)) * 1000;
    const message = `Use the "${env.name}" environment (${env.baseUrl})? The agent can create real data there.`;
    const panel = driver.panel;
    const tab = driver.hasActiveTab
      ? driver.activeTab({ allowDialog: true })
      : await driver.reopenTab();
    if (panel && (await panel.waitReady(tab.id))) {
      const open = panel.pending;
      if (!(options.resume && open?.kind === 'confirm' && open.stepId === env.name)) {
        await panel.ask({
          tabId: tab.id,
          kind: 'confirm',
          title: `Use ${env.label}?`,
          didWhat: message,
          expected: '',
          stepId: env.name,
          confirmLabel: `Use ${env.label}`,
          color: env.color,
        });
      }
      const outcome = await panel.waitForAnswer(timeoutMs, options.signal);
      if (outcome.kind === 'answer') {
        if (outcome.answer.result === 'pass') return confirm();
        return {
          status: 'canceled',
          text: `The developer did not confirm the "${env.name}" environment. Walkthrough blocks its site.`,
        };
      }
      if (outcome.kind === 'timeout') {
        return {
          status: 'waiting',
          text: `The developer has not confirmed the "${env.name}" environment yet. The question is still in the panel. Call the environment tool with action "use", name "${env.name}", and resume: true to keep waiting.`,
        };
      }
      return {
        status: 'canceled',
        text: `Walkthrough stopped waiting for the developer (${outcome.kind}).`,
      };
    }
    const elicit = this.elicit?.();
    if (elicit) {
      const answer = await elicit(message, {
        timeoutMs,
        signal: options.signal,
        relatedRequestId: options.requestId,
      });
      if (answer === 'yes') return confirm();
      if (answer === 'timeout') {
        return {
          status: 'waiting',
          text: `The developer has not confirmed the "${env.name}" environment yet. Call the environment tool with action "use" and name "${env.name}" again.`,
        };
      }
      return {
        status: 'canceled',
        text: `The developer did not confirm the "${env.name}" environment. Walkthrough blocks its site.`,
      };
    }
    throw new ToolError(
      `"${env.name}" is a protected environment. Walkthrough cannot ask the developer to confirm it, because the panel is not available and the client cannot ask questions. Use a visible browser, or start the server with UIWALK_ALLOW_PROTECTED=${env.name}.`,
      'protected_unconfirmed',
    );
  }

  private async ensureLoaded() {
    if (!this.loaded) await this.refresh();
    return this.loaded as NonNullable<typeof this.loaded>;
  }

  async config(): Promise<Config> {
    return (await this.ensureLoaded()).config;
  }

  async secrets(): Promise<SecretStore> {
    return (await this.ensureLoaded()).secrets;
  }

  async guard(): Promise<OriginGuard> {
    return (await this.ensureLoaded()).guard;
  }

  // Where screenshots go: the run folder during a run, otherwise a folder for today.
  evidenceDir(projectDir: string): string {
    return this.run?.run.status === 'running'
      ? this.run.screenshotsDir
      : adhocEvidenceDir(projectDir);
  }

  // The open browser. Throws a clear message if there is none.
  requireDriver(): Driver {
    if (!this.driver) {
      throw new ToolError('No browser is open. Call browser_open first.', 'no_browser');
    }
    this.driver.assertAlive();
    return this.driver;
  }

  // "launch" starts Chrome for a presentation. "panel: false" leaves out the developer panel.
  async startDriver(
    attach?: string,
    options: { launch?: LaunchOptions; panel?: boolean } = {},
  ): Promise<Driver> {
    const config = await this.config();
    const guard = await this.guard();
    this.driver = await Driver.start({
      config: options.panel === false ? { ...config, panel: false } : config,
      attach,
      launch: options.launch,
      // Look up the guard each time, so a config reload takes effect.
      isAllowed: (url) => (this.loaded?.guard ?? guard).isAllowed(url),
    });
    // A new browser has no confirmed environments.
    this.rebuildGuard();
    await this.driver.applyEnvironment(config, this.network);
    await this.driver.panel?.setEnvironment(environmentBadge(config));
    return this.driver;
  }
}
