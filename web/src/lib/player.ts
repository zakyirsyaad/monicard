import { api } from './api';
import { loadOrCreateBurner } from './burner';
import type { ActionDeps } from './actions';
import type { Config } from './types';

export const burnerAccount = loadOrCreateBurner;

export function actionDeps(config: Config): ActionDeps {
  return { api, account: loadOrCreateBurner(), config };
}
