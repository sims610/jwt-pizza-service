const app = require('./service.js');
const metrics = require('./metrics.js');
const logger = require('./logger.js');

metrics.startReporting();

// Exceptions that escape every request handler. Log them, give the log up to
// 2 seconds to reach Grafana, then exit so the process doesn't keep running in
// an unknown state.
async function logAndExit(err) {
  console.error(err);
  await Promise.race([logger.unhandledErrorLogger(err), new Promise((resolve) => setTimeout(resolve, 2000))]);
  process.exit(1);
}
process.on('uncaughtException', logAndExit);
process.on('unhandledRejection', logAndExit);

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
