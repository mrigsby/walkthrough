# Getting started

This guide takes you from install to your first test run and your first bug report. It takes about ten minutes.

## Before you start

You need:

- Node.js 22.12 or later. Run `node --version` to check.
- Google Chrome.
- Claude Code.
- A web app that runs on your computer, such as `http://localhost:3000`.

## 1. Install the plugin

In Claude Code, run:

```text
/plugin marketplace add mrigsby/walkthrough
/plugin install walkthrough@walkthrough
```

If Claude Code asks you to restart, restart it.

Then run `/walkthrough:doctor`. Each line starts with `OK`, `INFO`, or `FIX`. If a line starts with `FIX`, the agent explains how to fix it. See [Troubleshooting](troubleshooting.md) for more help.

## 2. Set up your project

Start your app. Then, in Claude Code in your project folder, run:

```text
/walkthrough:init http://localhost:3000
```

Use the address of your app. This makes the `.walkthrough` folder:

- `config.yaml` has the settings, such as the start page and the sites that Walkthrough may open.
- `plans/smoke.yaml` is a sample plan with one step.
- `.env.example` shows how to add passwords.

The agent also offers to stop itself from reading your secrets file. It shows you the change first. We recommend that you say yes.

If your app uses other sites, such as a staging server or a login provider, add them to `allowedOrigins` in `.walkthrough/config.yaml`. Walkthrough blocks every other site. See [Settings](config.md).

## 3. Run the sample plan

Run:

```text
/walkthrough:run smoke
```

A Chrome window opens at your start page. A panel shows in the bottom-right corner:

- **What I did** tells you what the agent did.
- **What you should see** tells you what to check.
- Click **Pass** if the page looks right.
- Click **Bug** if it does not. Type what is wrong in the notes first.
- Click **Skip** to skip the step, or **Stop** to stop the test.

You can drag the panel, move it to another corner with ⇄, or make it small with −. The agent does not see the panel, and the app cannot click it.

When the run ends, the agent tells you the result and the path to `report.html`. Open it in any browser.

## 4. Test something real

Ask in plain words. For example:

> Walk me through adding an item to the cart and checking out. Ask me to confirm each step.

The agent opens the browser, does each step, and asks you in the panel. Before each click, an orange box shows you which element it is about to use.

### Use passwords safely

Never type a password in the chat. Instead:

1. Copy `.walkthrough/.env.example` to `.walkthrough/.env`.
2. Add a line such as `APP_PASSWORD=your-password`.
3. Ask the agent to log in with `{{secret:APP_PASSWORD}}`.

Walkthrough puts the real value into the field. The agent sees only `****`.

## 5. Save it as a plan

To run the same test again later, save it as a plan. You have three ways:

- **Describe it.** Run `/walkthrough:plan log in and change my display name`. The agent looks at the app and writes a plan for you to check.
- **Record it.** Run `/walkthrough:record`. Use the app as usual. Then click **Stop recording** in the panel. The agent turns what you did into a plan.
- **Write it.** Make a YAML file in `.walkthrough/plans/`. See the [Test plan format](plan-format.md).

Then run it with `/walkthrough:run <plan name>`.

## 6. Choose a run mode

The mode sets which steps you confirm:

| Mode | You confirm |
| --- | --- |
| `interactive` | Every step. |
| `checkpoints` | Only the steps with `checkpoint: true`. The agent checks the other steps. This is the default. |
| `autonomous` | No steps. The agent checks each step and saves a screenshot when a step fails. |

Add the mode to the command, such as `/walkthrough:run checkout autonomous`.

## 7. Report a bug

When a step fails or you click **Bug**, Walkthrough saves:

- a screenshot with a red box on the element from the last action
- the console errors, page errors, and failed requests from that step
- your notes

To make a GitHub issue from it, run `/walkthrough:bug`. The agent shows you the draft first. After you agree, your browser opens a new issue page that has the title and the body. Drag the screenshots into the issue. Then submit it.

## Next steps

- [Test plan format](plan-format.md): every plan key, visual checks, and saved logins
- [Settings](config.md): all settings and environment variables
- [Tools](tools.md): what each tool does
- [Use with other tools and share with a team](sharing.md)
