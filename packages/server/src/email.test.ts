import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brevoMailer, EmailAuth, validVault, type Mailer, type VaultBlob } from "./email.ts";

const blob = (address = "0x00000000000000000000000000000000000000a1"): VaultBlob => ({ v: 1, kdf: "pbkdf2-sha256", iter: 600_000, salt: "c2FsdHNhbHRzYWx0", iv: "aXZpdml2aXZpdg==", ct: "Y2lwaGVydGV4dGNpcGhlcnRleHQ=", address });

function setup(opts: { perEmail?: number; perIp?: number } = {}) {
  const sent: Array<{ to: string; code: string }> = [];
  let now = 1_000_000;
  const mailer: Mailer = { sendCode: async (to, code) => void sent.push({ to, code }) };
  const dir = mkdtempSync(join(tmpdir(), "playpot-email-"));
  let n = 0;
  const make = () => new EmailAuth({ dataDir: dir, mailer, now: () => now, makeCode: () => String(100000 + n++), perEmailPerHour: opts.perEmail, perIpPerHour: opts.perIp });
  return { auth: make(), remake: make, sent, dir, tick: (ms: number) => (now += ms) };
}

test("a code is emailed, and the right code gives a token", async () => {
  const { auth, sent } = setup();
  assert.equal(await auth.start("Alice@Example.com ", "1.1.1.1"), "sent");
  assert.deepEqual(sent.map((s) => s.to), ["alice@example.com"], "addresses are normalised");
  const r = auth.verify("alice@example.com", sent[0].code);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.hasVault, false, "a new address has no wallet yet");
});

test("a wrong code is refused, five wrong tries lock it, and the right code no longer works", async () => {
  const { auth, sent } = setup();
  await auth.start("a@b.co", "1.1.1.1");
  for (let i = 0; i < 4; i++) assert.deepEqual(auth.verify("a@b.co", "000000"), { ok: false, reason: "wrong" });
  assert.deepEqual(auth.verify("a@b.co", "000000"), { ok: false, reason: "locked" });
  assert.deepEqual(auth.verify("a@b.co", sent[0].code), { ok: false, reason: "locked" });
});

test("a code works once and expires after ten minutes", async () => {
  const { auth, sent, tick } = setup();
  await auth.start("a@b.co", "1.1.1.1");
  assert.equal(auth.verify("a@b.co", sent[0].code).ok, true);
  assert.equal(auth.verify("a@b.co", sent[0].code).ok, false, "spent");
  tick(30_000);
  await auth.start("a@b.co", "1.1.1.1");
  tick(11 * 60_000);
  assert.equal(auth.verify("a@b.co", sent[1].code).ok, false, "expired");
});

test("codes cannot be requested in a flood", async () => {
  const { auth, tick } = setup({ perEmail: 3 });
  assert.equal(await auth.start("a@b.co", "1.1.1.1"), "sent");
  assert.equal(await auth.start("a@b.co", "1.1.1.1"), "limited", "one every 20 seconds");
  for (let i = 0; i < 2; i++) {
    tick(25_000);
    assert.equal(await auth.start("a@b.co", "1.1.1.1"), "sent");
  }
  tick(25_000);
  assert.equal(await auth.start("a@b.co", "1.1.1.1"), "limited", "three an hour");
  const ip = setup({ perIp: 2 });
  assert.equal(await ip.auth.start("x1@b.co", "9.9.9.9"), "sent");
  assert.equal(await ip.auth.start("x2@b.co", "9.9.9.9"), "sent");
  assert.equal(await ip.auth.start("x3@b.co", "9.9.9.9"), "limited", "an address cannot mass-mail");
});

test("junk is not accepted as an address", async () => {
  const { auth, sent } = setup();
  for (const bad of ["", "nope", "a@b", "a b@c.de", null, 5, "x".repeat(300) + "@a.bc"]) assert.equal(await auth.start(bad, "1.1.1.1"), "invalid");
  assert.equal(sent.length, 0);
});

test("a failing email service reports failure and leaves no usable code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "playpot-email-"));
  const auth = new EmailAuth({ dataDir: dir, mailer: { sendCode: async () => Promise.reject(new Error("brevo is down")) }, makeCode: () => "123456" });
  assert.equal(await auth.start("a@b.co", "1.1.1.1"), "failed");
  assert.equal(auth.verify("a@b.co", "123456").ok, false);
});

