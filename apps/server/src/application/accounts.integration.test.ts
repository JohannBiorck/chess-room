import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { GameAction, GameView } from "@chess-room/contracts";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../storage/database.js";
import { migrate, readMigrations } from "../storage/migrations.js";
import type { SessionRecord } from "../storage/records.js";
import { ACCOUNT_SESSION_LIMIT, AccountService } from "./accounts.js";
import { GameService, tokenHash } from "./games.js";
import { HistoryService, recoveryCodeHash } from "./history.js";
import { buildApplication } from "./server.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname))
  throw new Error("Account integration tests require a loopback database.");

describe("durable optional accounts and private history", () => {
  let admin: Pool;
  let db: Database;
  let schema: string;
  let games: GameService;
  let accounts: AccountService;
  const applications: Array<Awaited<ReturnType<typeof buildApplication>>> = [];
  beforeEach(async () => {
    schema = `account_test_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = new Database(url, { options: `-c search_path=${schema}` });
    await migrate(db.pool);
    games = new GameService(db);
    accounts = new AccountService(db, "http://localhost:5173");
  });
  afterEach(async () => {
    for (const app of applications.splice(0)) await app.server.close();
    await db?.close();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
  async function account(name = "Account player") {
    const primary = await games.createSession(name);
    const id = randomUUID();
    const raw = randomBytes(32).toString("base64url");
    await db.transaction(async (tx) => {
      await tx.client.query(
        "INSERT INTO accounts(id,primary_player_id,display_name,user_handle,recovery_locator) VALUES($1,$2,$3,$4,$5)",
        [
          id,
          primary.session.id,
          name,
          randomBytes(32).toString("base64url"),
          randomBytes(16).toString("base64url"),
        ],
      );
      await tx.client.query("UPDATE players SET account_id=$2 WHERE id=$1", [
        primary.session.id,
        id,
      ]);
      await tx.client.query(
        "INSERT INTO account_sessions(id,account_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '30 days')",
        [randomUUID(), id, tokenHash(raw)],
      );
    });
    const actor = await accounts.actor(raw);
    if (!actor) throw new Error("Synthetic account fixture was not valid.");
    return { id, raw, actor };
  }
  async function secondSession(owner: string) {
    const raw = randomBytes(32).toString("base64url");
    await db.pool.query(
      "INSERT INTO account_sessions(id,account_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '30 days')",
      [randomUUID(), owner, tokenHash(raw)],
    );
    const actor = await accounts.actor(raw);
    if (!actor) throw new Error("Synthetic account session was not valid.");
    return { raw, actor };
  }
  async function authorizeClaim(actor: SessionRecord, guest: SessionRecord) {
    await db.pool.query(
      "UPDATE account_sessions SET claim_guest_id=$2,claim_guest_hash=$3 WHERE id=$1",
      [actor.accountSessionId, guest.id, guest.tokenHash],
    );
  }
  async function start(
    white: SessionRecord,
    black: SessionRecord,
    mode: "standard" | "catchess" | "chaos-cat" = "standard",
  ) {
    const created = await games.create(white, {
      rulesetId: mode,
      color: "white",
      timeControl: "untimed",
      visibility: "private",
      ...(mode === "catchess" ? { catchess: { host: 100, guest: 100 } } : {}),
    });
    return games.join(black, created.invitation.token);
  }
  const move = (actor: SessionRecord, view: GameView, action: GameAction) =>
    games.command(actor, view.game.id, {
      protocolVersion: 1,
      commandId: randomUUID(),
      expectedRevision: view.game.revision,
      action,
    });
  it("claims a legacy seat without changing IDs and returns its original receipt on another device", async () => {
    const guest = await games.createSession("Old guest");
    const friend = await games.createSession("Friend");
    const owner = await account();
    let view = await start(guest.session, friend.session, "catchess");
    const command = {
      protocolVersion: 1 as const,
      commandId: randomUUID(),
      expectedRevision: view.game.revision,
      action: { type: "move" as const, from: "e2", to: "e4" },
    };
    const accepted = await games.command(guest.session, view.game.id, command);
    await authorizeClaim(owner.actor, guest.session);
    const claimed = await accounts.claim(owner.actor, guest.session);
    expect(await games.session(guest.token)).toBeNull();
    expect(await accounts.actor(owner.raw)).toBeNull();
    const next = await accounts.actor(claimed.token);
    if (!next) throw new Error("Claim did not create an account session.");
    expect((await games.view(next, view.game.id)).seat).toBe("white");
    expect(await games.command(next, view.game.id, command)).toStrictEqual(accepted);
    const other = await secondSession(owner.id);
    expect(await games.command(other.actor, view.game.id, command)).toStrictEqual(accepted);
    const receipt = await db.transaction((tx) =>
      tx.getReceipt(view.game.id, guest.session.id, command.commandId),
    );
    expect(receipt?.sessionId).toBe(guest.session.id);
    view = await move(friend.session, accepted, { type: "resign" });
    expect(view.game.phase).toBe("finished");
    expect((await accounts.history.list(next, { limit: 20 })).games).toHaveLength(1);
  });
  it("rejects imports that would give the same account both seats and rolls ownership back", async () => {
    const owner = await account();
    const guest = await games.createSession("Other seat");
    const view = await start(owner.actor, guest.session);
    await authorizeClaim(owner.actor, guest.session);
    await expect(accounts.claim(owner.actor, guest.session)).rejects.toMatchObject({
      code: "GUEST_IMPORT_CONFLICT",
    });
    expect(await games.session(guest.token)).not.toBeNull();
    expect((await games.view(owner.actor, view.game.id)).seat).toBe("white");
    await expect(games.joinOpen(owner.actor, view.game.id)).rejects.toMatchObject({
      code: "ROOM_UNAVAILABLE",
    });
  });
  it("cannot import an expired credential or transfer another account's player", async () => {
    const owner = await account();
    const other = await account("Other account");
    const guest = await games.createSession("Expired");
    await db.pool.query(
      "UPDATE player_sessions SET expires_at=clock_timestamp()-interval '1 minute',created_at=clock_timestamp()-interval '31 days' WHERE id=$1",
      [guest.session.id],
    );
    await authorizeClaim(owner.actor, guest.session);
    await expect(accounts.claim(owner.actor, guest.session)).rejects.toMatchObject({
      code: "GUEST_IMPORT_UNAVAILABLE",
    });
    await expect(accounts.claim(owner.actor, other.actor)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });
  it.each(["standard", "catchess", "chaos-cat"] as const)(
    "archives %s once with private replay and immutable finishing names",
    async (mode) => {
      const owner = await account("Finishing white");
      const friend = await games.createSession('Friend "Black"');
      let view = await start(owner.actor, friend.session, mode);
      view = await move(owner.actor, view, { type: "move", from: "e2", to: "e4" });
      view = await move(friend.session, view, { type: "resign" });
      await games.rename(friend.session, "New name");
      const listing = await accounts.history.list(owner.actor, { limit: 20 });
      expect(listing.games[0]?.opponentName).toBe('Friend "Black"');
      expect(listing.games[0]?.result).toBe("win");
      const detail = await accounts.history.detail(owner.actor, view.game.id);
      expect(detail.positions).toHaveLength(1);
      expect(detail.positions[0]?.fen).toBe(view.game.position.fen);
      expect(JSON.stringify(detail)).not.toContain('"draw"');
      expect(JSON.stringify(detail)).not.toContain("tokenHash");
      expect(JSON.stringify(detail)).not.toContain("catTurns");
      const outsider = await account("Outsider");
      await expect(accounts.history.detail(outsider.actor, view.game.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(await accounts.history.pgn(owner.actor, view.game.id)).toContain(
        '[Black "Friend \\"Black\\""]',
      );
      expect(
        (await db.pool.query("SELECT * FROM match_archives WHERE match_id=$1", [view.game.id]))
          .rowCount,
      ).toBe(1);
    },
  );
  it("imports finished guest games atomically and declines the import before claiming if capacity is exhausted", async () => {
    const white = await games.createSession("Guest white");
    const black = await games.createSession("Guest black");
    let view = await start(white.session, black.session);
    view = await move(white.session, view, { type: "resign" });
    await games.rename(black.session, "Changed after finish");
    await db.pool.query("UPDATE matches SET updated_at=updated_at+interval '1 hour' WHERE id=$1", [
      view.game.id,
    ]);
    const owner = await account();
    await authorizeClaim(owner.actor, white.session);
    const constrained = new AccountService(db, "http://localhost:5173");
    Object.assign(constrained, { history: new HistoryService(db, 1) });
    await expect(constrained.claim(owner.actor, white.session)).rejects.toMatchObject({
      code: "STORAGE_CAPACITY",
    });
    expect(await games.session(white.token)).not.toBeNull();
    expect((await accounts.history.list(owner.actor, { limit: 20 })).games).toHaveLength(0);
    const claimed = await accounts.claim(owner.actor, white.session);
    const actor = await accounts.actor(claimed.token);
    if (!actor) throw new Error("Claim failed.");
    const imported = (await accounts.history.list(actor, { limit: 20 })).games[0];
    expect(imported?.id).toBe(view.game.id);
    expect(imported?.opponentName).toBe("Guest black");
    expect(imported?.finishedAt).toBe(view.game.updatedAt);
  });
  it("keeps account games when login sessions expire and prunes operations without losing replay", async () => {
    const owner = await account();
    const friend = await games.createSession("Friend");
    let view = await start(owner.actor, friend.session);
    await db.pool.query("DELETE FROM account_sessions WHERE account_id=$1", [owner.id]);
    await games.cleanup();
    expect(
      (await db.pool.query("SELECT status FROM matches WHERE id=$1", [view.game.id])).rows[0]
        ?.status,
    ).toBe("active");
    const next = await secondSession(owner.id);
    view = await move(next.actor, view, { type: "resign" });
    await db.pool.query(
      "UPDATE matches SET updated_at=clock_timestamp()-interval '31 days' WHERE id=$1",
      [view.game.id],
    );
    await games.cleanup();
    expect(
      (await db.pool.query("SELECT * FROM matches WHERE id=$1", [view.game.id])).rowCount,
    ).toBe(0);
    expect((await accounts.history.detail(next.actor, view.game.id)).game.id).toBe(view.game.id);
  });
  it("bounds account-owned open rooms to one hour even when their old guest metadata expires", async () => {
    const owner = await account();
    let now = Date.now();
    const clocked = new GameService(db, () => now);
    await db.pool.query(
      "UPDATE player_sessions SET created_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [owner.actor.id],
    );
    const room = await clocked.create(owner.actor, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "open",
    });
    const discovery = await clocked.openRooms();
    expect(discovery[0]?.expiresAt).toBe(room.game.createdAt + 3600000);
    now += 3600000;
    expect(await clocked.openRooms()).toEqual([]);
    await clocked.expireDue();
    expect((await clocked.view(owner.actor, room.game.id)).game).toMatchObject({
      phase: "finished",
      closure: expect.any(Object),
    });
  });
  it("requires a guest proof bound to a fresh account ceremony before importing", async () => {
    const owner = await account();
    const guest = await games.createSession("Unbound");
    await expect(accounts.claim(owner.actor, guest.session)).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
    expect(await games.session(guest.token)).not.toBeNull();
  });
  it("revalidates session revocation inside every sensitive mutation transaction", async () => {
    const owner = await account();
    const guest = await games.createSession("Private guest");
    await authorizeClaim(owner.actor, guest.session);
    await accounts.logout(owner.actor);
    let deletionCallbackRan = false;
    await expect(accounts.claim(owner.actor, guest.session)).rejects.toMatchObject({
      code: "SESSION_REQUIRED",
    });
    await expect(accounts.replaceCodes(owner.actor)).rejects.toMatchObject({
      code: "SESSION_REQUIRED",
    });
    await expect(accounts.removeCredential(owner.actor, "not-a-credential")).rejects.toMatchObject({
      code: "SESSION_REQUIRED",
    });
    await expect(
      accounts.delete(owner.actor, async () => {
        deletionCallbackRan = true;
      }),
    ).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect(deletionCallbackRan).toBe(false);
    expect(await games.session(guest.token)).not.toBeNull();
  });
  it("logout revokes current or all account sessions without reviving a claimed guest token", async () => {
    const owner = await account();
    const other = await secondSession(owner.id);
    await accounts.logout(owner.actor);
    expect(await accounts.actor(owner.raw)).toBeNull();
    expect(await accounts.actor(other.raw)).not.toBeNull();
    await accounts.logout(other.actor, true);
    expect(await accounts.actor(other.raw)).toBeNull();
  });
  it("limits account sessions atomically using verified real signatures and revokes oldest logins", async () => {
    const owner = await account();
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = keys.publicKey.export({ format: "jwk" });
    if (!jwk.x || !jwk.y) throw new Error("Missing EC coordinates.");
    const publicKey = Buffer.concat([
      Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from([0x22, 0x58, 0x20]),
      Buffer.from(jwk.y, "base64url"),
    ]);
    const credentialId = randomBytes(32).toString("base64url");
    await db.pool.query(
      "INSERT INTO account_credentials(id,account_id,public_key,counter,transports,device_type,backed_up,label) VALUES($1,$2,$3,0,'[]','singleDevice',false,'Test passkey')",
      [credentialId, owner.id, publicKey],
    );
    const handle = (
      await db.pool.query<{ user_handle: string }>("SELECT user_handle FROM accounts WHERE id=$1", [
        owner.id,
      ])
    ).rows[0]?.user_handle;
    const tokens: string[] = [];
    for (let counter = 1; counter <= ACCOUNT_SESSION_LIMIT + 1; counter++) {
      const flow = await accounts.begin("session-limit-browser", "login");
      const client = Buffer.from(
        JSON.stringify({
          type: "webauthn.get",
          challenge: flow.options.challenge,
          origin: "http://localhost:5173",
          crossOrigin: false,
        }),
      );
      const authenticator = Buffer.alloc(37);
      createHash("sha256").update("localhost").digest().copy(authenticator);
      authenticator[32] = 5;
      authenticator.writeUInt32BE(counter, 33);
      const signature = sign(
        "sha256",
        Buffer.concat([authenticator, createHash("sha256").update(client).digest()]),
        keys.privateKey,
      );
      const result = await accounts.verify("session-limit-browser", flow.flowId, {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          userHandle: handle,
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authenticator.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      });
      tokens.push(result.token);
    }
    expect(
      (await db.pool.query("SELECT count(*) FROM account_sessions WHERE account_id=$1", [owner.id]))
        .rows[0]?.count,
    ).toBe(String(ACCOUNT_SESSION_LIMIT));
    expect(await accounts.actor(owner.raw)).toBeNull();
    expect(await accounts.actor(tokens[0])).toBeNull();
    const latest = await accounts.actor(tokens.at(-1));
    if (!latest) throw new Error("The newest verified session was unexpectedly revoked.");
    await accounts.logout(latest, true);
    expect(await accounts.actor(tokens.at(-1))).toBeNull();
  });
  it("recovery grants stay bounded and new kits revoke every outstanding recovery grant", async () => {
    const owner = await account();
    const kit = await accounts.replaceCodes(owner.actor);
    const first = await accounts.recover(kit.locator, kit.codes[0] ?? "");
    const second = await accounts.recover(kit.locator, kit.codes[1] ?? "");
    expect(
      (
        await db.pool.query(
          "SELECT count(*) FROM account_sessions WHERE account_id=$1 AND recovery_only",
          [owner.id],
        )
      ).rows[0]?.count,
    ).toBe("1");
    await expect(
      accounts.begin("old-recovery", "recover", {}, null, null, first.token),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await accounts.begin("new-recovery", "recover", {}, null, null, second.token);
    await accounts.replaceCodes(owner.actor);
    expect(
      (
        await db.pool.query(
          "SELECT count(*) FROM account_sessions WHERE account_id=$1 AND recovery_only",
          [owner.id],
        )
      ).rows[0]?.count,
    ).toBe("0");
    expect(
      (
        await db.pool.query(
          "SELECT count(*) FROM authentication_challenges WHERE account_id=$1 AND purpose='recover'",
          [owner.id],
        )
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("reserves future metadata growth before admitting games and bounds per-account pending ceremonies", async () => {
    const owner = await account();
    const measured = await db.pool.query<{ bytes: string }>(
      `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')`,
    );
    const measuredBytes = Number(measured.rows[0]?.bytes);
    const overhead = 72 * 1024 * 1024;
    const constrained = new HistoryService(db, measuredBytes + overhead + 512 * 1024);
    await expect(db.transaction((tx) => constrained.checkCapacity(tx, 1))).rejects.toMatchObject({
      code: "STORAGE_CAPACITY",
    });
    const admitted = new HistoryService(db, measuredBytes + overhead + 2 * 1024 * 1024);
    await expect(db.transaction((tx) => admitted.checkCapacity(tx, 1))).resolves.toBeUndefined();
    for (let n = 0; n < 8; n++)
      await accounts.begin(`account-pending-${n}`, "reauth", {}, owner.actor);
    await expect(accounts.begin("ninth-pending", "reauth", {}, owner.actor)).rejects.toMatchObject({
      code: "AUTHENTICATION_BUSY",
    });
  });
  it("recovery codes are one-use, recovery sessions cannot play, and failed WebAuthn keeps accounts untouched", async () => {
    const owner = await account();
    const kit = await accounts.replaceCodes(owner.actor);
    const code = kit.codes[0];
    if (!code) throw new Error("Missing recovery fixture.");
    const result = await accounts.recover(kit.locator, code);
    expect(await accounts.actor(result.token)).toBeNull();
    await expect(accounts.recover(kit.locator, code)).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    const rawCodes = await db.pool.query(
      "SELECT code_hash FROM account_recovery_codes WHERE account_id=$1",
      [owner.id],
    );
    expect(JSON.stringify(rawCodes.rows)).not.toContain(code);
    expect(rawCodes.rows).toHaveLength(9);
    expect(recoveryCodeHash(code)).toMatch(/^[0-9a-f]{64}$/);
    const begun = await accounts.begin("binding", "register", { displayName: "New player" });
    await expect(accounts.verify("wrong-binding", begun.flowId, {})).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(accounts.verify("binding", begun.flowId, { id: "invalid" })).rejects.toMatchObject(
      { code: "AUTHENTICATION_FAILED" },
    );
    expect((await db.pool.query("SELECT count(*) FROM accounts")).rows[0]?.count).toBe("1");
  });
  it("enforces ceremony purpose, expiry and bounded pending flows", async () => {
    const owner = await account();
    await db.pool.query(
      "UPDATE account_sessions SET verified_at=clock_timestamp()-interval '10 minutes' WHERE account_id=$1",
      [owner.id],
    );
    const stale = await accounts.actor(owner.raw);
    if (!stale) throw new Error();
    await expect(accounts.begin("bind", "add-passkey", {}, stale)).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
    for (let n = 0; n < 3; n++) await accounts.begin("limited", "login");
    await expect(accounts.begin("limited", "login")).rejects.toMatchObject({
      code: "AUTHENTICATION_BUSY",
    });
    const begun = await accounts.begin("expiry", "login");
    await db.pool.query(
      "UPDATE authentication_challenges SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [begun.flowId],
    );
    await expect(accounts.verify("expiry", begun.flowId, {})).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
  });
  it("deletes accounts, resigns active games and anonymizes retained opponent history", async () => {
    const white = await account("Delete me");
    const black = await account("Keep me");
    const view = await start(white.actor, black.actor);
    await accounts.delete(white.actor, (tx, id) => games.deleteAccountGames(tx, id));
    expect(await accounts.actor(white.raw)).toBeNull();
    const detail = await accounts.history.detail(black.actor, view.game.id);
    expect(detail.players.white?.displayName).toBe("Deleted player");
    expect(detail.game.result).toBe("win");
    expect(JSON.stringify(detail)).not.toContain("Delete me");
    expect((await db.pool.query("SELECT * FROM accounts WHERE id=$1", [white.id])).rowCount).toBe(
      0,
    );
  });
  it("offers strict same-origin protected account endpoints and a bounded private resume list", async () => {
    const owner = await account();
    await games.create(owner.actor, {
      rulesetId: "standard",
      color: "white",
      timeControl: "untimed",
      visibility: "private",
    });
    const app = await buildApplication({
      database: db,
      config: {
        databaseUrl: url,
        webOrigin: "http://localhost:5173",
        secureCookies: false,
        serveWeb: false,
      },
      workers: false,
      logger: false,
    });
    applications.push(app);
    const header = { cookie: `cat_account=${owner.raw}`, origin: "http://localhost:5173" };
    expect(
      (await app.server.inject({ url: "/api/account/games", headers: header })).json().games,
    ).toHaveLength(1);
    expect((await app.server.inject({ url: "/api/account/history" })).statusCode).toBe(401);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/auth/logout",
          payload: {},
          headers: { cookie: header.cookie, origin: "https://attacker.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/account/preferences",
          headers: header,
          payload: { volume: 50, motion: "reduced", sound: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: "/api/account/preferences",
          headers: header,
          payload: { volume: 50, motion: "reduced" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.server.inject({ url: "/api/account", headers: header })).json().account
        .preferences,
    ).toEqual({ volume: 50, motion: "reduced" });
  });
  it("rejects corrupt archive metadata and malformed cursors without changing stored history", async () => {
    const owner = await account();
    const friend = await games.createSession("Friend");
    const view = await start(owner.actor, friend.session);
    await move(owner.actor, view, { type: "resign" });
    await db.pool.query("UPDATE match_archives SET final_fen='corrupt' WHERE match_id=$1", [
      view.game.id,
    ]);
    await expect(accounts.history.detail(owner.actor, view.game.id)).rejects.toMatchObject({
      code: "ARCHIVE_INVALID",
    });
    expect(
      (await db.pool.query("SELECT * FROM match_archives WHERE match_id=$1", [view.game.id]))
        .rowCount,
    ).toBe(1);
    const malformed = Buffer.from(JSON.stringify({ at: Date.now(), id: "-".repeat(36) })).toString(
      "base64url",
    );
    await expect(
      accounts.history.list(owner.actor, { limit: 20, cursor: malformed }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("backfills legacy identities and reserves pre-account games without reservation rows", async () => {
    const oldSchema = `legacy_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${oldSchema}"`);
    const old = new Database(url, { options: `-c search_path=${oldSchema}` });
    try {
      const host = await games.createSession("Legacy");
      const friend = await games.createSession("Legacy friend");
      const created = await games.create(host.session, {
        rulesetId: "standard",
        color: "white",
        timeControl: "untimed",
        visibility: "private",
      });
      const waiting = await db.transaction((tx) => tx.getGame(created.game.id));
      const joined = await games.join(friend.session, created.invitation.token);
      const active = await db.transaction((tx) => tx.getGame(created.game.id));
      await move(host.session, joined, { type: "resign" });
      const finished = await db.transaction((tx) => tx.getGame(created.game.id));
      if (!waiting || !active || !finished) throw new Error("Missing legacy game fixture.");
      const migrations = await readMigrations();
      await migrate(
        old.pool,
        migrations.filter((m) => m.name.startsWith("001") || m.name.startsWith("002")),
      );
      for (const session of [host.session, friend.session])
        await old.pool.query(
          "INSERT INTO player_sessions(id,token_hash,display_name,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '30 days')",
          [session.id, session.tokenHash, session.displayName],
        );
      const legacyWaitingId = randomUUID();
      await old.transaction(async (tx) => {
        for (const fixture of [waiting, active, finished]) {
          const id = fixture.status === "waiting" ? legacyWaitingId : randomUUID();
          await tx.createGame({ ...fixture, id });
          await tx.addSeat({ gameId: id, color: "white", sessionId: host.session.id });
          if (fixture.status !== "waiting")
            await tx.addSeat({ gameId: id, color: "black", sessionId: friend.session.id });
        }
      });
      await migrate(old.pool, migrations);
      expect(
        (await old.pool.query("SELECT id FROM players WHERE id=$1", [host.session.id])).rows[0]?.id,
      ).toBe(host.session.id);
      expect(
        (
          await old.pool.query("SELECT display_name FROM player_sessions WHERE id=$1", [
            host.session.id,
          ])
        ).rows[0]?.display_name,
      ).toBe("Legacy");
      expect((await old.pool.query("SELECT * FROM storage_reservations")).rowCount).toBe(0);
      const measured = await old.pool.query<{ bytes: string }>(
        `SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')`,
      );
      const baseline = Number(measured.rows[0]?.bytes) + 72 * 1024 * 1024;
      const constrained = new HistoryService(old, baseline + 129 * 1024 * 1024);
      await expect(old.transaction((tx) => constrained.checkCapacity(tx, 1))).rejects.toMatchObject(
        {
          code: "STORAGE_CAPACITY",
        },
      );
      const admitted = new HistoryService(old, baseline + 131 * 1024 * 1024);
      await expect(old.transaction((tx) => admitted.checkCapacity(tx, 1))).resolves.toBeUndefined();

      // An expired legacy waiting room releases its allowance even before cleanup runs.
      await old.pool.query(
        "UPDATE matches SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
        [legacyWaitingId],
      );
      const afterExpiry = new HistoryService(old, baseline + 67 * 1024 * 1024);
      await expect(
        old.transaction((tx) => afterExpiry.checkCapacity(tx, 1)),
      ).resolves.toBeUndefined();

      // A newly inserted room is admitted once, alongside the remaining legacy allowances.
      const nextId = randomUUID();
      const admittingNewRoom = new HistoryService(old, baseline + 131 * 1024 * 1024);
      await old.transaction(async (tx) => {
        await tx.createGame({ ...waiting, id: nextId });
        await admittingNewRoom.reserve(tx, nextId);
        await tx.addSeat({ gameId: nextId, color: "white", sessionId: host.session.id });
      });
      expect(
        (
          await old.pool.query(
            "SELECT reserved_bytes FROM storage_reservations WHERE match_id=$1",
            [nextId],
          )
        ).rows[0]?.reserved_bytes,
      ).toBe("67108864");
    } finally {
      await old.close();
      await admin.query(`DROP SCHEMA "${oldSchema}" CASCADE`);
    }
  });
});
