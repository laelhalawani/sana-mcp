const OUTPUT_BYTES = 4 * 1024 * 1024;

function writeLargeOutput(marker: string): void {
  process.stdout.write(marker.repeat(OUTPUT_BYTES));
}

export async function runInstall(): Promise<{
  disposition: "interaction-unavailable";
  authentication: "not-attempted";
}> {
  writeLargeOutput("I");
  return {
    disposition: "interaction-unavailable",
    authentication: "not-attempted",
  };
}

export async function runUninstall(): Promise<{
  disposition: "interaction-unavailable";
  selectedCount: 0;
}> {
  writeLargeOutput("U");
  return {
    disposition: "interaction-unavailable",
    selectedCount: 0,
  };
}
