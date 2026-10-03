# Lighthouse reports

Walkthrough can check your pages with [Lighthouse](https://developer.chrome.com/docs/lighthouse), like the Lighthouse panel in Chrome DevTools. It checks performance, best practices, and SEO by default. The agent writes a short explanation and a short fix for each issue, and finds where to fix it in your code.

The report goes in the run folder, next to `report.html`:

- `lighthouse.html`: for people. Scores, metrics, and a card for each issue. It is one file that works offline.
- `lighthouse.md`: for an agent in a new session. It has the same content, with the issue IDs.
- `lighthouse.json`: for Walkthrough. The next report reads it to see what changed.
- `lighthouse/`: the reports from Lighthouse itself, for each page, and `flow.report.html` for a flow.

## Set up

Lighthouse is an optional download of about 170 MB. Install it once from a terminal:

```sh
npx -y walkthrough-ui setup lighthouse
```

In Claude Code, `/walkthrough:lighthouse` checks for Lighthouse first. When it is missing, the agent shows you the exact command for the plugin.

- Walkthrough installs a fixed Lighthouse version (13.5.0) with npm, in `~/.cache/uiwalk/lighthouse`. npm checks the package.
- `setup lighthouse --force` installs it again.
- Walkthrough turns off the error reports that Lighthouse can send to its team.
- `/walkthrough:doctor` shows whether Lighthouse is installed.

## Check pages

In Claude Code, run `/walkthrough:lighthouse` with the pages to check:

```text
/walkthrough:lighthouse / /help.html
```

You can also give:

- A text file with one page on each line: `/walkthrough:lighthouse pages.txt`. The agent skips lines that start with `#`.
- `mobile` or `desktop`: `/walkthrough:lighthouse / mobile`. The default is `lighthouse.device` in `config.yaml`.
- A plan name, to measure a user flow: `/walkthrough:lighthouse performance`. See [Check a user flow](#check-a-user-flow).

The agent:

1. Checks each page with the `lighthouse` tool. Without a run, this makes a run with one step per page, and `report.html`.
2. Gets the findings with `lighthouse_report`.
3. Searches your source code for where to fix each issue, if the code is in the project.
4. Writes the explanations and fixes, and calls `lighthouse_report` again to write the files.
5. Shows you the scores, the three issues to fix first, the path to `lighthouse.html`, and a prompt for the next session.

### How Walkthrough checks a page

Each page runs in its own hidden Chrome with an empty profile. Walkthrough copies the login of the active tab into it, so a page behind a login stays logged in.

Chrome remembers things from page to page, such as its cache and the favicons that did not load. A new Chrome for each page gives each check the same start, so a result does not depend on the pages before it.

- That Chrome has no Walkthrough panel, and no screen or network settings from Walkthrough. The device comes from `device`.
- Mock rules for all tabs still apply. See the [`intercept` tool](tools.md#intercept).
- The test browser does not have to be open.
- `session` loads a saved login instead of the login of the active tab.
- A call stops after about 45 seconds. The agent then calls again with the same `runId` until it has checked all pages.

## Check a user flow

A plan can measure a user flow, like the Lighthouse user flows in DevTools. Each step with a `lighthouse` key is one step of the flow:

```yaml
name: Performance
mode: autonomous
lighthouse:
  device: desktop
  report: true
steps:
  - id: open-shop
    do: Open the shop page
    action: { navigate: / }
    lighthouse: navigation
  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug, then open the cart
    lighthouse: timespan
  - id: open-checkout
    do: Click "Checkout"
    action: { click: { role: button, name: Checkout } }
    lighthouse: snapshot
```

| Mode | What Lighthouse measures | Categories |
| --- | --- | --- |
| `navigation` | The page load of the step's `navigate` action. The step needs a `navigate` action. | All |
| `timespan` | What happens while the agent does the step, such as clicks and the pages that open. | Performance and Best Practices |
| `snapshot` | The page as it is after the step, such as a form or a dialog. | All |

Run the plan with `/walkthrough:lighthouse performance`. The agent runs the plan and then writes the report. `/walkthrough:run performance` also writes the report when the plan has `report: true`.

- The run starts in a new browser with an empty profile, so earlier runs do not change the results. To start logged in, add `session` to the plan. When Walkthrough uses your own Chrome (`attach`), it cannot start a new browser, and the report says so.
- Lighthouse measures the test tab. The tab keeps its screen size, its settings, and its login. For a real mobile check, also set `device: mobile` on the plan, so the screen matches.
- Later steps use the cache and the storage of the earlier steps, like a real visit.
- Walkthrough hides its panel while Lighthouse measures. A question for you still shows.
- After each flow step, Walkthrough writes the flow report from Lighthouse to `lighthouse/flow.report.html`.

The demo shop has this plan as `performance`. See [Lighthouse flows](plan-format.md#lighthouse-flows) in the plan format.

## What the report shows

- **Scores:** a score for each category, for each page or flow step. 90 to 100 is good, 50 to 89 needs work, and below 50 is poor. A timespan or a snapshot runs fewer audits, so it shows the passed audits, such as `5/6`, and not a score.
- **Metrics:** the speed of each page load, such as First Contentful Paint, Largest Contentful Paint, Total Blocking Time, and Cumulative Layout Shift.
- **Changes since the last report:** the scores that changed, when there is an earlier report.
- **Summary:** 2 to 4 sentences from the agent.
- **Issues:** one card for each audit with a score below 90, merged across pages. Each card has an ID, the categories, the lowest score, and the details from Lighthouse for each page. It also says what is wrong, how to fix it, and where, with an example.
- **Fixed since the last report:** the issues that are gone.
- **How Walkthrough checked:** the Lighthouse version, the device, the categories, and how the pages or the flow ran. It links to the flow report from Lighthouse.
- **Next step:** a prompt for a new session.

## Issue IDs and compared reports

Each issue has an ID, such as `LH-003`. A new report compares itself with the last report:

- For pages, the last report of the same pages. For a flow, the last report of the same plan.
- An issue that is still there keeps its ID, and shows **Still there**.
- A new issue gets the next free ID, and shows **New**.
- An issue that is gone shows under **Fixed since the last report**.
- The report shows the changes in the page load scores. It does not compare timespans and snapshots.

Walkthrough compares only with reports of the same environment, because a staging server and a production server are not equally fast. `compareTo` in `lighthouse_report` picks another report to compare with, also one from another environment, such as "staging compared with production". The report then names the other environment. See [Environments](environments.md).

## Plan the fixes

After the report, the agent shows a prompt like this:

```text
Read .walkthrough/runs/<run>/lighthouse.md. It is a Lighthouse report for http://localhost:3000.
Write a plan to fix the issues. Start with the lowest scores and the largest savings.
Group the fixes by source file, and name the issue ID (like LH-001) for each fix.
When the fixes are done, run /walkthrough:lighthouse / /help.html again.
The issue IDs stay the same, so you can compare the scores.
```

Paste it into a new Claude Code session. The Markdown report tells the agent how to use it, and marks page text as data.

## Settings

The `lighthouse` block in `config.yaml` sets the defaults. The `lighthouse` block of a plan wins over it.

```yaml
lighthouse:
  device: desktop      # desktop or mobile
  categories: [performance, best-practices, seo]
```

You can add `accessibility` and `agentic-browsing` to `categories`. For accessibility, Walkthrough also has its own report, with more checks. See [Accessibility reports](accessibility.md).

## Scores change from run to run

Lighthouse runs on your computer, not on a test server. So:

- Scores change a little each time, because other programs share the computer.
- A local server is faster than a real server on the internet, so load times look better than they are.
- A dev build can be slower than a production build, because it has more code and no compression.

Compare the changes between reports more than the numbers. For numbers that you can trust, check a production build on a quiet computer, or use a service that measures real visits.

## Limits

- Walkthrough measures only the sites in `allowedOrigins`. It refuses other pages, and Lighthouse cannot open them.
- In a flow, Walkthrough hides its panel, but the panel stays in the page. It is a small part of the page, and it can change some results a little.
- A flow keeps the screen size of the tab. Lighthouse does not change the screen for the device.
- Lighthouse's own report files hold page text. Walkthrough hides the secrets from `.walkthrough/.env` in them.
