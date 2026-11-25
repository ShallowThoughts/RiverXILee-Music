// No main UI, playback polling or automatic enhancement starts before this gate.
// The backend validates and stores consent; localStorage is never an authority.
export async function requireEnhancementConsent({ read, confirm, quit }) {
  try {
    if ((await read())?.approved === true) return true;
    if ((await confirm())?.approved === true) return true;
  } catch { /* Unknown or failed consent is a refusal, never an approval. */ }
  await quit();
  return false;
}
