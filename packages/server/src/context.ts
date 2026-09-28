import { Driver } from './browser/driver.js';
import { type Config, loadConfig, resolveProjectDir } from './config.js';
import { ToolError } from './errors.js';
import { OriginGuard } from './guards/origins.js';
import { SecretStore } from './guards/secrets.js';
import type { LhFlow } from './lighthouse/flow.js';
import { Mutex } from './mutex.js';
import type { ActionRecord } from './page/actions.js';
import { newUnique } from './page/unique.js';
import { adhocEvidenceDir } from './project-files.js';
import type { RunStore } from './run/run-store.js';
import type { StepAnswer } from './tools/developer-tools.js';
import type { VideoCapture } from './video/capture.js';
import type { VideoRecording } from './video/recording.js';

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
  private loaded?: { config: Config; secrets: SecretStore; guard: OriginGuard };

  constructor(
    private readonly roots: () => Promise<string[]>,
    // The name of the MCP client, such as "claude-code".
    readonly clientName: () => string | undefined = () => undefined,
  ) {}

  // Reads the project folder, settings, and secrets again.
  async refresh(projectDirArg?: string): Promise<Config> {
    const roots = projectDirArg ? [] : await this.roots().catch(() => []);
    const { dir, source } = resolveProjectDir({ argument: projectDirArg, roots });
    const config = loadConfig(dir, source);
    this.loaded = {
      config,
      secrets: SecretStore.forProject(dir),
      guard: new OriginGuard(config.allowedOrigins),
    };
    return config;
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

  async startDriver(attach?: string): Promise<Driver> {
    const config = await this.config();
    const guard = await this.guard();
    this.driver = await Driver.start({
      config,
      attach,
      // Look up the guard each time, so a config reload takes effect.
      isAllowed: (url) => (this.loaded?.guard ?? guard).isAllowed(url),
    });
    return this.driver;
  }
}
