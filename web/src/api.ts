import {
  BoardApi,
  CAPABILITY_STORAGE_KEY,
  type CapabilityStorage,
} from '../../packages/core/src/api';

function browserStorage(): CapabilityStorage {
  return {
    get: (key) => window.localStorage.getItem(key),
    set: (key, value) => window.localStorage.setItem(key, value),
    remove: (key) => window.localStorage.removeItem(key),
  };
}

export function createBrowserBoardApi(storage: CapabilityStorage = browserStorage()): BoardApi {
  return new BoardApi({
    capability: storage.get(CAPABILITY_STORAGE_KEY),
    capabilityStorage: storage,
  });
}

export * from '../../packages/core/src/api';
