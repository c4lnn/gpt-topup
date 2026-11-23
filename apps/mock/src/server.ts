import { createApp } from './app.js';
import { MOCK_PORT } from './runtime-config.js';
const app = createApp();
app.listen(MOCK_PORT, '127.0.0.1', () => console.log(`Mock: http://127.0.0.1:${MOCK_PORT}`));
