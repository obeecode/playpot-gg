import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { decryptWalletKey, encryptWalletKey, newWalletKey, passphraseProblem } from "./emailWallet.ts";

const FAST = 100_000; // the same code path as the real 600,000, a little quicker

test("a wallet key opens with its passphrase and gives the same address back", async () => {
  const pk = newWalletKey();
  const blob = await encryptWalletKey(pk, "correct horse battery staple", FAST);
  assert.equal(blob.address, privateKeyToAccount(pk).address);
  assert.equal(blob.ct.includes(pk.slice(2, 20)), false, "the key is not readable in the saved blob");
  assert.equal(await decryptWalletKey(blob, "correct horse battery staple"), pk);
});

test("a wrong passphrase does not open it", async () => {
  const blob = await encryptWalletKey(newWalletKey(), "correct horse battery staple", FAST);
  await assert.rejects(decryptWalletKey(blob, "correct horse battery stapl"), /did not open/);
  await assert.rejects(decryptWalletKey(blob, ""), /did not open/);
});

test("a blob that was altered or swapped for another address does not open", async () => {
  const blob = await encryptWalletKey(newWalletKey(), "correct horse battery staple", FAST);
  const flipped = { ...blob, ct: blob.ct.slice(0, -6) + (blob.ct.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA") };
  await assert.rejects(decryptWalletKey(flipped, "correct horse battery staple"), /did not open/);
  const other = { ...blob, address: privateKeyToAccount(newWalletKey()).address };
  await assert.rejects(decryptWalletKey(other, "correct horse battery staple"), /did not open/, "the address is bound into the encryption");
});

test("two encryptions of the same key differ, so a stolen blob says nothing about another", async () => {
  const pk = newWalletKey();
  const a = await encryptWalletKey(pk, "same passphrase here", FAST);
  const b = await encryptWalletKey(pk, "same passphrase here", FAST);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.ct, b.ct);
});

test("weak passphrases are turned away", () => {
  assert.ok(passphraseProblem("short"));
  assert.ok(passphraseProblem("aaaaaaaaaaaa"));
  assert.ok(passphraseProblem("password1234"));
  assert.equal(passphraseProblem("blue lamp river stone"), null);
});
