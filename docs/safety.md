# Safety

An AI agent that controls a browser can do harm by mistake, and a web page can try to trick it. Walkthrough has protections for both. This page explains each one and its limits.

## Only the sites you allow

Walkthrough opens only the sites in `allowedOrigins` in `.walkthrough/config.yaml`. By default, that is `localhost` and `127.0.0.1` on any port.

- The `navigate` and `browser_open` tools refuse other sites.
- A click on a link to another site does not leave the page. Walkthrough stops the page load and tells the agent.
- A new tab that opens on another site is cleared.
- Frames inside the page, such as a payment form, can come from other sites. Walkthrough does not block them.

To test a staging server, add it to the list, such as `https://*.staging.example.com`. Do not add production sites unless you mean to test them.

## Secrets stay secret

- Put passwords in `.walkthrough/.env`, and use them as `{{secret:NAME}}`. Walkthrough puts the value into the field, and the agent sees `****`.
- Walkthrough removes secret values from everything it sends to the agent: page outlines, element values, logs, and reports. It also removes the URL-encoded and Base64 forms of each value.
- A text field that got a secret shows dots in screenshots. Password fields show dots anyway.
- Run records keep `{{secret:NAME}}`, never the value.
- In record mode, the value of a password field never leaves the page. For other private fields, click **Mark last field as secret**. Walkthrough throws the value away.
- Logs hide the values of URL parameters such as `token`, `key`, and `password`, and text that looks like a token.

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

## Risky tools are off

- The `evaluate` tool runs JavaScript in the page. It is off unless you set `allowEvaluate: true` in `config.local.yaml`.
- Uploads must come from the project folder. Walkthrough never uploads hidden files, `.env`, `config.local.yaml`, or saved logins.
- Walkthrough reads `allowEvaluate` and `uploadsRoot` only from `config.local.yaml`, which Git does not track. A change that someone commits cannot turn them on for you.

## Saved logins

- A saved login keeps only the cookies of the sites under test. When Walkthrough connects to your own Chrome, the rest of your browser stays private.
- The files are in `.walkthrough/sessions/`. Git does not track them, and only your user account can read them.
- Anyone with a saved login file can log in as that user. Do not share these files.

## GitHub issues

`/walkthrough:bug` never creates an issue for you. It shows you the draft, and it asks before it opens the issue page in your browser. You add the screenshots and click Submit. Read the draft and the screenshots before you submit, because they show what was on the page.

## Your own Chrome

When Walkthrough connects to a Chrome that is already running, it opens its own tab. The `tabs` tool lists only the tabs that Walkthrough opened, or that those tabs opened. When you close Walkthrough, it disconnects and leaves Chrome open.

## Limits

- Walkthrough is not a sandbox. Chrome runs as a normal browser on your computer. Test only apps that you trust.
- Walkthrough protects the browser tools. The agent can still read files in your project with its own tools. Use the Claude Code permission rules to limit that.
- The protections for page text lower the risk of prompt injection. They cannot remove it. Watch what the agent does. If something looks wrong, stop it.

To report a security problem in Walkthrough, use private vulnerability reporting on the **Security** tab of the GitHub repository. Do not open a public issue for it.
