process.env.ORGLOOM_CANVAS_ONLY = '1';

const { initializeStandaloneDatabase } = await import('./standalone-db.js');
await initializeStandaloneDatabase();
await import('./server.js');
