import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AccountStatus } from "@chess-room/contracts";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Database, Transaction } from "../storage/database.js";
import type { JsonObject, SessionRecord } from "../storage/records.js";
import { ApplicationError } from "./errors.js";
import { HistoryService, recoveryCodeHash } from "./history.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const lifetime = 30 * 24 * 60 * 60 * 1000;
export const ACCOUNT_SESSION_LIMIT = 16;
export const ACCOUNT_IDENTITY_LIMIT = 128;
export const ACCOUNT_CREDENTIAL_LIMIT = 10;
type Purpose = "register" | "login" | "reauth" | "add-passkey" | "recover";
interface Challenge {
  id: string;
  challenge: string;
  purpose: Purpose;
  account_id: string | null;
  payload: JsonObject;
  expires_at: Date;
  binding_hash: string;
}
interface Credential {
  id: string;
  account_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  label: string;
  created_at: Date;
  last_used_at: Date | null;
}
const failure = () =>
  new ApplicationError(
    "AUTHENTICATION_FAILED",
    "Authentication could not be verified. Please try again.",
    401,
  );

export class AccountService {
  readonly history: HistoryService;
  private readonly rpID: string;
  constructor(
    readonly database: Database,
    private readonly origin: string,
  ) {
    this.rpID = new URL(origin).hostname;
    this.history = new HistoryService(database);
  }
  private async session(
    tx: Transaction,
    accountId: string,
    recoveryOnly = false,
    guestProof?: { id: string; hash: string },
  ) {
    await tx.client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext($1))", [
      `account:${accountId}`,
    ]);
    await tx.client.query(
      "DELETE FROM account_sessions WHERE account_id=$1 AND (expires_at<clock_timestamp() OR last_used_at<clock_timestamp()-interval '7 days')",
      [accountId],
    );
    if (recoveryOnly) {
      await tx.client.query("DELETE FROM account_sessions WHERE account_id=$1 AND recovery_only", [
        accountId,
      ]);
      await tx.client.query(
        "DELETE FROM authentication_challenges WHERE account_id=$1 AND purpose='recover'",
        [accountId],
      );
    }
    const raw = token();
    const id = randomUUID();
    await tx.client.query(
      `INSERT INTO account_sessions(id,account_id,token_hash,expires_at,recovery_only,claim_guest_id,claim_guest_hash)
      VALUES($1,$2,$3,clock_timestamp()+($4*interval '1 millisecond'),$5,$6,$7)`,
      [
        id,
        accountId,
        hash(raw),
        recoveryOnly ? 300000 : lifetime,
        recoveryOnly,
        guestProof?.id ?? null,
        guestProof?.hash ?? null,
      ],
    );
    await tx.client.query(
      `DELETE FROM account_sessions WHERE id IN(SELECT id FROM account_sessions WHERE account_id=$1
      ORDER BY (id=$2) DESC,created_at DESC,id DESC OFFSET $3)`,
      [accountId, id, ACCOUNT_SESSION_LIMIT],
    );
    return raw;
  }
  async actor(raw: string | undefined) {
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    return this.database.transaction(async (tx) => {
      const actor = await tx.getSession(hash(raw));
      if (actor?.accountSessionId)
        await tx.client.query(
          `UPDATE account_sessions SET last_used_at=clock_timestamp()
        WHERE id=$1 AND last_used_at<clock_timestamp()-interval '1 hour'`,
          [actor.accountSessionId],
        );
      return actor;
    });
  }
  private requireAccount(actor: SessionRecord) {
    if (!actor.accountId)
      throw new ApplicationError("ACCOUNT_REQUIRED", "Sign in to manage your account.", 401);
    return actor.accountId;
  }
  fresh(actor: SessionRecord) {
    this.requireAccount(actor);
    if (!actor.verifiedAt || Date.now() - actor.verifiedAt > 300000)
      throw new ApplicationError(
        "REAUTH_REQUIRED",
        "Verify your passkey again before this change.",
        403,
      );
  }
  private async authorizeMutation(tx: Transaction, actor: SessionRecord) {
    const accountId = this.requireAccount(actor);
    await tx.client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext($1))", [
      `account:${accountId}`,
    ]);
    const locked = await tx.client.query(
      "SELECT id FROM account_sessions WHERE id=$1 AND token_hash=$2 AND account_id=$3 FOR UPDATE",
      [actor.accountSessionId, actor.tokenHash, accountId],
    );
    const active = locked.rowCount ? await tx.getSession(actor.tokenHash) : null;
    if (!active || active.accountId !== accountId)
      throw new ApplicationError(
        "SESSION_REQUIRED",
        "Your account session has ended. Sign in again.",
        401,
      );
    this.fresh(active);
  }
  async status(actor: SessionRecord | null, guest: SessionRecord | null): Promise<AccountStatus> {
    let account: AccountStatus["account"] = null;
    if (actor?.accountId) {
      const r = await this.database.pool.query<{
        display_name: string;
        created_at: Date;
        credentials: string;
        codes: string;
        preferences: NonNullable<AccountStatus["account"]>["preferences"];
      }>(
        `SELECT a.display_name,a.created_at,a.preferences,(SELECT count(*) FROM account_credentials c WHERE c.account_id=a.id)::text AS credentials,
       (SELECT count(*) FROM account_recovery_codes r WHERE r.account_id=a.id)::text AS codes FROM accounts a WHERE a.id=$1`,
        [actor.accountId],
      );
      const row = r.rows[0];
      if (row)
        account = {
          displayName: row.display_name,
          createdAt: row.created_at.getTime(),
          expiresAt: actor.expiresAt,
          credentialCount: Number(row.credentials),
          recoveryCodesRemaining: Number(row.codes),
          preferences: row.preferences,
        };
    }
    const games =
      guest && !guest.accountId
        ? await this.database.pool.query<{ total: string; active: string }>(
            `SELECT count(*)::text AS total,count(*) FILTER(WHERE m.status IN ('waiting','active'))::text AS active FROM matches m
       JOIN match_seats s ON s.match_id=m.id WHERE s.session_id=$1`,
            [guest.id],
          )
        : null;
    return {
      account,
      guestGames: Number(games?.rows[0]?.total ?? 0),
      guestActiveGames: Number(games?.rows[0]?.active ?? 0),
      historyPolicy: { maxGames: 500, maxDays: 365 },
    };
  }
  private async credentials(tx: Transaction, accountId: string) {
    return (
      await tx.client.query<Credential>(
        "SELECT * FROM account_credentials WHERE account_id=$1 ORDER BY created_at",
        [accountId],
      )
    ).rows;
  }
  async begin(
    binding: string,
    purpose: Purpose,
    input: { displayName?: string; keepGuestGames?: boolean } = {},
    actor?: SessionRecord | null,
    guest?: SessionRecord | null,
    recoveryToken?: string,
  ) {
    if (purpose === "register" && actor?.accountId)
      throw new ApplicationError("ACCOUNT_EXISTS", "You are already signed in.", 409);
    if (purpose === "reauth" || purpose === "add-passkey") {
      if (!actor) throw failure();
      this.requireAccount(actor);
      if (purpose === "add-passkey") this.fresh(actor);
    }
    let recoveryAccount: string | null = null;
    if (purpose === "recover") {
      const result = await this.database.pool.query<{ account_id: string }>(
        "SELECT account_id FROM account_sessions WHERE token_hash=$1 AND recovery_only AND expires_at>clock_timestamp()",
        [hash(recoveryToken ?? "")],
      );
      recoveryAccount = result.rows[0]?.account_id ?? null;
      if (!recoveryAccount) throw failure();
    }
    return this.database.transaction(async (tx) => {
      await tx.client.query("SELECT pg_advisory_xact_lock(764338343,hashtext(current_schema()))");
      await tx.client.query(
        "DELETE FROM authentication_challenges WHERE expires_at<clock_timestamp()",
      );
      const pending = await tx.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM authentication_challenges WHERE binding_hash=$1",
        [hash(binding)],
      );
      if (Number(pending.rows[0]?.count) >= 3)
        throw new ApplicationError(
          "AUTHENTICATION_BUSY",
          "Too many pending requests. Please wait five minutes.",
          429,
        );
      const accountId = recoveryAccount ?? actor?.accountId ?? null;
      const counts = await tx.client.query<{ total: string; owned: string }>(
        "SELECT count(*)::text AS total,count(*) FILTER(WHERE account_id=$1)::text AS owned FROM authentication_challenges",
        [accountId],
      );
      if (Number(counts.rows[0]?.total ?? 0) >= 2048 || Number(counts.rows[0]?.owned ?? 0) >= 8)
        throw new ApplicationError(
          "AUTHENTICATION_BUSY",
          "Authentication is busy. Please wait a few minutes.",
          429,
        );
      const existing = accountId ? await this.credentials(tx, accountId) : [];
      if (purpose === "add-passkey" && existing.length >= ACCOUNT_CREDENTIAL_LIMIT)
        throw new ApplicationError(
          "CREDENTIAL_LIMIT",
          "An account can have at most ten passkeys.",
          409,
        );
      const a = accountId
        ? (
            await tx.client.query<{ user_handle: string; display_name: string }>(
              "SELECT user_handle,display_name FROM accounts WHERE id=$1",
              [accountId],
            )
          ).rows[0]
        : null;
      const userHandle = a?.user_handle ?? randomBytes(32).toString("base64url");
      const displayName = a?.display_name ?? input.displayName ?? "Cat player";
      const registration =
        purpose === "register" || purpose === "add-passkey" || purpose === "recover";
      const options = registration
        ? await generateRegistrationOptions({
            rpName: "Cat Chess",
            rpID: this.rpID,
            userName: displayName,
            userDisplayName: displayName,
            userID: Uint8Array.from(Buffer.from(userHandle, "base64url")),
            attestationType: "none",
            supportedAlgorithmIDs: [-7, -257],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
            excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
          })
        : await generateAuthenticationOptions({
            rpID: this.rpID,
            userVerification: "required",
            ...(purpose === "reauth"
              ? { allowCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })) }
              : {}),
          });
      const flowId = randomUUID();
      const payload = {
        displayName,
        userHandle,
        keepGuestGames: input.keepGuestGames ?? false,
        previousSessionId: actor?.accountSessionId ?? null,
        guestId: guest && !guest.accountId ? guest.id : null,
        guestHash: guest && !guest.accountId ? guest.tokenHash : null,
        recoveryHash: purpose === "recover" ? hash(recoveryToken ?? "") : null,
      };
      await tx.client.query(
        `INSERT INTO authentication_challenges(id,challenge,purpose,binding_hash,account_id,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '5 minutes')`,
        [flowId, options.challenge, purpose, hash(binding), accountId, payload],
      );
      return { flowId, options };
    });
  }
  private async readChallenge(tx: Transaction, binding: string, id: string) {
    const result = await tx.client.query<Challenge>(
      "SELECT * FROM authentication_challenges WHERE id=$1 AND binding_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE",
      [id, hash(binding)],
    );
    if (!result.rows[0]) throw failure();
    return result.rows[0];
  }
  private async storeCredential(
    tx: Transaction,
    accountId: string,
    response: RegistrationResponseJSON,
    challenge: Challenge,
  ) {
    if (
      typeof response.id !== "string" ||
      response.id.length > 1400 ||
      !/^[A-Za-z0-9_-]+$/.test(response.id)
    )
      throw failure();
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      throw failure();
    }
    if (!verified.verified) throw failure();
    const info = verified.registrationInfo;
    const transports = info.credential.transports ?? [];
    if (
      info.credential.id !== response.id ||
      info.credential.id.length > 1400 ||
      info.credential.publicKey.length > 4096 ||
      transports.length > 8 ||
      transports.some((value) => typeof value !== "string" || value.length > 20)
    )
      throw failure();
    await tx.client.query(
      `INSERT INTO account_credentials(id,account_id,public_key,counter,transports,device_type,backed_up,label)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Passkey')`,
      [
        info.credential.id,
        accountId,
        Buffer.from(info.credential.publicKey),
        info.credential.counter,
        JSON.stringify(
          transports.filter((value) =>
            ["usb", "nfc", "ble", "internal", "hybrid", "smart-card"].includes(value),
          ),
        ),
        info.credentialDeviceType,
        info.credentialBackedUp,
      ],
    );
  }
  private async codes(tx: Transaction, accountId: string) {
    const codes = Array.from({ length: 10 }, () => randomBytes(16).toString("base64url"));
    await tx.client.query("DELETE FROM account_recovery_codes WHERE account_id=$1", [accountId]);
    for (const code of codes)
      await tx.client.query(
        "INSERT INTO account_recovery_codes(account_id,code_hash) VALUES($1,$2)",
        [accountId, recoveryCodeHash(code)],
      );
    const result = await tx.client.query<{ recovery_locator: string }>(
      "SELECT recovery_locator FROM accounts WHERE id=$1",
      [accountId],
    );
    return { locator: result.rows[0]?.recovery_locator ?? "", codes };
  }
  async verify(binding: string, id: string, response: Record<string, unknown>) {
    return this.database.transaction(async (tx) => {
      const candidate = (
        await tx.client.query<{ account_id: string | null }>(
          "SELECT account_id FROM authentication_challenges WHERE id=$1 AND binding_hash=$2 AND expires_at>clock_timestamp()",
          [id, hash(binding)],
        )
      ).rows[0];
      const credentialOwner =
        typeof response.id === "string" && response.id.length <= 1400
          ? (
              await tx.client.query<{ account_id: string }>(
                "SELECT account_id FROM account_credentials WHERE id=$1",
                [response.id],
              )
            ).rows[0]?.account_id
          : null;
      const owner = candidate?.account_id ?? credentialOwner;
      if (owner)
        await tx.client.query(
          "SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext($1))",
          [`account:${owner}`],
        );
      const flow = await this.readChallenge(tx, binding, id);
      if (flow.purpose === "add-passkey" || flow.purpose === "reauth") {
        const active = await tx.client.query(
          `SELECT 1 FROM account_sessions WHERE id=$1 AND account_id=$2 AND NOT recovery_only
          AND expires_at>clock_timestamp() AND last_used_at>clock_timestamp()-interval '7 days'
          AND ($3::boolean OR verified_at>clock_timestamp()-interval '5 minutes')`,
          [flow.payload.previousSessionId, flow.account_id, flow.purpose === "reauth"],
        );
        if (!active.rowCount) throw failure();
      }
      let accountId = flow.account_id;
      let recovery: Awaited<ReturnType<AccountService["codes"]>> | undefined;
      if (flow.purpose === "register") {
        await this.history.checkCapacity(tx, 1048576);
        accountId = randomUUID();
        const playerId = randomUUID();
        const now = await tx.databaseNow();
        await tx.createSession({
          id: playerId,
          tokenHash: hash(token()),
          displayName: String(flow.payload.displayName),
          createdAt: now,
          expiresAt: now + lifetime,
        });
        await tx.client.query(
          "INSERT INTO accounts(id,primary_player_id,display_name,user_handle,recovery_locator) VALUES($1,$2,$3,$4,$5)",
          [
            accountId,
            playerId,
            flow.payload.displayName,
            flow.payload.userHandle,
            randomBytes(16).toString("base64url"),
          ],
        );
        await tx.client.query("UPDATE players SET account_id=$2 WHERE id=$1", [
          playerId,
          accountId,
        ]);
        await this.storeCredential(
          tx,
          accountId,
          response as unknown as RegistrationResponseJSON,
          flow,
        );
        if (flow.payload.keepGuestGames && flow.payload.guestId)
          await this.claimInTransaction(
            tx,
            accountId,
            String(flow.payload.guestId),
            String(flow.payload.guestHash),
          );
        recovery = await this.codes(tx, accountId);
      } else if (flow.purpose === "add-passkey" || flow.purpose === "recover") {
        if (!accountId) throw failure();
        await tx.client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
        if (flow.purpose === "recover") {
          const proof = await tx.client.query(
            "SELECT id FROM account_sessions WHERE account_id=$1 AND token_hash=$2 AND recovery_only AND expires_at>clock_timestamp() FOR UPDATE",
            [accountId, flow.payload.recoveryHash],
          );
          if (!proof.rowCount) throw failure();
          await tx.client.query("DELETE FROM account_credentials WHERE account_id=$1", [accountId]);
          await tx.client.query("DELETE FROM account_sessions WHERE account_id=$1", [accountId]);
          await tx.client.query(
            "DELETE FROM authentication_challenges WHERE account_id=$1 AND id<>$2",
            [accountId, id],
          );
          recovery = await this.codes(tx, accountId);
        } else if ((await this.credentials(tx, accountId)).length >= ACCOUNT_CREDENTIAL_LIMIT)
          throw new ApplicationError("CREDENTIAL_LIMIT", "Too many passkeys.", 409);
        await this.storeCredential(
          tx,
          accountId,
          response as unknown as RegistrationResponseJSON,
          flow,
        );
      } else {
        const credential = (
          await tx.client.query<Credential>(
            "SELECT * FROM account_credentials WHERE id=$1 FOR UPDATE",
            [typeof response.id === "string" ? response.id : ""],
          )
        ).rows[0];
        if (!credential || (accountId && credential.account_id !== accountId)) throw failure();
        const account = (
          await tx.client.query<{ user_handle: string }>(
            "SELECT user_handle FROM accounts WHERE id=$1",
            [credential.account_id],
          )
        ).rows[0];
        const auth = response as unknown as AuthenticationResponseJSON;
        if (
          !account ||
          (flow.purpose === "login" && !auth.response?.userHandle) ||
          (auth.response?.userHandle && auth.response.userHandle !== account.user_handle)
        )
          throw failure();
        let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
        try {
          verified = await verifyAuthenticationResponse({
            response: auth,
            expectedChallenge: flow.challenge,
            expectedOrigin: this.origin,
            expectedRPID: this.rpID,
            requireUserVerification: true,
            credential: {
              id: credential.id,
              publicKey: Uint8Array.from(credential.public_key),
              counter: Number(credential.counter),
              transports: credential.transports,
            },
          });
        } catch {
          throw failure();
        }
        if (!verified.verified) throw failure();
        accountId = credential.account_id;
        await tx.client.query(
          "UPDATE account_credentials SET counter=$2,last_used_at=clock_timestamp(),backed_up=$3 WHERE id=$1",
          [
            credential.id,
            verified.authenticationInfo.newCounter,
            verified.authenticationInfo.credentialBackedUp,
          ],
        );
      }
      if (!accountId) throw failure();
      await tx.client.query("DELETE FROM authentication_challenges WHERE id=$1", [id]);
      if (flow.payload.previousSessionId)
        await tx.client.query("DELETE FROM account_sessions WHERE id=$1", [
          flow.payload.previousSessionId,
        ]);
      const guestProof =
        flow.payload.guestId && flow.payload.guestHash
          ? { id: String(flow.payload.guestId), hash: String(flow.payload.guestHash) }
          : undefined;
      return {
        token: await this.session(tx, accountId, false, guestProof),
        ...(recovery ? { recovery } : {}),
      };
    });
  }
  async logout(actor: SessionRecord, all = false) {
    if (!actor.accountId) return;
    await this.database.pool.query(
      all
        ? "DELETE FROM account_sessions WHERE account_id=$1"
        : "DELETE FROM account_sessions WHERE id=$1",
      [all ? actor.accountId : actor.accountSessionId],
    );
  }
  async recover(locator: string, code: string) {
    return this.database.transaction(async (tx) => {
      const account = (
        await tx.client.query<{ id: string }>("SELECT id FROM accounts WHERE recovery_locator=$1", [
          locator,
        ])
      ).rows[0];
      if (!account) throw failure();
      await tx.client.query(
        "SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext($1))",
        [`account:${account.id}`],
      );
      const current = await tx.client.query(
        "SELECT id FROM accounts WHERE id=$1 AND recovery_locator=$2 FOR UPDATE",
        [account.id, locator],
      );
      if (!current.rowCount) throw failure();
      const consumed = await tx.client.query(
        "DELETE FROM account_recovery_codes WHERE account_id=$1 AND code_hash=$2 RETURNING code_hash",
        [account.id, recoveryCodeHash(code)],
      );
      if (!consumed.rowCount) throw failure();
      return { token: await this.session(tx, account.id, true) };
    });
  }
  private async claimInTransaction(
    tx: Transaction,
    accountId: string,
    guestId: string,
    guestHash: string,
  ) {
    const guest = (
      await tx.client.query<{ account_id: string | null; expires_at: Date; display_name: string }>(
        `SELECT i.account_id,p.expires_at,p.display_name FROM players i JOIN player_sessions p ON p.id=i.id
      WHERE p.id=$1 AND p.token_hash=$2 AND i.kind='human'`,
        [guestId, guestHash],
      )
    ).rows[0];
    if (
      !guest ||
      guest.account_id !== null ||
      guest.expires_at.getTime() <= (await tx.databaseNow())
    )
      throw new ApplicationError(
        "GUEST_IMPORT_UNAVAILABLE",
        "These guest games can no longer be imported.",
        409,
      );
    const games = await tx.client.query<{ id: string }>(
      `SELECT m.id FROM matches m JOIN match_seats s ON s.match_id=m.id WHERE s.session_id=$1 ORDER BY m.id`,
      [guestId],
    );
    for (const { id } of games.rows) await tx.lockGame(id);
    const current = (
      await tx.client.query<{ account_id: string | null; expires_at: Date }>(
        `SELECT i.account_id,p.expires_at FROM players i JOIN player_sessions p ON p.id=i.id
      WHERE p.id=$1 AND p.token_hash=$2 AND i.kind='human' FOR UPDATE OF p,i`,
        [guestId, guestHash],
      )
    ).rows[0];
    if (
      !current ||
      current.account_id !== null ||
      current.expires_at.getTime() <= (await tx.databaseNow())
    )
      throw new ApplicationError(
        "GUEST_IMPORT_UNAVAILABLE",
        "These guest games can no longer be imported.",
        409,
      );
    const latest = (
      await tx.client.query<{ match_id: string }>(
        "SELECT match_id FROM match_seats WHERE session_id=$1",
        [guestId],
      )
    ).rows;
    const lockedIds = new Set(games.rows.map((game) => game.id));
    if (latest.some((game) => !lockedIds.has(game.match_id)))
      throw new ApplicationError(
        "GUEST_IMPORT_CHANGED",
        "A room changed while importing. Please try again.",
        409,
      );
    for (const { id } of games.rows) {
      const game = await tx.getGame(id);
      if (!game) continue;
      const conflict = await tx.client.query(
        "SELECT 1 FROM match_seats s JOIN players p ON p.id=s.session_id WHERE s.match_id=$1 AND p.account_id=$2",
        [id, accountId],
      );
      if (conflict.rowCount)
        throw new ApplicationError(
          "GUEST_IMPORT_CONFLICT",
          "Your account already owns the other seat in one of these games.",
          409,
        );
      if (game.status === "finished" && game.lifecycle.outcome) {
        await this.history.checkCapacity(tx, 65536);
        const archived = await tx.client.query("SELECT 1 FROM match_archives WHERE match_id=$1", [
          id,
        ]);
        if (!archived.rowCount) {
          await tx.client.query("DELETE FROM storage_reservations WHERE match_id=$1", [id]);
          await this.history.reserve(tx, id, 1048576);
        }
      }
    }
    const account = (
      await tx.client.query<{ display_name: string }>(
        "SELECT display_name FROM accounts WHERE id=$1 FOR UPDATE",
        [accountId],
      )
    ).rows[0];
    if (!account) throw failure();
    const identities = await tx.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM players WHERE account_id=$1",
      [accountId],
    );
    if (Number(identities.rows[0]?.count) >= ACCOUNT_IDENTITY_LIMIT)
      throw new ApplicationError(
        "GUEST_IMPORT_LIMIT",
        "This account has reached its guest identity import limit.",
        409,
      );
    await tx.client.query("UPDATE players SET account_id=$2 WHERE id=$1", [guestId, accountId]);
    await tx.client.query("UPDATE player_sessions SET token_hash=$2,display_name=$3 WHERE id=$1", [
      guestId,
      hash(token()),
      account.display_name,
    ]);
    await tx.client.query("DELETE FROM authentication_challenges WHERE payload->>'guestId'=$1", [
      guestId,
    ]);
    for (const { id } of games.rows) {
      const game = await tx.getGame(id);
      if (game) await this.history.archive(tx, game);
    }
  }
  async claim(actor: SessionRecord, guest: SessionRecord) {
    this.fresh(actor);
    if (guest.accountId) throw failure();
    return this.database.transaction(async (tx) => {
      await this.authorizeMutation(tx, actor);
      const proof = await tx.client.query(
        `SELECT 1 FROM account_sessions WHERE id=$1 AND account_id=$2 AND token_hash=$3
        AND claim_guest_id=$4 AND claim_guest_hash=$5 AND verified_at>clock_timestamp()-interval '5 minutes'
        AND expires_at>clock_timestamp() AND NOT recovery_only FOR UPDATE`,
        [actor.accountSessionId, actor.accountId, actor.tokenHash, guest.id, guest.tokenHash],
      );
      if (!proof.rowCount)
        throw new ApplicationError(
          "REAUTH_REQUIRED",
          "Verify your passkey with this guest session before importing.",
          403,
        );
      await this.claimInTransaction(tx, this.requireAccount(actor), guest.id, guest.tokenHash);
      await tx.client.query("DELETE FROM account_sessions WHERE id=$1", [actor.accountSessionId]);
      return { token: await this.session(tx, this.requireAccount(actor)) };
    });
  }
  async credentialList(actor: SessionRecord) {
    return this.database.transaction(async (tx) =>
      (await this.credentials(tx, this.requireAccount(actor))).map((c) => ({
        id: c.id,
        label: c.label,
        createdAt: c.created_at.getTime(),
        lastUsedAt: c.last_used_at?.getTime() ?? null,
      })),
    );
  }
  async removeCredential(actor: SessionRecord, id: string) {
    this.fresh(actor);
    await this.database.transaction(async (tx) => {
      await this.authorizeMutation(tx, actor);
      await tx.client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [
        this.requireAccount(actor),
      ]);
      if ((await this.credentials(tx, this.requireAccount(actor))).length <= 1)
        throw new ApplicationError(
          "LAST_PASSKEY",
          "Add another passkey before removing the last one.",
          409,
        );
      const removed = await tx.client.query(
        "DELETE FROM account_credentials WHERE id=$1 AND account_id=$2",
        [id, actor.accountId],
      );
      if (!removed.rowCount) throw failure();
      await tx.client.query("DELETE FROM account_sessions WHERE account_id=$1 AND id<>$2", [
        actor.accountId,
        actor.accountSessionId,
      ]);
      await tx.client.query("DELETE FROM authentication_challenges WHERE account_id=$1", [
        actor.accountId,
      ]);
    });
  }
  async replaceCodes(actor: SessionRecord) {
    this.fresh(actor);
    return this.database.transaction(async (tx) => {
      await this.authorizeMutation(tx, actor);
      await tx.client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [actor.accountId]);
      await tx.client.query("DELETE FROM account_sessions WHERE account_id=$1 AND recovery_only", [
        actor.accountId,
      ]);
      await tx.client.query(
        "DELETE FROM authentication_challenges WHERE account_id=$1 AND purpose='recover'",
        [actor.accountId],
      );
      return this.codes(tx, this.requireAccount(actor));
    });
  }
  async delete(
    actor: SessionRecord,
    finishGames: (tx: Transaction, accountId: string) => Promise<void>,
  ) {
    this.fresh(actor);
    await this.database.transaction(async (tx) => {
      await this.authorizeMutation(tx, actor);
      const owner = this.requireAccount(actor);
      await finishGames(tx, owner);
      const participants = (
        await tx.client.query<{ id: string }>(
          "SELECT id FROM players WHERE account_id=$1 ORDER BY id FOR UPDATE",
          [owner],
        )
      ).rows;
      const ids = participants.map((p) => p.id);
      for (const id of ids)
        await tx.client.query(
          "UPDATE player_sessions SET display_name='Deleted player',token_hash=$2,expires_at=clock_timestamp() WHERE id=$1",
          [id, hash(token())],
        );
      for (const p of participants)
        for (const color of ["white", "black"]) {
          await tx.client.query(
            `UPDATE match_archives SET players=jsonb_set(players,ARRAY[$2,'displayName'],to_jsonb('Deleted player'::text)) WHERE players->$2->>'id'=$1`,
            [p.id, color],
          );
        }
      await tx.client.query(
        `DELETE FROM command_receipts WHERE match_id IN(SELECT s.match_id FROM match_seats s WHERE s.session_id=ANY($1::uuid[]))`,
        [ids],
      );
      await tx.client.query("DELETE FROM accounts WHERE id=$1", [owner]);
    });
  }
  async cleanup() {
    await this.database.transaction(async (tx) => {
      await tx.client.query(
        "DELETE FROM account_sessions WHERE expires_at<clock_timestamp() OR last_used_at<clock_timestamp()-interval '7 days'",
      );
      await tx.client.query(
        "DELETE FROM authentication_challenges WHERE expires_at<clock_timestamp()",
      );
      await this.history.cleanup(tx);
    });
  }
  async cancel(binding: string, id: string) {
    await this.database.pool.query(
      "DELETE FROM authentication_challenges WHERE id=$1 AND binding_hash=$2",
      [id, hash(binding)],
    );
  }
}
