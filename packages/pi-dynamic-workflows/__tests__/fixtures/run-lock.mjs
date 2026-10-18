// Separate OS processes contend for the actual lease implementation (no mocked PID checks).
const { acquireRunLock, deleteRun } = await import(process.argv[2]);
const [, , , root, runId] = process.argv;
let release;
process.on('message', (command) => {
  try {
    if (command === 'acquire') release = acquireRunLock(root, runId);
    else if (command === 'release') { release?.(); release = undefined; }
    else if (command === 'delete') deleteRun(root, runId);
    process.send({ ok: true, pid: process.pid });
  } catch (error) {
    process.send({ ok: false, error: error.message });
  }
});
process.send({ ready: true });
