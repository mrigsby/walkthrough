# Environments

Walkthrough can run the same plans and checks on more than one copy of your app, such as development, staging, and production. Each copy is an environment. Every report shows the environment and its address, so you can compare results, such as Lighthouse scores, between environments.

| You want | See |
| --- | --- |
| To add staging or production | [Set up environments](#set-up-environments) |
| A different password or test user for each environment | [Secrets](#secrets) and [Values for each environment](#values-for-each-environment) |
| To run a plan on staging | [Choose the environment](#choose-the-environment) |
| To keep production safe | [Protected environments](#protected-environments) |
| A preview token or a basic auth login | [Headers and basic auth](#headers-and-basic-auth) |
| A video or a script for another environment | [Replays, videos, and scripts](#replays-videos-and-scripts) |

## Set up environments

The `baseUrl` and `allowedOrigins` at the top of `.walkthrough/config.yaml` are the **development** environment. Development is the default, so a project with no other environments works as before.

Add the other environments under `environments`:

```yaml
baseUrl: http://localhost:3000
allowedOrigins:
  - http://localhost:3000

environments:
  staging:
    baseUrl: https://staging.example.com
  production:
    baseUrl: https://www.example.com
```

Then ask the agent, for example:

```text
Run the checkout plan on staging.
```

An environment name uses lowercase letters, numbers, and dashes, such as `staging` or `qa-2`. You can add as many as you need.

`config.local.yaml` can also have `environments`. Walkthrough merges the two files for each environment, key by key, and the local file wins. Use the local file for an environment that only you use, such as a test server on your network.

## Settings of an environment

| Setting | Default | What it does |
| --- | --- | --- |
| `baseUrl` | none (required) | The start page, and the base for paths like `/cart`. |
| `label` | the name, like `Staging` | The name that the panel badge and the reports show. |
| `color` | green, amber, red, or gray | The color of the badge, as a hex color like `"#b45309"`. |
| `allowedOrigins` | none | More sites that this environment uses, such as a CDN or a login service. Walkthrough adds them to the shared list. |
| `vars` | none | Values for `{{var:NAME}}` in plans. See [Values for each environment](#values-for-each-environment). |
| `secrets` | none | A secret that this environment reads under another name, like `{ APP_PASSWORD: STAGING_APP_PASSWORD }`. |
| `protected` | `true` for `production` | Ask you to confirm before Walkthrough works there. See [Protected environments](#protected-environments). |
| `headers` | none | Request headers for the site of this environment only. See [Headers and basic auth](#headers-and-basic-auth). |
| `httpCredentials` | none | A basic auth login for the site of this environment only. |
| `ignoreHttpsErrors` | `false` | Open the site even when its certificate is not valid, such as a self-signed one. Walkthrough ignores this setting for a protected environment. |
| `actionTimeoutMs` | the shared value | How long an action waits for its element. Remote sites are often slower than your computer. |

To change the development environment, add `environments.development`. Its values win over the settings at the top of the file.

Lighthouse, accessibility, and video settings are the same for all environments, so the results stay comparable.

## Sites that each environment can open

Each environment can open:

- the sites in the shared `allowedOrigins`
- its own `allowedOrigins`
- the site of its `baseUrl`

Walkthrough blocks the sites of the other environments. For example, while you test development, a link to production does not open. This also works when a pattern like `https://*.example.com` would allow the site.

## Secrets

Put the secrets of an environment in its own file: `.walkthrough/.env.staging`, `.walkthrough/.env.production`, and so on. Use the same names as in `.walkthrough/.env`:

```sh
# .walkthrough/.env.staging
APP_PASSWORD=the-staging-password
```

A plan uses `{{secret:APP_PASSWORD}}` in every environment. Walkthrough looks for the value in this order:

1. `.walkthrough/.env.<name>` of the environment in use
2. `.walkthrough/.env`, but never for a protected environment. A development password never goes to production by mistake.
3. An environment variable with that name

To keep all values in one place, such as in CI, give an environment its own names with `secrets`:

```yaml
environments:
  staging:
    baseUrl: https://staging.example.com
    secrets:
      APP_PASSWORD: STAGING_APP_PASSWORD
```

Now `{{secret:APP_PASSWORD}}` reads `STAGING_APP_PASSWORD` on staging.

Git must not track these files. `/walkthrough:init` makes a `.walkthrough/.gitignore` that leaves out `.env` and every `.env.<name>`, but not `.env.example`. In a project from an older version, run `/walkthrough:init` again. It adds the missing lines and changes nothing else. `/walkthrough:doctor` shows a `FIX` line when Git would commit one of these files.

Walkthrough hides the values of all these files in its replies, reports, and HAR files.

## Values for each environment

Some test data is different in each environment, such as a test user, a product ID, or a store name. Put it in `vars`, and use `{{var:NAME}}` in plans:

```yaml
# config.yaml
vars:
  shopper: Demo Shopper
environments:
  staging:
    baseUrl: https://staging.example.com
    vars:
      shopper: Staging Shopper
```

```yaml
# a plan step
- do: Check the name on the account page
  expect: The page says "Logged in as {{var:shopper}}".
```

A plan can have its own `vars`, too. When a name is in more than one place, the environment wins over the plan, and the plan wins over `config.yaml`.

Walkthrough also sets two values: `{{var:environment}}` (the name, like `staging`) and `{{var:baseUrl}}`.

Values are not secret. The agent and the reports can show them. Use `{{secret:NAME}}` for passwords.

## Choose the environment

Walkthrough uses the first one of these that it finds:

1. The `environment` argument of a tool call, such as `run_start` or `browser_open`.
2. The environment that you chose for this session, with the `environment` tool or with the `UIWALK_ENV` variable.
3. The plan's `environment` key.
4. `environment` in `config.local.yaml`, then in `config.yaml`.
5. `development`.

In practice, you say it in plain words: "run the login plan on staging", or "switch to staging". The agent then uses the argument or the `environment` tool.

A tool argument changes the environment of the session, not only of that call. The reply says so.

A plan can say where it may run:

```yaml
name: Place an order
environment: staging              # the default for this plan
environments: [development, staging]
steps:
  ...
```

With `environments`, Walkthrough does not run or replay the plan in any other environment. Use it for plans that make data, such as orders.

## Switch environments

Ask the agent to switch, such as "switch to staging". It calls the `environment` tool with action `use`. Then:

- Open tabs on the old environment move to the same page on the new one.
- The panel shows a badge with the environment name and color.
- Tools and plans use the new base URL, sites, values, and secrets.

The agent cannot switch during a run or a recording.

The `environment` tool also lists the environments (`list`), and shows the details of the one in use (`show`). The details are its sites, its values, and the names of the secrets it can read. It never shows a secret value.

## Protected environments

An environment named `production` is protected unless you set `protected: false`. You can protect any environment with `protected: true`.

Before Walkthrough opens a page of a protected environment, it asks you to confirm. The panel in the browser shows "Use Production?" with two buttons:

- **Use Production**: Walkthrough goes on. It does not ask again until the browser closes.
- **Cancel**: Walkthrough blocks the site, and the session goes back to the environment from before.

Only a person can confirm, never the agent:

- When the panel is not there, such as with a hidden browser, Walkthrough asks through the MCP client if the client can. `/walkthrough:doctor` shows whether your client can.
- For automation, start the server with `UIWALK_ALLOW_PROTECTED=production`. Use a list for more than one, like `UIWALK_ALLOW_PROTECTED=production,partner`.

A protected environment never reads the plain `.env` file. A test that makes data, such as an order, makes real data there.

## Headers and basic auth

Many staging sites need a token or a login before they show the app. An environment can send them:

```yaml
environments:
  staging:
    baseUrl: https://staging.example.com
    headers:
      x-vercel-protection-bypass: "{{secret:VERCEL_BYPASS}}"
    httpCredentials:
      username: team
      password: "{{secret:STAGING_BASIC_PASSWORD}}"
```

Walkthrough sends the headers and answers the login only for the site of the environment. Other sites, such as a CDN or a payment form, never get them. Put the values in `.walkthrough/.env.staging`, because `config.yaml` goes into Git. `/walkthrough:doctor` warns about a plain value in `config.yaml`.

While an environment has headers or a login, Chrome skips the app's service worker, so its requests get the headers too. The headers do not go on WebSocket connections.

The `network` tool and HAR files do not show these headers. Walkthrough adds them after the page sends the request.

Chrome keeps a basic auth login for a site until the browser closes. This is also true after you switch to an environment on the same site without `httpCredentials`.

## Self-signed certificates

`ignoreHttpsErrors: true` opens the site even when its certificate is not valid. Chrome has one setting for the whole browser, so Walkthrough turns it on while that environment is in use, and off again when you switch.

## What each environment keeps apart

| Thing | Development | Other environments |
| --- | --- | --- |
| Saved logins (`session` tool) | `.walkthrough/sessions/<name>.json` | `.walkthrough/sessions/<env>/<name>.json` |
| Visual baselines | `.walkthrough/baselines/<plan>/<file>` | `.walkthrough/baselines/<plan>/<env>/<file>` |
| Run folders | `runs/<date>-<name>-<id>` | `runs/<date>-<name>-<env>-<id>` |

A saved login from one environment never goes to another. If you ask for a login that is saved only for another environment, the error names that environment.

Accessibility and Lighthouse reports compare with the last report of the same environment. To compare two environments, give the report tool `compareTo` with a run of the other environment. The report labels the other side, such as "Compared with run ... (the production environment)".

## Reports

Every report shows the environment and its address:

- `report.html` (with a colored badge) and `report.md`
- `accessibility.html`, `accessibility.md`, and `accessibility.json`
- `lighthouse.html`, `lighthouse.md`, and `lighthouse.json`, and the name of the Lighthouse flow
- issue drafts from `/walkthrough:bug`
- the `runs` list

Runs from versions before 0.4.0 show as development.

## Replays, videos, and scripts

- **Video replay:** `video` with action `replay` uses the environment in use. With `environment`, it switches first. The replay goes to the same pages on that environment, and uses its values. For example, rehearse on development, and make the video on staging.
- **Exported scripts:** a script from `/walkthrough:export` tests the environment of the run by default. With `environment`, it tests that one by default. Set `BASE_URL` to test another one. The script lists the other base URLs at the top. Values from `{{var:NAME}}` become `VARS`. Set `VAR_<NAME>`, such as `VAR_SHOPPER`, to change one.
- **Plans from `/walkthrough:record`** have no `baseUrl`, so they run in any environment.

## Try it with the demo shop

The demo shop in `examples/demo-app` has three environments. In three terminals:

```sh
npm run demo              # development: http://localhost:4321
npm run demo:staging      # staging: http://staging.localhost:4322, password stage123
npm run demo:production   # production: http://prod.localhost:4323, password prod123
```

Copy the passwords into `.walkthrough/.env.staging` and `.walkthrough/.env.production` as `DEMO_PASSWORD=...`. Then ask: "run the login plan on staging". The staging copy has an orange bar at the top, and production a red one.

Chrome sends every `*.localhost` name to your computer, so each copy has its own host and its own cookies.

## Limits

- Two environments on the same host, such as `localhost:3000` and `localhost:4000`, share cookies and logins. Chrome keeps cookies for a host, not for a port. `/walkthrough:doctor` warns about this.
- Walkthrough cannot block the site of another environment that has the same site as the one in use, such as `https://example.com/staging/` and `https://example.com/`.
- `/walkthrough:doctor` checks that each environment answers, but it does not check a protected environment.
- Headers and basic auth do not go on WebSocket connections.
