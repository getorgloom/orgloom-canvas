// Executable bootstrap for the self-hosted package. Set standalone mode before
// importing config-bearing modules, register a local database provider, run the
// Canvas-only migrations, and only then load the HTTP server.
process.env.ORGLOOM_CANVAS_ONLY = '1';

const { initializeStandaloneDatabase } = await import('./standalone-db.js');
await initializeStandaloneDatabase();
await import('./server.js');
