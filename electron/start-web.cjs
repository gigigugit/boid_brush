const { startStaticServer } = require('./static-server.cjs');

async function main() {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.PORT || '4173', 10);
  const staticServer = await startStaticServer({ host, port, defaultPage: 'app.html' });

  console.log(`Boid Brush web app: ${staticServer.appUrl}`);
  console.log('Press Ctrl+C to stop.');

  const shutdown = async () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await staticServer.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
