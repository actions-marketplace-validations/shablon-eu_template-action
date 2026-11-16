import * as core from '@actions/core';
import { run } from './main.js';

run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
