import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// When the client goes away, the server must stop Chrome and remove its profile.
describe('server shutdown', () => {
  it('cleans up when the client disconnects with the browser open', async () => {
    const tmp = tempDir('shutdown');
    const mcp = await startClient({ TMPDIR: tmp, UIWALK_PROJECT_DIR: tmp });
    const open = await mcp.call('browser_open', { url: 'about:blank' });
    expect(open.isError, open.text).toBe(false);
    expect(readdirSync(tmp).some((name) => name.startsWith('uiwalk-profile-'))).toBe(true);

    await mcp.close();
    // Our profile folder must be gone. Chrome's own temp files are Chrome's to manage.
    const ours = () => readdirSync(tmp).filter((name) => name.startsWith('uiwalk-'));
    for (let i = 0; i < 50 && ours().length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ours()).toEqual([]);
  });
});
