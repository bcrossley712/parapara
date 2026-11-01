// tests/support/fake-r2.js
//
// An in-memory stand-in for a Cloudflare R2 bucket binding — the
// subset the backup Worker uses (put, get, head, delete, list with
// prefix / delimiter / cursor). Used by the Worker's unit tests and by
// the e2e server (serve.js hosts the real Worker on top of it). Test
// tooling only.

const toBytes = (value) => {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError('fake R2 stores strings and bytes only');
};

export class FakeR2 {
  constructor({ now = () => Date.now() } = {}) {
    this.objects = new Map(); // key -> { bytes, uploaded: ms }
    this.now = now;
    this.calls = 0;
  }

  #meta(key, entry) {
    return { key, size: entry.bytes.length, uploaded: new Date(entry.uploaded) };
  }

  async put(key, value) {
    this.calls++;
    const entry = { bytes: toBytes(value), uploaded: this.now() };
    this.objects.set(key, entry);
    return this.#meta(key, entry);
  }

  async get(key) {
    this.calls++;
    const entry = this.objects.get(key);
    if (!entry) return null;
    const bytes = entry.bytes;
    return {
      ...this.#meta(key, entry),
      body: bytes.slice(),
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
    };
  }

  async head(key) {
    this.calls++;
    const entry = this.objects.get(key);
    return entry ? this.#meta(key, entry) : null;
  }

  async delete(keys) {
    this.calls++;
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list({ prefix = '', delimiter, cursor, limit = 1000 } = {}) {
    this.calls++;
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const objects = [];
    const prefixes = new Set();
    for (const key of keys) {
      if (delimiter) {
        const at = key.indexOf(delimiter, prefix.length);
        if (at >= 0) {
          prefixes.add(key.slice(0, at + delimiter.length));
          continue;
        }
      }
      objects.push(key);
    }
    const start = cursor ? Number(cursor) : 0;
    const page = objects.slice(start, start + limit);
    const truncated = start + limit < objects.length;
    return {
      objects: page.map((k) => this.#meta(k, this.objects.get(k))),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: [...prefixes],
    };
  }

  // Test helper: pretend `key` was uploaded at `ms`.
  age(key, ms) {
    const entry = this.objects.get(key);
    if (entry) entry.uploaded = ms;
  }
}
