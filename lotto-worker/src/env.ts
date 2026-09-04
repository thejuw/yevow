/** Generated Cloudflare bindings plus the separately managed service secret. */
export type Env = Pick<Cloudflare.Env, "LOTTO_DB" | "LOTTO_RAW"> & {
  readonly RABBITHOLETX_SERVICE_TOKEN?: string;
  readonly RABBITHOLETX_SEED_SALT?: string;
};
