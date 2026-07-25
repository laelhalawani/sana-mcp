const { SanaStore } = await import("../../../src/store/db.js");

const store = new SanaStore();
try {
  store.updateSyncState({
    phase: "idle",
    message: "synthetic meeting listing in progress",
  });
} finally {
  store.close();
}
