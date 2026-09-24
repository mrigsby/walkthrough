---
description: Set up Walkthrough in this project. Makes the .walkthrough folder with settings and a sample plan.
argument-hint: "[start URL, like http://localhost:3000]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__init_project
---

Set up Walkthrough in this project.

Arguments: $ARGUMENTS

1. If the arguments contain a URL, use it as the start URL. If not, ask the developer for the start URL of the app, such as `http://localhost:3000`.
2. Call the `init_project` tool with `baseUrl` set to the start URL.
3. Show the developer the files that `init_project` created and the files that it kept.
4. Offer to protect the secrets file from the agent. Show this change to the project file `.claude/settings.json`. Ask the developer before you make it:

   ```json
   {
     "permissions": {
       "deny": ["Read(./.walkthrough/.env)", "Read(./.walkthrough/sessions/**)"]
     }
   }
   ```

   If the file exists, add the two rules to its `permissions.deny` list. Keep all other settings. If the developer says no, do not change the file.
5. Tell the developer the next steps:
   - To use passwords in plans, copy `.walkthrough/.env.example` to `.walkthrough/.env` and add the values.
   - If the app uses other sites, such as a staging server, add them to `allowedOrigins` in `.walkthrough/config.yaml`.
   - Run `/walkthrough:plan` to write a test plan, or `/walkthrough:run smoke` to try the sample plan.
