// THROWAWAY. Evidence for decision 0007, not a component.
//
// The smallest thing that can answer two questions the record asserts and had
// not proven: does splicing ciphertext preserve end-to-end TLS well enough for
// sslmode=verify-full, and does a client tolerate a database being woken in the
// middle of its connection?
//
// Deliberately missing everything a real one would need: pooling, backpressure,
// timeouts, metrics, cancellation, graceful shutdown, and any notion of who the
// client is.
import net from "node:net";

const LISTEN = Number(process.env.LISTEN_PORT ?? 5432);
const API = process.env.DRIGODB_API;              // http://drigodb-api.drigodb-system
const TOKEN = process.env.DRIGODB_TOKEN;
const NS = process.env.DB_NAMESPACE ?? "drigodb-databases";

const SSL_REQUEST = 80877103;

function sniFrom(hello) {
  try {
    let p = 5 + 4 + 2 + 32;
    p += 1 + hello[p];
    p += 2 + hello.readUInt16BE(p);
    p += 1 + hello[p];
    const end = p + 2 + hello.readUInt16BE(p);
    p += 2;
    while (p < end) {
      const type = hello.readUInt16BE(p), len = hello.readUInt16BE(p + 2);
      if (type === 0) {
        const n = hello.readUInt16BE(p + 7);
        return hello.subarray(p + 9, p + 9 + n).toString();
      }
      p += 4 + len;
    }
  } catch {}
  return undefined;
}

const api = (path, init) =>
  fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}` } });

// Wake it and wait. This is the whole point: the client's socket is already
// open and blocked on a handshake that has not started, so this time is spent
// inside connect() as far as the client is concerned.
async function ensureAwake(id) {
  const before = await (await api(`/v1/databases/${id}`)).json();
  if (before.status === "ready") return { woke: false, waitedMs: 0 };
  const t0 = Date.now();
  await api(`/v1/databases/${id}/wake`, { method: "POST" });
  for (;;) {
    const d = await (await api(`/v1/databases/${id}`)).json();
    if (d.status === "ready") return { woke: true, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > 120000) throw new Error("wake timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

net.createServer((client) => {
  client.on("error", () => client.destroy());
  client.once("data", async (first) => {
    if (first.length < 8 || first.readInt32BE(4) !== SSL_REQUEST) {
      // TLS is not optional here, and a proxy that cannot see SNI cannot route.
      client.end();
      return;
    }
    client.write("S");
    client.once("data", async (hello) => {
      const sni = sniFrom(hello);
      const id = sni?.match(/^db-([0-9a-f]{12})\./)?.[1];
      if (!id) {
        console.log(`refused: no routable SNI (${sni ?? "none"})`);
        client.destroy();
        return;
      }
      try {
        const { woke, waitedMs } = await ensureAwake(id);
        console.log(`${id}: ${woke ? `woke in ${waitedMs}ms` : "already awake"}`);

        // CloudNativePG's own Service still points at the database; drigodb's
        // is what this process is standing in front of.
        const backend = net.connect(5432, `db-${id}-rw.${NS}.svc.cluster.local`);
        backend.on("error", () => client.destroy());
        backend.once("connect", () => {
          const req = Buffer.alloc(8);
          req.writeInt32BE(8, 0);
          req.writeInt32BE(SSL_REQUEST, 4);
          backend.write(req);
          backend.once("data", (ans) => {
            if (ans.toString() !== "S") { client.destroy(); return; }
            // From here neither side is parsed. The client's TLS handshake is
            // with the DATABASE, so it validates the database's certificate and
            // this process never holds one or sees a plaintext byte.
            backend.write(hello);
            client.pipe(backend);
            backend.pipe(client);
          });
        });
      } catch (err) {
        console.log(`${id}: ${err.message}`);
        client.destroy();
      }
    });
  });
}).listen(LISTEN, () => console.log(`spike proxy on ${LISTEN}`));