test("an encrypted wallet key is stored per address, newest first, and older versions are kept", async () => {
  const { auth, sent, tick } = setup();
  await auth.start("a@b.co", "1.1.1.1");
  const t = auth.verify("a@b.co", sent[0].code);
  assert.ok(t.ok);
  const token = t.ok ? t.token : "";
  assert.equal(auth.vaultFor(token), undefined, "nothing saved yet");
  assert.equal(auth.putVault(token, blob("0x00000000000000000000000000000000000000a1")), "ok");
  assert.equal(auth.putVault(token, blob("0x00000000000000000000000000000000000000a2")), "ok");
  const got = auth.vaultFor(token) as { blob: VaultBlob; version: number };
  assert.equal(got.blob.address, "0x00000000000000000000000000000000000000a2");
  assert.equal(got.version, 2);

  // another address cannot see it, and a second sign-in finds it
  tick(30_000);
  await auth.start("a@b.co", "1.1.1.1");
  const again = auth.verify("a@b.co", sent[1].code);
  assert.equal(again.ok && again.hasVault, true);
  await auth.start("other@b.co", "1.1.1.1");
  const other = auth.verify("other@b.co", sent[2].code);
  assert.equal(other.ok && other.hasVault, false);
});

test("a token is needed, expires, and only valid wallet data is stored", async () => {
  const { auth, sent, tick } = setup();
  assert.equal(auth.vaultFor("nope"), "unauthorized");
  assert.equal(auth.putVault(undefined, blob()), "unauthorized");
  await auth.start("a@b.co", "1.1.1.1");
  const t = auth.verify("a@b.co", sent[0].code);
  const token = t.ok ? t.token : "";
  assert.equal(auth.putVault(token, { ...blob(), iter: 1000 }), "invalid", "a weak key derivation is refused");
  assert.equal(auth.putVault(token, { ...blob(), address: "nope" }), "invalid");
  assert.equal(auth.putVault(token, { v: 1 }), "invalid");
  assert.equal(validVault({ ...blob(), kdf: "md5" }), false);
  tick(21 * 60_000);
  assert.equal(auth.vaultFor(token), "unauthorized", "the token expired");
});

test("what is saved on disk holds no email address, and survives a restart", async () => {
  const { auth, remake, sent, dir } = setup();
  await auth.start("alice@example.com", "1.1.1.1");
  const t = auth.verify("alice@example.com", sent[0].code);
  auth.putVault(t.ok ? t.token : "", blob());
  const onDisk = readFileSync(join(dir, "vaults.jsonl"), "utf8");
  assert.equal(onDisk.includes("alice"), false, "only a keyed hash of the address is stored");
  assert.equal(onDisk.includes("example.com"), false);

  const restarted = remake();
  await restarted.start("alice@example.com", "1.1.1.1");
  const again = restarted.verify("alice@example.com", sent[1].code);
  assert.equal(again.ok && again.hasVault, true, "the same pepper finds the same wallet after a restart");
});

test("the Brevo request has the shape their API expects, and never leaks the key into an error", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: { sender: { email: string }; to: Array<{ email: string }>; subject: string; textContent: string } }> = [];
  const ok = brevoMailer({
    apiKey: "SECRET-KEY",
    fromEmail: "no-reply@playpot.gg",
    fetchFn: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch,
  });
  await ok.sendCode("a@b.co", "123456");
  assert.equal(seen[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(seen[0].headers["api-key"], "SECRET-KEY");
  assert.equal(seen[0].body.sender.email, "no-reply@playpot.gg");
  assert.deepEqual(seen[0].body.to, [{ email: "a@b.co" }]);
  assert.match(seen[0].body.subject, /123456/);
  assert.match(seen[0].body.textContent, /never ask for your passphrase/);

  const bad = brevoMailer({ apiKey: "SECRET-KEY", fromEmail: "x@y.zz", fetchFn: (async () => new Response("sender not verified", { status: 400 })) as unknown as typeof fetch });
  await assert.rejects(bad.sendCode("a@b.co", "123456"), (e: Error) => /400/.test(e.message) && !/SECRET/.test(e.message));
});

test("a recovery key's saved blob may say which wallet it belongs to, and only with a sensible wallet", () => {
  const ok = { ...blob(), wallet: { address: "0x00000000000000000000000000000000000000b2", ownerIndex: 1 } };
  assert.equal(validVault(ok), true);
  assert.equal(validVault({ ...ok, wallet: { address: "nope", ownerIndex: 1 } }), false);
  assert.equal(validVault({ ...ok, wallet: { address: ok.wallet.address, ownerIndex: -1 } }), false);
  assert.equal(validVault({ ...ok, wallet: "x" }), false);
});
