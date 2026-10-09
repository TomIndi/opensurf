/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the SURF relay (worker/) for static builds, e.g. https://opensurf-relay.<account>.workers.dev. */
  readonly VITE_SURF_RELAY?: string;
}
