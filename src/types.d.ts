// Secrets are set with `wrangler secret put`, so they don't appear in
// wrangler.jsonc and aren't part of the generated Env — declared here instead.
interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  // Wallboard access key. A secret (not a var) so it stays out of the public repo.
  BOARD_KEY: string;
}
