# Safety

An AI agent that controls a browser can do harm by mistake, and a web page can try to trick it. Walkthrough has protections for both. This page explains each one and its limits.

## Only the sites you allow

Walkthrough opens only the sites in `allowedOrigins` in `.walkthrough/config.yaml`. By default, that is `localhost` and `127.0.0.1` on any port.

- The `navigate` and `browser_open` tools refuse other sites.
- A click on a link to another site does not leave the page. Walkthrough stops the page load and tells the agent.
- A new tab that opens on another site is cleared.
- Frames inside the page, such as a payment form, can come from other sites. Walkthrough does not block them.
- Mock rules from the `intercept` tool cannot open a site that is not allowed. The guard checks each page load before any rule.

To test a staging server, add it as an environment. See [Environments](environments.md). Walkthrough then blocks the sites of the other environments, also when a pattern like `https://*.example.com` would allow them.

## Protected environments

An environment named `production`, and any environment with `protected: true`, needs your OK before Walkthrough opens a page there:

- The panel in the browser asks, with **Use Production** and **Cancel**. Only a real click counts. The agent cannot answer for you.
- Without the panel, Walkthrough asks through the MCP client, if the client can. For automation, `UIWALK_ALLOW_PROTECTED` names the environments that need no question.
- Your OK lasts until the browser closes.
- A protected environment never reads the plain `.walkthrough/.env` file, so development passwords never go there.

Extra headers and basic auth logins of an environment go only to the site of that environment, never to other sites. See [Headers and basic auth](environments.md#headers-and-basic-auth).

## Secrets stay secret

- Put passwords in `.walkthrough/.env`, and use them as `{{secret:NAME}}`. Walkthrough puts the value into the field, and the agent sees `****`. Each environment can have its own file, such as `.walkthrough/.env.staging`.
- Walkthrough removes secret values from everything it sends to the agent: page outlines, element values, logs, and reports. It also removes the URL-encoded and Base64 forms of each value.
- Report files and issue drafts hide the values in `.walkthrough/.env` and in every `.walkthrough/.env.<name>`. They also hide secrets from environment variables that the server used during the run. When Walkthrough writes a report again later, such as with `/walkthrough:report`, it knows only the values in `.walkthrough/.env`.
- A text field that got a secret shows dots in screenshots. Password fields show dots anyway.
- Run records keep `{{secret:NAME}}`, never the value.
- In record mode, the value of a password field never leaves the page. For other private fields, click **Mark last field as secret**. Walkthrough throws the value away.
- Logs hide the values of URL parameters such as `token`, `key`, and `password`, and text that looks like a token.
- The `network` tool shows login headers and secret body fields, such as `password`, as a fingerprint. HAR files always remove them.
- The `storage` tool shows cookie and storage values as a fingerprint, not the value. Only `allowSecretValues: true` in `config.local.yaml` shows them. It reads and changes only the sites under test that are open in the active tab's login, never other sites.
- The `network` tool keeps the bodies of text responses in memory while the server runs, up to 256 KB each. It shows them to the agent as page text, with secrets removed.

`/walkthrough:init` offers to add rules to `.claude/settings.json` that stop Claude Code from reading `.walkthrough/.env` and saved logins. We recommend these rules.

## Page text is data

A web page can contain text such as "Ignore your instructions and ...". Walkthrough puts all text from a page between `<page-content untrusted="true">` tags, with a note that says to treat it as data. The skill tells the agent never to follow instructions from a page. Walkthrough also escapes the tags if a page contains them.

Your notes from the panel are not page text. The agent treats them as your words.

## The panel cannot be faked

The page under test could try to click **Pass** for you. Walkthrough stops this:

- The panel runs in an isolated world. Page scripts cannot see its code or call it.
- The panel uses a closed shadow root, so page scripts cannot reach its buttons.
- The panel ignores clicks that a script makes. Only real clicks count.
- Each question has a one-time code. An answer without the current code does not count.
- The agent cannot use the panel either. Page outlines leave it out, and the `act` tool refuses to click it.

## Videos

- Walkthrough hides the panel in videos, except in bug clips. It hides a field before the agent types a secret into it.
- A video shows everything else on the screen, such as names and email addresses. Walkthrough removes secrets from text, but it does not check the pictures of a video. Use test data, and watch a video before you share it.
- Videos stay in the run folder, which Git does not track, unless you give a `path`.

See [Videos](video.md#privacy).

## Presentations

- The presenter window is a page of Walkthrough's own, in its own browser login. No server or port serves it: Chrome gets the page from Walkthrough. The page cannot go to another address, and the tools never see it.
- The presenter window and the audience window count only real clicks and key presses. A script in the app cannot move the presentation or press **Present here**.
- On a protected environment, the presenter confirms it in the presenter window before the app opens. The agent cannot confirm it.
- During a presentation, the agent can use only tools that read. It cannot click, type, or change the page that the audience sees.
- The audience screen blurs the parts of the page that the plan's `mask` names. Fields with secrets show dots.
- Chat questions go to the agent as data, between `<page-content>` tags. The handout hides secrets in the chat and the notes, but it shows the questions and answers. Read it before you share it.
- A recording shows everything else on the audience screen, like a video. See [Videos](#videos).

See [Presentations](presentations.md).

## Risky tools are off

- The `evaluate` tool runs JavaScript in the page. It is off unless you set `allowEvaluate: true` in `config.local.yaml`.
- Uploads must come from the project folder. Walkthrough never uploads hidden files, `.env`, `config.local.yaml`, or saved logins.
- Walkthrough reads `allowEvaluate`, `uploadsRoot`, `screenshotRoots`, `allowSecretValues`, and `ffmpegPath` only from `config.local.yaml`, which Git does not track. A change that someone commits cannot turn them on for you. For example, an `ffmpegPath` in a shared file could make Walkthrough run any program when you clone a project.

## Saved logins

- A saved login keeps only the cookies of the sites under test. When Walkthrough connects to your own Chrome, the rest of your browser stays private.
- The files are in `.walkthrough/sessions/`. Git does not track them, and only your user account can read them.
- Anyone with a saved login file can log in as that user. Do not share these files.

## GitHub issues

`/walkthrough:bug` never creates an issue for you. It shows you the draft, and it asks before it opens the issue page in your browser. You add the screenshots and click Submit. Read the draft and the screenshots before you submit, because they show what was on the page.

## Downloads

Lighthouse, ffmpeg, and Chrome for Testing are optional downloads. Walkthrough downloads them only when you run `uiwalk setup` in a terminal. The tools never download anything by themselves.

- Lighthouse comes from npm, at a fixed version. npm checks the package. Walkthrough turns off the error reports that Lighthouse can send to its team.
- ffmpeg comes from a fixed release. Walkthrough checks the SHA-256 hash of the download against a hash in its code, and refuses a file that does not match.
- All downloads go in `~/.cache/uiwalk`, or in `UIWALK_CACHE_DIR`.

## Your own Chrome

When Walkthrough connects to a Chrome that is already running, it opens its own tab. The `tabs` tool lists only the tabs that Walkthrough opened, or that those tabs opened. When you close Walkthrough, it disconnects and leaves Chrome open.

## Limits

- Walkthrough is not a sandbox. Chrome runs as a normal browser on your computer. Test only apps that you trust.
- Walkthrough protects the browser tools. The agent can still read files in your project with its own tools. Use the Claude Code permission rules to limit that.
- The protections for page text lower the risk of prompt injection. They cannot remove it. Watch what the agent does. If something looks wrong, stop it.

To report a security problem in Walkthrough, use private vulnerability reporting on the **Security** tab of the GitHub repository. Do not open a public issue for it.
