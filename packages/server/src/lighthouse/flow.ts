import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Driver, Tab } from '../browser/driver.js';
import { type LighthouseModule, loadLighthouse } from '../downloads/lighthouse.js';
import { ToolError } from '../errors.js';
import type { SecretStore } from '../guards/secrets.js';
import { type LighthouseCheck, summarizeLhr } from './audit.js';
import {
  CATEGORY_LABELS,
  type LhCategory,
  type LhDevice,
  type LhMode,
  MODE_CATEGORIES,
} from './categories.js';

// The parts of a Lighthouse user flow that Walkthrough uses.
interface UserFlow {
  navigate(url: string, flags?: Record<string, unknown>): Promise<void>;
  startTimespan(flags?: Record<string, unknown>): Promise<void>;
  endTimespan(): Promise<void>;
  snapshot(flags?: Record<string, unknown>): Promise<void>;
  createArtifactsJson(): { gatherSteps: unknown[] };
}

type Lhr = Parameters<typeof summarizeLhr>[0];
type FlowSteps = Array<{ lhr: Lhr; name: string }>;

// A tool call must end in about a minute, so a page load gets at most 30 seconds.
const MAX_WAIT_FOR_LOAD = 30_000;

export const FLOW_REPORT = 'lighthouse/flow.report.html';
export const FLOW_JSON = 'lighthouse/flow.json';

// The Lighthouse user flow of one run. Lighthouse measures one tab per flow, so each
// tab gets its own flow. The steps of all tabs go into one flow report.
export class LhFlow {
  private flows = new Map<string, UserFlow>();
  private results: FlowSteps = [];
  // The timespan that is going, if any.
  timespan?: { tabId: string; stepId?: string; name: string };

  constructor(
    readonly runId: string,
    readonly name: string,
    readonly device: LhDevice,
    readonly categories: LhCategory[],
  ) {}

  // The categories that a step of this mode can measure.
  categoriesFor(mode: LhMode): LhCategory[] {
    const allowed = this.categories.filter((c) => MODE_CATEGORIES[mode].includes(c));
    if (allowed.length) return allowed;
    throw new ToolError(
      `A ${mode} step measures only ${MODE_CATEGORIES[mode].map((c) => CATEGORY_LABELS[c]).join(' and ')}, and this run checks ${this.categories.map((c) => CATEGORY_LABELS[c]).join(', ')}. Add one of them to the categories, or use a snapshot step.`,
      'bad_input',
    );
  }

  private config(lighthouse: LighthouseModule): unknown {
    return this.device === 'desktop' ? lighthouse.desktopConfig : undefined;
  }

  private async flowFor(lighthouse: LighthouseModule, tab: Tab): Promise<UserFlow> {
    let flow = this.flows.get(tab.id);
    if (!flow) {
      flow = (await lighthouse.startFlow(tab.page, {
        name: this.name,
        config: this.config(lighthouse),
        flags: {
          logLevel: 'error',
          enableErrorReporting: false,
          disableStorageReset: true,
          // The tab keeps its own screen and user agent.
          screenEmulation: { disabled: true },
          emulatedUserAgent: false,
          maxWaitForLoad: MAX_WAIT_FOR_LOAD,
        },
      })) as UserFlow;
      this.flows.set(tab.id, flow);
    }
    return flow;
  }

  private noTimespan(): void {
    if (this.timespan) {
      throw new ToolError(
        `The timespan "${this.timespan.name}" is going. Call lighthouse with action end first.`,
        'timespan_active',
      );
    }
  }

  // Scores the newest step of a flow. Lighthouse's own report gets it too.
  private async auditLast(lighthouse: LighthouseModule, flow: UserFlow): Promise<Lhr> {
    const steps = flow.createArtifactsJson().gatherSteps;
    const result = (await lighthouse.auditFlowArtifacts(
      { gatherSteps: steps.slice(-1), name: this.name },
      this.config(lighthouse),
    )) as { steps: FlowSteps };
    const step = result.steps[0];
    if (!step) throw new ToolError('Lighthouse gave no result for this step.', 'lighthouse_failed');
    if (!step.lhr.runtimeError) this.results.push(step);
    return step.lhr;
  }

