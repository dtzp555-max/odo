/// <reference types="vite/client" />

interface OdoAPI {
  platform: string;
  version: string;
  isElectron: boolean;
  gateway: {
    status: () => Promise<string>;
    start: () => Promise<string>;
    stop: () => Promise<string>;
    restart: () => Promise<string>;
  };
  ocm: {
    api: (method: string, path: string, body?: unknown) => Promise<unknown>;
  };
}

interface Window {
  odo: OdoAPI;
}
