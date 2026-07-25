export async function ensureDaemonRunning(): Promise<{
  alreadyRunning: boolean;
  spawned: boolean;
}> {
  return { alreadyRunning: true, spawned: false };
}
