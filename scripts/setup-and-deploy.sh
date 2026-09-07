#!/usr/bin/env bash
# One-shot setup: authenticate wrangler, set every Worker secret, deploy.
#
# Run this yourself, locally: npm run setup
#
# Why this exists as a script rather than a list of commands to copy: the
# app-login password hash (PASSWORD_HASH = sha256("<salt>:<password>")) is
# easy to get wrong by hand — a mismatched salt/password pair just means you
# can never log in, with no error to explain why. This computes it the same
# way worker/src/auth.js does and sets both secrets from one entry.
#
# Every secret is entered here, in your own terminal — never in chat, never
# committed. `wrangler secret put` reads from stdin/prompt and Cloudflare
# stores it encrypted; this script never writes a secret to disk.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== 1/4  Cloudflare login =="
if ! npx wrangler whoami >/dev/null 2>&1; then
  npx wrangler login
else
  echo "Already logged in."
fi

echo
echo "== 2/4  WebUntis and Anthropic secrets =="
echo "(Each prompt is wrangler's own, masked where it matters. Nothing here touches this script.)"
npx wrangler secret put UNTIS_USER
npx wrangler secret put UNTIS_PASSWORD
npx wrangler secret put ANTHROPIC_API_KEY

echo
echo "== 3/4  App login =="
echo "This is the password YOU will use to open the deployed site — separate from WebUntis."
read -rsp "Choose an app login password: " APP_PASSWORD; echo
read -rsp "Confirm: " APP_PASSWORD_CONFIRM; echo
if [ "$APP_PASSWORD" != "$APP_PASSWORD_CONFIRM" ]; then
  echo "Passwords did not match. Re-run the script." >&2
  exit 1
fi

# A random salt per install; regenerating it later invalidates the old hash,
# which is exactly the "forgot my password" recovery path.
SALT=$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")
HASH=$(node -e "
  const crypto = require('crypto');
  const [salt, password] = process.argv.slice(1);
  process.stdout.write(crypto.createHash('sha256').update(\`\${salt}:\${password}\`).digest('hex'));
" "$SALT" "$APP_PASSWORD")
SESSION_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
unset APP_PASSWORD APP_PASSWORD_CONFIRM

printf '%s' "$SALT" | npx wrangler secret put PASSWORD_SALT
printf '%s' "$HASH" | npx wrangler secret put PASSWORD_HASH
printf '%s' "$SESSION_SECRET" | npx wrangler secret put SESSION_SECRET
unset SALT HASH SESSION_SECRET

echo
echo "== 4/4  Deploy =="
npx wrangler deploy

echo
echo "Done. Log in at the URL wrangler just printed with the app password you chose above."
