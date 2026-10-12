import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const canvasMigrationsDir = path.join(__dirname, 'migrations');

import * as accounts from './accounts.js';
import * as viewState from './view-state.js';
import * as mcpTokens from './mcp-tokens.js';
import * as connections from './connections.js';
import * as audit from './audit.js';
import * as aiProposals from '../mcp/proposals-store.js';
import * as aiClarifications from '../mcp/clarifications-store.js';
import * as canvasRoleGrants from './canvas-role-grants.js';
export { accounts, viewState, mcpTokens, connections, audit, aiProposals, aiClarifications, canvasRoleGrants };
