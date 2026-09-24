import { Driver } from './browser/driver.js';
import { type Config, loadConfig, resolveProjectDir } from './config.js';
import { ToolError } from './errors.js';
import { OriginGuard } from './guards/origins.js';
import { SecretStore } from './guards/secrets.js';
import { Mutex } from './mutex.js';
import type { ActionRecord } from './page/actions.js';
import type { StepAnswer } from './tools/developer-tools.js';

// Shared state for all tools in one server.
export class Context {
  readonly lock = new Mutex();
  readonly actionLog: ActionRecord[] = [];
  readonly stepAnswers: StepAnswer[] = [];
  driver?: Driver;
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