  // Runs one measurement with the panel hidden in the tab.
  private async hidden<T>(driver: Driver, tab: Tab, work: () => Promise<T>): Promise<T> {
    await driver.panel?.suppress(tab.id, true);
    try {
      return await work();
    } finally {
      await driver.panel?.suppress(tab.id, false);
    }
  }

  // Lighthouse loads the page in the tab and measures the load.
  async navigate(driver: Driver, tab: Tab, url: string, name: string): Promise<Lhr> {
    this.noTimespan();
    const onlyCategories = this.categoriesFor('navigation');
    const lighthouse = await loadLighthouse();
    const flow = await this.flowFor(lighthouse, tab);
    await this.hidden(driver, tab, () => flow.navigate(url, { name, onlyCategories }));
    return this.auditLast(lighthouse, flow);
  }

  // Lighthouse checks the page as it is now.
  async snapshot(driver: Driver, tab: Tab, name: string): Promise<Lhr> {
    this.noTimespan();
    const onlyCategories = this.categoriesFor('snapshot');
    const lighthouse = await loadLighthouse();
    const flow = await this.flowFor(lighthouse, tab);
    await this.hidden(driver, tab, () => flow.snapshot({ name, onlyCategories }));
    return this.auditLast(lighthouse, flow);
  }

  // Starts measuring what happens in the tab. The panel stays hidden until end.
  async start(driver: Driver, tab: Tab, name: string, stepId?: string): Promise<void> {
    this.noTimespan();
    const onlyCategories = this.categoriesFor('timespan');
    const lighthouse = await loadLighthouse();
    const flow = await this.flowFor(lighthouse, tab);
    await driver.panel?.suppress(tab.id, true);
    try {
      await flow.startTimespan({ name, onlyCategories });
    } catch (error) {
      await driver.panel?.suppress(tab.id, false);
      throw error;
    }
    this.timespan = { tabId: tab.id, stepId, name };
  }

  async end(driver: Driver): Promise<{ lhr: Lhr; stepId?: string; name: string }> {
    const span = this.timespan;
    const flow = span && this.flows.get(span.tabId);
    if (!span || !flow) {
      throw new ToolError(
        'No timespan is going. Call lighthouse with action start first.',
        'no_timespan',
      );
    }
    this.timespan = undefined;
    const lighthouse = await loadLighthouse();
    try {
      await flow.endTimespan();
    } finally {
      await driver.panel?.suppress(span.tabId, false);
    }
    return { lhr: await this.auditLast(lighthouse, flow), stepId: span.stepId, name: span.name };
  }

  // What Walkthrough keeps from one step. Throws when Lighthouse could not measure it.
  check(
    lhr: Lhr,
    step: { stepId?: string; name: string },
    clean: (t: string) => string,
  ): LighthouseCheck {
    if (lhr.runtimeError) {
      throw new ToolError(
        `Lighthouse could not measure "${step.name}": ${lhr.runtimeError.message}`,
        'lighthouse_failed',
      );
    }
    return {
      ...summarizeLhr(lhr, clean),
      at: new Date().toISOString(),
      stepId: step.stepId,
      flow: true,
      name: clean(step.name),
      // The flow report opens at this step.
      files: { html: `${FLOW_REPORT}#index=${this.results.length - 1}`, json: FLOW_JSON },
    };
  }

  // Writes Lighthouse's flow report with all steps so far. Secrets are hidden first.
  async write(runDir: string, secrets: SecretStore): Promise<void> {
    if (!this.results.length) return;
    const lighthouse = await loadLighthouse();
    const result = { steps: this.results, name: this.name };
    mkdirSync(join(runDir, 'lighthouse'), { recursive: true });
    writeFileSync(
      join(runDir, FLOW_REPORT),
      secrets.redact(lighthouse.generateReport(result, 'html')),
    );
    writeFileSync(join(runDir, FLOW_JSON), secrets.redact(JSON.stringify(result)));
  }
}
