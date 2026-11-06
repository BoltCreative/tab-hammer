// Chrome Web Store from CI (.github/workflows/store.yml and release.yml):
//
//   node scripts/cws.ts upload <zip>   replace the item's draft with the zip
//   node scripts/cws.ts publish        submit the draft for review
//
// Reads CWS_PUBLISHER_ID, CWS_ITEM_ID, and either CWS_SERVICE_ACCOUNT_KEY (the service account's
// JSON key) or CWS_CLIENT_ID, CWS_CLIENT_SECRET, and CWS_REFRESH_TOKEN. docs/store/release.md has
// the one-time setup. An upload the store can't take yet (a review is pending) is a warning; a
// submission it can't take is an error.
import { appendFile, readFile } from 'node:fs/promises';
import { Cws, CwsError, type CwsConfig, type ServiceAccountKey } from './cwsClient.ts';

const actions = process.env.GITHUB_ACTIONS === 'true';
const say = (level: 'notice' | 'warning' | 'error', message: string) =>
  console.log(actions ? `::${level}::${message}` : `${level}: ${message}`);
function fail(message: string): never {
  say('error', message);
  process.exit(1);
}

function config(): CwsConfig {
  const env = (name: string) => process.env[name]?.trim() || undefined;
  const publisherId = env('CWS_PUBLISHER_ID') ?? fail('CWS_PUBLISHER_ID is not set.');
  const itemId = env('CWS_ITEM_ID') ?? fail('CWS_ITEM_ID is not set.');
  const key = env('CWS_SERVICE_ACCOUNT_KEY');
  if (key) {
    let parsed: Partial<ServiceAccountKey>;
    try {
      parsed = JSON.parse(key) as Partial<ServiceAccountKey>;
    } catch {
      fail('CWS_SERVICE_ACCOUNT_KEY is not JSON; paste the whole key file.');
    }
    if (!parsed.client_email || !parsed.private_key)
      fail(
        'CWS_SERVICE_ACCOUNT_KEY has no client_email or private_key; is it a service account key?',
      );
    return {
      publisherId,
      itemId,
      credentials: { client_email: parsed.client_email, private_key: parsed.private_key },
    };
  }
  const clientId = env('CWS_CLIENT_ID');
  const clientSecret = env('CWS_CLIENT_SECRET');
  const refreshToken = env('CWS_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !refreshToken)
    fail(
      'Set CWS_SERVICE_ACCOUNT_KEY, or all of CWS_CLIENT_ID, CWS_CLIENT_SECRET, and CWS_REFRESH_TOKEN.',
    );
  return { publisherId, itemId, credentials: { clientId, clientSecret, refreshToken } };
}

const [action, file] = process.argv.slice(2);
try {
  if (action === 'upload') {
    if (!file) fail('usage: cws.ts upload <zip>');
    const outcome = await new Cws(config()).upload(await readFile(file));
    say(outcome.done ? 'notice' : 'warning', outcome.message);
    // The workflow tags the commit only when its build reached the store.
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `uploaded=${outcome.done}\n`);
  } else if (action === 'publish') {
    const outcome = await new Cws(config()).publish();
    if (!outcome.done) fail(outcome.message);
    say('notice', outcome.message);
  } else {
    fail('usage: cws.ts upload <zip> | publish');
  }
} catch (e) {
  if (e instanceof CwsError) fail(e.message);
  throw e;
}
